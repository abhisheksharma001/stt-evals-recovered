// W-10 (PRD v8 Part E.3): the MCP server. A client of the API over the plain
// SDK (@workspace/api-client), never part of it (docs/integration-strategy.md).
// Six read tools and one write, `watch_run_now`, which goes through the W-9
// route: the same claim, cost gate and ledger the scheduler uses. Holds no
// key; the API server holds the Vapi and provider keys.
//
// Every result is the endpoint's JSON as text. Two tools carry caller words:
// `get_words_to_watch` (single words) and `get_call_disagreement` (the
// disagreeing spans with their short context). The latter drops the
// endpoint's `referenceWords` / `referenceWordStartMs`, which are the whole
// call, word by word. Nothing else returns transcript text.
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import {
  ApiError,
  getBulkVerdicts,
  getWatchOverview,
  getWordsToWatch,
  listDisagreementSpans,
  listVapiAccounts,
  listVapiAssistants,
  runWatchScheduleNow,
  setActorLabel,
} from "@workspace/api-client";
import { z } from "zod";

export const ACTOR_LABEL = "stt-evals-mcp";
export const TOOL_NAMES = [
  "list_orgs",
  "list_agents",
  "get_verdict",
  "get_moved",
  "get_words_to_watch",
  "get_call_disagreement",
  "watch_run_now",
] as const;

const READ = { readOnlyHint: true, openWorldHint: false };
const WRITE = { readOnlyHint: false, destructiveHint: false, openWorldHint: false };

/** One API call -> one text result. An ApiError becomes an error result
 *  carrying the server's own sentence, so the model sees "Watch schedule is
 *  disabled..." rather than "HTTP 409". */
async function run(call: () => Promise<unknown>): Promise<CallToolResult> {
  try {
    const data = await call();
    return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
  } catch (err: unknown) {
    let text: string;
    if (err instanceof ApiError) {
      const body = err.data as { error?: string } | null;
      text = body?.error ?? err.message;
    } else {
      text = err instanceof Error ? err.message : String(err);
    }
    return { isError: true, content: [{ type: "text", text }] };
  }
}

export function createServer(): McpServer {
  setActorLabel(ACTOR_LABEL);
  const server = new McpServer({ name: "stt-evals", version: "0.0.0" });

  server.registerTool(
    "list_orgs",
    {
      description:
        "The configured Vapi accounts (an org is an account): id, label and the name of the env var that holds its key. The key itself is never returned.",
      annotations: READ,
    },
    () =>
      run(async () => {
        const accounts = await listVapiAccounts();
        return accounts.map((a) => ({ id: a.id, label: a.label, envVar: a.envVar }));
      }),
  );

  server.registerTool(
    "list_agents",
    {
      description: "One org's assistants (agents), read live from Vapi. Read-only.",
      inputSchema: { org: z.string().describe("Account id from list_orgs") },
      annotations: READ,
    },
    ({ org }) =>
      run(async () => {
        const agents = await listVapiAssistants({ accountId: org });
        return agents.map((a) => ({ id: a.id, name: a.name, account: a.accountLabel }));
      }),
  );

  server.registerTool(
    "get_verdict",
    {
      description:
        "The verdict for one finished bulk: per client, which candidate STT provider to pick and how sure, next to what production runs today. Numbers only, no transcript text.",
      inputSchema: {
        bulkId: z.string(),
        assistantId: z.string().optional().describe("Scope to one assistant"),
      },
      annotations: READ,
    },
    ({ bulkId, assistantId }) =>
      run(() => getBulkVerdicts(bulkId, assistantId ? { assistantId } : undefined)),
  );

  server.registerTool(
    "get_moved",
    {
      description:
        "Every watched agent whose production STT disagreement moved outside its own 30-day band. Empty when nothing moved. Numbers only.",
      annotations: READ,
    },
    () =>
      run(async () => {
        const overview = await getWatchOverview();
        const moved = overview.accounts.flatMap((account) =>
          account.agents
            .filter((agent) => agent.baseline.state === "moved")
            .map((agent) => ({
              account: account.accountLabel ?? account.accountId,
              assistantId: agent.assistantId,
              scheduleId: agent.scheduleId,
              priorDays: agent.baseline.priorDays,
              low: agent.baseline.low,
              high: agent.baseline.high,
              today: agent.days.at(-1)?.rate ?? null,
            })),
        );
        return { windowStart: overview.windowStart, today: overview.today, moved };
      }),
  );

  server.registerTool(
    "get_words_to_watch",
    {
      description:
        "Words that keep splitting the STT providers, grouped by the plurality reading, most calls first. Says where providers split, never which reading is right. Returns single words from calls.",
      inputSchema: {
        bulkId: z.string().optional().describe("One bulk; omit for all-time"),
        assistantId: z.string().optional().describe("Scope to one assistant"),
      },
      annotations: READ,
    },
    ({ bulkId, assistantId }) =>
      run(() =>
        getWordsToWatch({
          ...(bulkId ? { bulkId } : {}),
          ...(assistantId ? { assistantId } : {}),
        }),
      ),
  );

  server.registerTool(
    "get_call_disagreement",
    {
      description:
        "Where the STT providers heard different words on one call: each disagreeing span with its time range, every provider's reading and a few words of context. The call's full transcript is not returned.",
      inputSchema: { callId: z.string() },
      annotations: READ,
    },
    ({ callId }) =>
      run(async () => {
        const { referenceWords: _words, referenceWordStartMs: _starts, ...rest } =
          await listDisagreementSpans({ callId });
        return rest;
      }),
  );

  server.registerTool(
    "watch_run_now",
    {
      description:
        "SPENDS MONEY when it launches. Runs one enabled watch schedule's day now, through the same claim, cost gate and ledger the scheduler uses, and returns the ledger row: outcome `launched` (a bulk was created and providers will be billed), `held:cost_gate`, `refused:*` (no bulk, nothing spent) or `failed`. One row per schedule per day: a second call the same day is refused.",
      inputSchema: { scheduleId: z.string() },
      annotations: WRITE,
    },
    ({ scheduleId }) => run(() => runWatchScheduleNow(scheduleId)),
  );

  return server;
}
