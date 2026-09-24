// W-10: the server driven in-process -- SDK Client over InMemoryTransport --
// against a throwaway http server that plays the API. The real fetch path
// (@workspace/api-client customFetch) runs; no database, no network beyond
// loopback, no spend. What the fake API returns is shaped like the spec but
// invented: no caller text here is real.
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { setBaseUrl } from "@workspace/api-client";
import { createServer as createHttpServer, type IncomingMessage, type Server } from "node:http";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ACTOR_LABEL, TOOL_NAMES, createServer } from "./server";

type Seen = { method: string; url: string; actor: string | undefined };
const seen: Seen[] = [];
let api: Server;
let client: Client;

const SCHEDULE = "11111111-1111-4111-8111-111111111111";
const DISABLED = "22222222-2222-4222-8222-222222222222";

function reply(req: IncomingMessage): { status: number; body: unknown } {
  const url = req.url ?? "";
  if (url === "/api/benchmark/vapi/accounts") {
    return {
      status: 200,
      body: [{ id: "acct-a", label: "Alpha", envVar: "VAPI_API_KEY_ALPHA", keyFingerprint: "ab12cd34" }],
    };
  }
  if (url.startsWith("/api/benchmark/vapi/assistants")) {
    return { status: 200, body: [{ id: "asst-1", name: "Front desk", accountId: "acct-a", accountLabel: "Alpha" }] };
  }
  if (url.startsWith("/api/benchmark/watch/overview")) {
    return {
      status: 200,
      body: {
        today: "2026-09-25",
        windowStart: "2026-08-27",
        accounts: [
          {
            accountId: "acct-a",
            accountLabel: "Alpha",
            agents: [
              {
                scheduleId: SCHEDULE,
                enabled: true,
                assistantId: "asst-1",
                production: { vendor: "deepgram", model: "flux-general-en" },
                baseline: { state: "moved", priorDays: 14, low: 0.04, high: 0.09 },
                monthEstimatedCents: 120,
                days: [{ day: "2026-09-25", rate: 0.17 }],
              },
              {
                scheduleId: DISABLED,
                enabled: true,
                assistantId: null,
                production: null,
                baseline: { state: "steady", priorDays: 14, low: 0.03, high: 0.06 },
                monthEstimatedCents: 0,
                days: [],
              },
            ],
          },
        ],
      },
    };
  }
  if (url.startsWith("/api/benchmark/disagreement-spans")) {
    return {
      status: 200,
      body: {
        callId: "call-1",
        runId: "run-1",
        referenceProviderId: "deepgram-nova-3",
        referenceWords: ["hello", "this", "is", "a", "made", "up", "reference", "transcript"],
        referenceWordStartMs: [0, 300, 600, 900, 1200, 1500, 1800, 2100],
        unavailableReason: null,
        spans: [
          {
            startMs: 1200,
            endMs: 1800,
            majorityText: "made up",
            contextBefore: "is a",
            contextAfter: "reference",
            referencePositions: [4, 5],
            readings: [],
          },
        ],
      },
    };
  }
  if (url.startsWith("/api/benchmark/words-to-watch")) {
    return {
      status: 200,
      body: { bulkId: null, bulksCovered: 2, assistantId: null, callsScanned: 10, callsWithSpans: 3, words: [] },
    };
  }
  if (url.startsWith("/api/benchmark/bulks/bulk-1/verdicts")) {
    return { status: 200, body: { bulkId: "bulk-1", providers: [], groups: [] } };
  }
  if (url === `/api/benchmark/watch-schedules/${SCHEDULE}/run-now`) {
    return {
      status: 200,
      body: { scheduleId: SCHEDULE, day: "2026-09-25", outcome: "refused:daily_cap", bulkId: null, detail: { estimatedCents: 900 } },
    };
  }
  if (url === `/api/benchmark/watch-schedules/${DISABLED}/run-now`) {
    return {
      status: 409,
      body: { error: "Watch schedule is disabled. Enable it first; run-now does not override the off switch." },
    };
  }
  return { status: 404, body: { error: `no fake for ${url}` } };
}

function text(result: Awaited<ReturnType<Client["callTool"]>>): string {
  const content = result.content as { type: string; text?: string }[];
  return content.map((c) => c.text ?? "").join("");
}

beforeAll(async () => {
  api = createHttpServer((req, res) => {
    seen.push({ method: req.method ?? "", url: req.url ?? "", actor: req.headers["x-actor"] as string | undefined });
    const { status, body } = reply(req);
    res.writeHead(status, { "content-type": "application/json" });
    res.end(JSON.stringify(body));
  });
  await new Promise<void>((resolve) => api.listen(0, "127.0.0.1", resolve));
  const addr = api.address();
  if (!addr || typeof addr === "string") throw new Error("no port");
  setBaseUrl(`http://127.0.0.1:${addr.port}`);

  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await createServer().connect(serverTransport);
  client = new Client({ name: "test", version: "0" });
  await client.connect(clientTransport);
});

