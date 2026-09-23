// W-9 (PRD v8 Part E.2): the CLI. One entry point over the plain SDK
// (@workspace/api-client); every subcommand is one API call and some
// printing. It holds no key -- the API server holds the Vapi and provider
// keys, and this process reads exactly one env var, API_BASE_URL.
//
//   API_BASE_URL=http://localhost:8177 pnpm --filter @workspace/scripts cli <command>
//
//   orgs                         configured Vapi accounts (an "org" is an account)
//   agents <org>                 that account's assistants, read live from Vapi
//   watch list                   every watch schedule
//   watch create --template=<id> --account=<id> --vertical=<v> [--assistant=<id>]
//                [--sample=N] [--daily-cap=<cents>] [--monthly-cap=<cents>]
//                [--hour=H] [--enabled]
//   watch run-now <scheduleId>   run one schedule's day now, through the same
//                                claim, cost gate and ledger the scheduler uses;
//                                prints the ledger row verbatim; exits 0 only on
//                                `launched`
//   verdict <bulkId> [--assistant=<id>]
//   moved                        every watched agent whose baseline says `moved`
//   import ...                   the Vapi importer (see import-vapi-calls.ts)
//
// API_BASE_URL: the SDK's generated paths already start with /api, so the
// value is the server's origin. A trailing /api (the importer's old documented
// value) is stripped so that value keeps working.
import {
  ApiError,
  createWatchSchedule,
  getBulkVerdicts,
  getWatchOverview,
  listVapiAccounts,
  listVapiAssistants,
  listWatchSchedules,
  runWatchScheduleNow,
  setActorLabel,
  setBaseUrl,
  type Vertical,
} from "@workspace/api-client";
import { runImport } from "./import-vapi-calls";

const USAGE = `usage: stt-evals <command>

  orgs
  agents <org>
  watch list
  watch create --template=<id> --account=<id> --vertical=rush|property_management|trucking
               [--assistant=<id>] [--sample=N] [--daily-cap=<cents>] [--monthly-cap=<cents>]
               [--hour=H] [--enabled]
  watch run-now <scheduleId>
  verdict <bulkId> [--assistant=<id>]
  moved
  import --vertical=... [--account=...] [--limit=N] [--start=YYYY-MM-DD] [--end=YYYY-MM-DD] [--assistant-id=...] [--apply]

env: API_BASE_URL (default http://localhost:8177; a trailing /api is stripped)`;

const VERTICALS: readonly Vertical[] = ["rush", "property_management", "trucking"];

/** `--flag=value` lookups over one argv slice. */
function flags(argv: string[]) {
  const get = (name: string): string | undefined => {
    const hit = argv.find((a) => a.startsWith(`--${name}=`));
    return hit?.slice(name.length + 3);
  };
  const num = (name: string): number | undefined => {
    const raw = get(name);
    if (raw === undefined) return undefined;
    const n = Number(raw);
    if (!Number.isFinite(n)) throw new Error(`--${name} must be a number, got "${raw}"`);
    return n;
  };
  const has = (name: string): boolean => argv.includes(`--${name}`);
  return { get, num, has };
}

function need(value: string | undefined, what: string): string {
  if (!value) throw new Error(`${what} is required\n\n${USAGE}`);
  return value;
}

function table(rows: Record<string, unknown>[]): void {
  if (rows.length === 0) {
    console.log("(none)");
    return;
  }
  const keys = Object.keys(rows[0]);
  const width = keys.map((k) => Math.max(k.length, ...rows.map((r) => String(r[k] ?? "").length)));
  const line = (cells: unknown[]) => cells.map((c, i) => String(c ?? "").padEnd(width[i])).join("  ");
  console.log(line(keys));
  for (const r of rows) console.log(line(keys.map((k) => r[k])));
}

