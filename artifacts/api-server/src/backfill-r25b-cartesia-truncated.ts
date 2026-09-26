/**
 * One-off data backfill for register row R-25b (2026-09-26).
 *
 * R-25a made the Cartesia reducer fail a stream that never received the
 * `flush_done` ack to "finalize": without it the socket closed before the last
 * segments arrived, and the text in hand is a truncated transcript. Cells
 * written before that fix were scored `ok` anyway. On the dev database that is
 * 16 cells, all written 2026-08-24 15:10-15:34 UTC, in two standalone runs.
 *
 * Abhishek's decision (2026-09-26): mark them failed, do NOT re-run. So each
 * cell gets exactly what R-25a would have written -- `failed`, class
 * `unknown` (retryable), the reducer's own error message, no transcript -- and
 * its score row is deleted, the way a failed cell has none. The cells are
 * selected by running the stored events back through that same reducer, not
 * by an id list, so nothing R-25a would pass can be picked up.
 *
 * Unlike M-1 and R-17, the scores are not left as history: a score row on a
 * failed cell is a shape nothing else in the database has, and every read path
 * would still count it. The audit row keeps the cell's old fields and its
 * deleted score rows, so the change can be put back by hand.
 *
 * Then, for each affected run, the same free passes a finishing run makes:
 * computeHybridFlagsForRun (peer flags of the OTHER providers were computed
 * against the truncated text) and the run's ranking rows. No provider or LLM
 * is called and nothing is spent.
 *
 * Idempotent: a second run finds nothing to fail and writes nothing.
 * PII: prints ids and counts only -- never a transcript or raw output.
 *
 *   pnpm --filter @workspace/api-server exec tsx --env-file-if-exists=.env ./src/backfill-r25b-cartesia-truncated.ts [--apply]
 */
import { and, eq, inArray, like } from "drizzle-orm";
import { reduceCartesiaTranscript, type CartesiaMessage } from "@workspace/stt-providers";

const APPLY = process.argv.includes("--apply");
const { db, pool, benchmarkProviderCallResultsTable, benchmarkRunsTable, benchmarkScoresTable } = await import(
  "@workspace/db"
);
const { writeAudit } = await import("./lib/audit");
const { computeHybridFlagsForRun } = await import("./lib/hybrid-flagging");
const { computeRankingsForBulk, computeRankingsForRun } = await import("./lib/run-executor");

// Same reason recompute-rankings.ts prints it: the connection cannot be read
// off the command line.
const [{ current_database: database }] = (
  await pool.query<{ current_database: string }>("select current_database()")
).rows as [{ current_database: string }];
console.log(`database: ${database}`);

const okCartesia = and(
  like(benchmarkProviderCallResultsTable.providerId, "cartesia%"),
  eq(benchmarkProviderCallResultsTable.status, "ok"),
);
const cells = await db
  .select({
    id: benchmarkProviderCallResultsTable.id,
    runId: benchmarkProviderCallResultsTable.runId,
    rawOutput: benchmarkProviderCallResultsTable.rawOutput,
  })
  .from(benchmarkProviderCallResultsTable)
  .where(okCartesia);

const targets: Array<{ id: string; runId: string; errorMessage: string }> = [];
let unreadable = 0;
for (const cell of cells) {
  let events: CartesiaMessage[];
  try {
    const raw = JSON.parse(cell.rawOutput ?? "null") as { events?: CartesiaMessage[] } | null;
    if (!raw || !Array.isArray(raw.events)) throw new Error("no events");
    events = raw.events;
  } catch {
    // A cell whose stream cannot be read is not evidence of truncation.
    unreadable += 1;
    continue;
  }
  const reduced = reduceCartesiaTranscript(
    events.map((message, i) => ({ message, receivedAtMs: i })),
    0,
  );
  if (reduced.errorMessage) targets.push({ id: cell.id, runId: cell.runId, errorMessage: reduced.errorMessage });
}

const runIds = [...new Set(targets.map((t) => t.runId))];
console.log(`R-25b: ${cells.length} ok Cartesia cells, ${unreadable} unreadable (left alone), ${targets.length} to fail`);
console.log(`runs affected: ${runIds.map((id) => id.slice(0, 8)).join(", ") || "none"}`);
if (!APPLY) {
  for (const t of targets) console.log(`  ${t.id.slice(0, 8)}  run ${t.runId.slice(0, 8)}`);
  console.log("dry run -- pass --apply to write");
  await pool.end();
  process.exit(0);
}

let failed = 0;
for (const t of targets) {
  const done = await db.transaction(async (tx) => {
    const [before] = await tx
      .select()
      .from(benchmarkProviderCallResultsTable)
      .where(and(eq(benchmarkProviderCallResultsTable.id, t.id), eq(benchmarkProviderCallResultsTable.status, "ok")));
    if (!before) return false;
    const scores = await tx.delete(benchmarkScoresTable).where(eq(benchmarkScoresTable.resultId, t.id)).returning();
    const after = {
      status: "failed",
      failureClass: "unknown",
      errorMessage: t.errorMessage,
      hypothesisTranscript: null,
    } as const;
    await tx.update(benchmarkProviderCallResultsTable).set(after).where(eq(benchmarkProviderCallResultsTable.id, t.id));
    await writeAudit({
      entityType: "result",
      entityId: t.id,
      actorLabel: "backfill-r25b-cartesia-truncated",
      action: "update",
      beforeState: {
        status: before.status,
        failureClass: before.failureClass,
        errorMessage: before.errorMessage,
        hypothesisTranscript: before.hypothesisTranscript,
        deletedScores: scores,
      },
      afterState: after,
    });
    return true;
  });
  if (done) failed += 1;
}
console.log(`failed ${failed} cells`);

if (failed > 0) {
  const runs = await db.select().from(benchmarkRunsTable).where(inArray(benchmarkRunsTable.id, runIds));
  for (const run of runs) {
    await computeHybridFlagsForRun(run.id);
    // A bulk's ranking rows belong to the bulk; computeRankingsForRun on one
    // of its shards would delete them (see recompute-rankings.ts).
    if (run.bulkId) await computeRankingsForBulk(run.bulkId);
    else await computeRankingsForRun(run.id, run.callIds, run.providerIds);
    console.log(`  run ${run.id.slice(0, 8)}: flags and rankings recomputed`);
  }
}
await pool.end();