afterAll(async () => {
  await client.close();
  await new Promise<void>((resolve, reject) => api.close((err) => (err ? reject(err) : resolve())));
});

describe("W-10 mcp-server", () => {
  it("lists exactly the seven tools, six read-only and one not", async () => {
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name).sort()).toEqual([...TOOL_NAMES].sort());
    const readOnly = tools.filter((t) => t.annotations?.readOnlyHint === true).map((t) => t.name);
    expect(readOnly).toHaveLength(6);
    expect(readOnly).not.toContain("watch_run_now");
    expect(tools.find((t) => t.name === "watch_run_now")?.description).toMatch(/SPENDS MONEY/);
  });

  it("list_orgs names the env var, never the key or its fingerprint", async () => {
    const result = await client.callTool({ name: "list_orgs", arguments: {} });
    expect(result.isError).toBeFalsy();
    const out = text(result);
    expect(JSON.parse(out)).toEqual([{ id: "acct-a", label: "Alpha", envVar: "VAPI_API_KEY_ALPHA" }]);
    expect(out).not.toContain("ab12cd34");
    expect(seen.at(-1)).toMatchObject({ method: "GET", url: "/api/benchmark/vapi/accounts", actor: ACTOR_LABEL });
  });

  it("list_agents passes the org as accountId", async () => {
    const result = await client.callTool({ name: "list_agents", arguments: { org: "acct-a" } });
    expect(JSON.parse(text(result))).toEqual([{ id: "asst-1", name: "Front desk", account: "Alpha" }]);
    expect(seen.at(-1)?.url).toBe("/api/benchmark/vapi/assistants?accountId=acct-a");
  });

  it("get_verdict scopes to an assistant when asked", async () => {
    await client.callTool({ name: "get_verdict", arguments: { bulkId: "bulk-1" } });
    expect(seen.at(-1)?.url).toBe("/api/benchmark/bulks/bulk-1/verdicts");
    await client.callTool({ name: "get_verdict", arguments: { bulkId: "bulk-1", assistantId: "asst-1" } });
    expect(seen.at(-1)?.url).toBe("/api/benchmark/bulks/bulk-1/verdicts?assistantId=asst-1");
  });

  it("get_moved returns only the agents whose baseline says moved", async () => {
    const out = JSON.parse(text(await client.callTool({ name: "get_moved", arguments: {} })));
    expect(out).toEqual({
      windowStart: "2026-08-27",
      today: "2026-09-25",
      moved: [
        { account: "Alpha", assistantId: "asst-1", scheduleId: SCHEDULE, priorDays: 14, low: 0.04, high: 0.09, today: 0.17 },
      ],
    });
  });

  it("get_words_to_watch forwards bulk and assistant filters", async () => {
    await client.callTool({ name: "get_words_to_watch", arguments: {} });
    expect(seen.at(-1)?.url).toBe("/api/benchmark/words-to-watch");
    await client.callTool({ name: "get_words_to_watch", arguments: { bulkId: "bulk-1", assistantId: "asst-1" } });
    expect(seen.at(-1)?.url).toBe("/api/benchmark/words-to-watch?bulkId=bulk-1&assistantId=asst-1");
  });

  it("get_call_disagreement returns the spans and drops the whole-call reference words", async () => {
    const result = await client.callTool({ name: "get_call_disagreement", arguments: { callId: "call-1" } });
    const out = JSON.parse(text(result));
    expect(out.spans).toHaveLength(1);
    expect(out.spans[0].contextBefore).toBe("is a");
    expect(out).not.toHaveProperty("referenceWords");
    expect(out).not.toHaveProperty("referenceWordStartMs");
    expect(text(result)).not.toContain("transcript");
    expect(seen.at(-1)?.url).toBe("/api/benchmark/disagreement-spans?callId=call-1");
  });

  it("watch_run_now returns the ledger row verbatim when the cap refuses", async () => {
    const result = await client.callTool({ name: "watch_run_now", arguments: { scheduleId: SCHEDULE } });
    expect(result.isError).toBeFalsy();
    expect(JSON.parse(text(result))).toEqual({
      scheduleId: SCHEDULE,
      day: "2026-09-25",
      outcome: "refused:daily_cap",
      bulkId: null,
      detail: { estimatedCents: 900 },
    });
    expect(seen.at(-1)).toMatchObject({ method: "POST", actor: ACTOR_LABEL });
    // The only call that went out was the run-now itself; nothing created a bulk.
    expect(seen.filter((s) => s.url.includes("/bulks") && s.method === "POST")).toHaveLength(0);
  });

  it("watch_run_now on a refused status surfaces the server's own sentence as a tool error", async () => {
    const result = await client.callTool({ name: "watch_run_now", arguments: { scheduleId: DISABLED } });
    expect(result.isError).toBe(true);
    expect(text(result)).toBe("Watch schedule is disabled. Enable it first; run-now does not override the off switch.");
  });
});