async function main(argv: string[]): Promise<number> {
  const [command, ...rest] = argv;
  switch (command) {
    case "orgs": {
      const accounts = await listVapiAccounts();
      table(accounts.map((a) => ({ id: a.id, label: a.label, envVar: a.envVar })));
      return 0;
    }
    case "agents": {
      const accountId = need(rest[0], "<org>");
      const agents = await listVapiAssistants({ accountId });
      table(agents.map((a) => ({ id: a.id, name: a.name, account: a.accountLabel })));
      return 0;
    }
    case "watch": {
      const [sub, ...args] = rest;
      if (sub === "list") {
        const rows = await listWatchSchedules();
        table(
          rows.map((s) => ({
            id: s.id,
            enabled: s.enabled,
            account: s.accountId,
            assistant: s.assistantId ?? "(every agent)",
            vertical: s.vertical,
            sample: s.sampleSize,
            dailyCapCents: s.dailyCapCents,
            monthlyCapCents: s.monthlyCapCents,
            hour: s.hourLocal,
          })),
        );
        return 0;
      }
      if (sub === "create") {
        const f = flags(args);
        const vertical = need(f.get("vertical"), "--vertical");
        if (!VERTICALS.includes(vertical as Vertical)) {
          throw new Error(`--vertical must be one of ${VERTICALS.join("|")}, got "${vertical}"`);
        }
        const created = await createWatchSchedule({
          templateId: need(f.get("template"), "--template"),
          accountId: need(f.get("account"), "--account"),
          vertical: vertical as Vertical,
          assistantId: f.get("assistant") ?? null,
          sampleSize: f.num("sample"),
          dailyCapCents: f.num("daily-cap"),
          monthlyCapCents: f.num("monthly-cap"),
          hourLocal: f.num("hour"),
          enabled: f.has("enabled"),
        });
        console.log(JSON.stringify(created, null, 2));
        return 0;
      }
      if (sub === "run-now") {
        const scheduleId = need(args[0], "<scheduleId>");
        // The ledger row, verbatim. Anything but `launched` -- every
        // `refused:*`, `held:cost_gate`, `failed` -- is a non-zero exit, so a
        // shell or a cron line can tell "spent" from "did not".
        const result = await runWatchScheduleNow(scheduleId);
        console.log(JSON.stringify(result, null, 2));
        return result.outcome === "launched" ? 0 : 1;
      }
      throw new Error(`unknown watch command "${sub ?? ""}"\n\n${USAGE}`);
    }
    case "verdict": {
      const bulkId = need(rest[0], "<bulkId>");
      const f = flags(rest.slice(1));
      const assistantId = f.get("assistant");
      const verdicts = await getBulkVerdicts(bulkId, assistantId ? { assistantId } : undefined);
      console.log(JSON.stringify(verdicts, null, 2));
      return 0;
    }
    case "moved": {
      const overview = await getWatchOverview();
      const moved = overview.accounts.flatMap((account) =>
        account.agents
          .filter((agent) => agent.baseline.state === "moved")
          .map((agent) => ({
            account: account.accountLabel ?? account.accountId,
            assistant: agent.assistantId ?? "(every agent)",
            scheduleId: agent.scheduleId,
            priorDays: agent.baseline.priorDays,
            band: `${agent.baseline.low}..${agent.baseline.high}`,
            today: agent.days.at(-1)?.rate ?? "(no rate)",
          })),
      );
      console.log(`${overview.windowStart} .. ${overview.today}`);
      table(moved);
      return 0;
    }
    case "import":
      await runImport(rest);
      return 0;
    case undefined:
    case "help":
    case "--help":
      console.log(USAGE);
      return 0;
    default:
      throw new Error(`unknown command "${command}"\n\n${USAGE}`);
  }
}

const base = (process.env.API_BASE_URL ?? "http://localhost:8177").replace(/\/api\/?$/, "");
setBaseUrl(base);
setActorLabel("stt-evals-cli");

main(process.argv.slice(2))
  .then((code) => {
    process.exitCode = code;
  })
  .catch((err: unknown) => {
    if (err instanceof ApiError) {
      // The server's own sentence, when it gave one, over the status line.
      const body = err.data as { error?: string } | null;
      console.error(body?.error ?? err.message);
    } else {
      console.error(err instanceof Error ? err.message : String(err));
    }
    process.exitCode = 1;
  });
