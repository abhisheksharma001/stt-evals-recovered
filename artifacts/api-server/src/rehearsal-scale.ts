/**
 * Scale rehearsal: proves the run executor can drain a 500-1000+ cell
 * benchmark concurrently, without spending a single cent on any provider.
 *
 * What it does (all against DATABASE_URL, offline from every vendor):
 *   1. Seeds N synthetic calls and M synthetic providers ("rehearsal-*").
 *   2. Registers deterministic stub adapters into the real provider
 *      registry -- same transcribe contract, simulated latency, and an
 *      injected HTTP 429 on each cell's FIRST attempt so the retry/backoff
 *      path is exercised, not just the happy path.
 *   3. Executes the run TWICE concurrently to prove the Postgres advisory
 *      lock makes the second invocation a no-op (no duplicate cells).
 *   4. Asserts result/score/ranking invariants and per-provider concurrency
 *      caps, then prints a timing summary.
 *
 * Usage:
 *   DATABASE_URL=postgres://... pnpm --filter @workspace/api-server scale:rehearsal \
 *     [--calls 150] [--providers 7] [--run-concurrency 32] \
 *     [--provider-concurrency 8] [--latency-ms 25]
 *
 * Defaults reproduce the "500-1000 calls at once" target shape: 150 calls x
 * 7 providers = 1050 cells.
 */
import { randomUUID } from "node:crypto";
import { eq, like, inArray } from "drizzle-orm";

// Executor knobs are read at module load -- set them BEFORE the dynamic
// import below so this script controls the pool sizes for its own run.
const args = process.argv.slice(2);
function argValue(flag: string, fallback: number): number {
  const i = args.indexOf(flag);
  return i >= 0 && args[i + 1] ? Number.parseInt(args[i + 1], 10) || fallback : fallback;
}
const CALLS = argValue("--calls", 150);
const PROVIDERS = argValue("--providers", 7);
const LATENCY_MS = argValue("--latency-ms", 25);
// --keep skips cleanup so a UI session can browse the seeded run afterwards.
const KEEP = args.includes("--keep");
process.env.RUN_CONCURRENCY = String(argValue("--run-concurrency", 32));
process.env.PROVIDER_CONCURRENCY = String(argValue("--provider-concurrency", 8));

const { db, pool, benchmarkCallsTable, benchmarkProvidersTable, benchmarkProviderCallResultsTable, benchmarkRankingsTable, benchmarkRunsTable, benchmarkScoresTable } = await import("@workspace/db");
const { executeBenchmarkRun } = await import("./lib/run-executor");
const { providerRegistry } = await import("@workspace/stt-providers");

if (!process.env.DATABASE_URL) {
  console.error("DATABASE_URL is required.");
  process.exit(1);
}

const PREFIX = `rehearsal-${Date.now()}`;
const VERTICALS = ["rush", "property_management", "trucking"] as const;

// --- Stub adapters ---------------------------------------------------------

type CellKey = string;
const attemptCounts = new Map<CellKey, number>();
const inFlight = new Map<string, number>();
const maxInFlight = new Map<string, number>();
let totalTranscribeCalls = 0;

for (let p = 0; p < PROVIDERS; p++) {
  const providerId = `${PREFIX}-p${p}`;
  const name = `Rehearsal Provider ${p}`;

  maxInFlight.set(providerId, 0);

  providerRegistry[providerId] = {
    providerId,
    apiKeyEnvVar: "REHEARSAL_UNUSED_KEY",
    async transcribe({ callId }) {
      const key: CellKey = `${providerId}::${callId}`;
      totalTranscribeCalls += 1;
      const attempt = (attemptCounts.get(key) ?? 0) + 1;
      attemptCounts.set(key, attempt);

      // Track peak concurrent load per provider (single-threaded JS: the
      // increment/decrement pairs below are atomic enough).
      const now = (inFlight.get(providerId) ?? 0) + 1;
      inFlight.set(providerId, now);
      if (now > (maxInFlight.get(providerId) ?? 0)) maxInFlight.set(providerId, now);

      try {
        await new Promise((r) => setTimeout(r, LATENCY_MS + Math.random() * LATENCY_MS));
        if (attempt === 1) {
          return {
            status: "failed" as const,
            submittedAt: new Date().toISOString(),
            finalAt: new Date().toISOString(),
            httpStatus: 429,
            hypothesisTranscript: null,
            rawOutput: null,
            errorMessage: "rate limited (simulated)",
            diarizationScore: null,
          };
        }
        const words = goldWordsFor(callId).join(" ");
        return {
          status: "ok" as const,
          submittedAt: new Date().toISOString(),
          finalAt: new Date(Date.now() + LATENCY_MS).toISOString(),
          httpStatus: 200,
          hypothesisTranscript: words,
          rawOutput: { rehearsal: true },
          errorMessage: null,
          diarizationScore: 0.9,
        };
      } finally {
        inFlight.set(providerId, (inFlight.get(providerId) ?? 1) - 1);
      }
    },
  };
}

// Deterministic gold text per call id.
const goldByCall = new Map<string, string[]>();
function goldWordsFor(callId: string): string[] {
  return goldByCall.get(callId) ?? ["missing"];
}

// --- Seed ------------------------------------------------------------------

const providerIds: string[] = [];
for (let p = 0; p < PROVIDERS; p++) {
  const id = `${PREFIX}-p${p}`;
  providerIds.push(id);
  await db
    .insert(benchmarkProvidersTable)
    .values({
      id,
      name: `Rehearsal Provider ${p}`,
      model: "rehearsal-stub",
      status: "ready",
      supportsDiarization: true,
      costPerMinute: 0.01 * (p + 1),
    })
    .onConflictDoUpdate({
      target: benchmarkProvidersTable.id,
      set: { name: `Rehearsal Provider ${p}`, model: "rehearsal-stub" },
    });
}

const callRows: Array<{ id: string; vertical: string }> = [];
for (let c = 0; c < CALLS; c++) {
  const id = randomUUID();
  const vertical = VERTICALS[c % VERTICALS.length];
  const gold =
    "Repair order four seven two one needs transmission diagnosis at the rivergate store";
  goldByCall.set(id, gold.split(" "));
  callRows.push({ id, vertical });
  await db.insert(benchmarkCallsTable).values({
    id,
    label: `${PREFIX}-call-${c}`,
    vertical,
    durationSeconds: 60 + (c % 30),
    status: "ready_to_run",
    goldTranscript: gold,
    entityReferences: [{ type: "ro_number", value: "4721" }],
    audioObjectPath: "rehearsal://audio.wav",
  });
}

const [run] = await db
  .insert(benchmarkRunsTable)
  .values({
    status: "queued",
    providerIds,
    callIds: callRows.map((c) => c.id),
    callCount: CALLS,
    purpose: "batch",
    notes: null,
  })
  .returning();

// --- Execute (twice, concurrently -- lock must make #2 a no-op) ------------

console.log(
  `[rehearsal] ${CALLS} calls x ${PROVIDERS} providers = ${CALLS * PROVIDERS} cells | RUN_CONCURRENCY=${process.env.RUN_CONCURRENCY} PROVIDER_CONCURRENCY=${process.env.PROVIDER_CONCURRENCY}`,
);

const startedAt = Date.now();
await Promise.all([
  executeBenchmarkRun(run.id, "rehearsal-primary", {
    audioResolver: async () => Buffer.alloc(0),
  }),
  executeBenchmarkRun(run.id, "rehearsal-racer", {
    audioResolver: async () => Buffer.alloc(0),
  }),
]);
const wallMs = Date.now() - startedAt;

// --- Assertions ------------------------------------------------------------

let failures = 0;
function assert(condition: boolean, label: string): void {
  if (condition) {
    console.log(`  ok   ${label}`);
  } else {
    failures += 1;
    console.error(`  FAIL ${label}`);
  }
}

const results = await db
  .select()
  .from(benchmarkProviderCallResultsTable)
  .where(eq(benchmarkProviderCallResultsTable.runId, run.id));

assert(results.length === CALLS * PROVIDERS, `exactly one row per cell (${results.length}/${CALLS * PROVIDERS})`);
const okRows = results.filter((r) => r.status === "ok");
assert(okRows.length === results.length, `every cell eventually ok after retry (${okRows.length})`);

const scores = await db.select().from(benchmarkScoresTable);
const scoreResultIds = new Set(results.map((r) => r.id));
assert(
  scores.filter((s) => scoreResultIds.has(s.resultId)).length === results.length,
  "one score per successful cell",
);

const rankings = await db.select().from(benchmarkRankingsTable).where(eq(benchmarkRankingsTable.runId, run.id));
assert(rankings.length === VERTICALS.length * PROVIDERS, `rankings cover all verticals x providers (${rankings.length})`);
for (const v of VERTICALS) {
  const ranks = rankings.filter((r) => r.vertical === v).map((r) => r.rank).sort((a, b) => a - b);
  assert(ranks.join(",") === ranks.map((_, i) => i + 1).join(","), `contiguous ranks for ${v}`);
}

const providerCap = Number(process.env.PROVIDER_CONCURRENCY);
for (const [providerId, peak] of maxInFlight) {
  assert(peak <= providerCap, `per-provider cap respected for ${providerId} (peak ${peak} <= ${providerCap})`);
}
assert(totalTranscribeCalls > CALLS * PROVIDERS, `retry path exercised (${totalTranscribeCalls} adapter calls for ${results.length} cells)`);

const serialEstimateMs = results.length * LATENCY_MS * 2; // every cell pays the simulated 429 + success latency
console.log("");
console.log("[rehearsal] timing");
console.log(`  wall time .......... ${wallMs} ms`);
console.log(`  cells .............. ${results.length}`);
console.log(`  throughput ......... ${Math.round((results.length / wallMs) * 1000)} cells/s`);
console.log(`  serial estimate .... ~${serialEstimateMs} ms (same latencies, 1 at a time)`);

// --- Cleanup (leave audit_log rows behind on purpose: append-only evidence) -

if (KEEP) {
  console.log("\n[rehearsal] --keep set: seeded data left in place for browsing.");
  console.log(`[rehearsal] providers: ${providerIds.length} | calls: ${callRows.length} | run: ${run.id}`);
  await pool.end();
  process.exit(failures === 0 ? 0 : 1);
}

await db.delete(benchmarkRunsTable).where(eq(benchmarkRunsTable.id, run.id)); // cascades results+scores
await db.delete(benchmarkRankingsTable).where(eq(benchmarkRankingsTable.runId, run.id));
await db.delete(benchmarkCallsTable).where(like(benchmarkCallsTable.label, `${PREFIX}-%`));
await db.delete(benchmarkProvidersTable).where(inArray(benchmarkProvidersTable.id, providerIds));
for (const id of providerIds) delete providerRegistry[id];

await pool.end();
console.log(failures === 0 ? "\n[rehearsal] PASS" : `\n[rehearsal] ${failures} assertion(s) FAILED`);
process.exit(failures === 0 ? 0 : 1);
