/**
 * O-84 (2026-09-09): rewrite the stored ranking rows for every finished bulk.
 *
 * Two things went stale in benchmark_rankings, and both are stored-at-write
 * columns that no read path recomputes:
 *
 *   - R-1 changed the disagreement rate's denominator (one reference length
 *     per call, shared by every provider on it, instead of each provider's
 *     own word count). Rows written before 2026-09-08 still carry the old
 *     basis, so a historical bulk's Results column can disagree with that
 *     bulk's trend-strip point, which recomputes on read.
 *   - R-4 rewrote the sentence in the `recommendation` column. All 29 rank-1
 *     rows still serve the retracted "Leading candidate ... Do not treat as
 *     decision-grade" copy the step replaced.
 *
 * Stored rows come from two writers, so both are recomputed here. Rows for a
 * bulk carry `bulkId` and are rewritten by computeRankingsForBulk; rows for a
 * standalone run (17 of them, from before bulks existed) carry a null
 * `bulkId` and are rewritten by computeRankingsForRun. Missing the second set
 * leaves 45 of the 305 stored rows stale, and one of them survives the
 * "latest per group" pick the Results page makes -- found by reading the page
 * back after the first, bulk-only pass.
 *
 * Both functions delete and rewrite from the stored cells. Neither calls a
 * provider or an LLM or spends anything; they are the same functions every
 * finishing run already calls, and both are idempotent by construction
 * (delete-then-insert, the bulk one under a per-bulk advisory lock).
 *
 * computeRankingsForRun deletes by run id, and a bulk's rows carry a
 * representative run id that belongs to the bulk -- so it is called ONLY for
 * runs whose own `bulkId` is null. Calling it for a bulk's representative run
 * would delete that bulk's freshly written rows.
 *
 * PII: prints bulk ids and row counts only -- no transcript, no caller field.
 *
 *   pnpm --filter @workspace/api-server exec tsx --env-file-if-exists=.env ./src/recompute-rankings.ts [--apply]
 *
 * Without --apply it only lists the bulks it would rewrite.
 */
import { and, eq, inArray, isNull, sql } from "drizzle-orm";
import { benchmarkBulksTable, benchmarkRankingsTable, benchmarkRunsTable, db, pool } from "@workspace/db";
import { computeRankingsForBulk, computeRankingsForRun } from "./lib/run-executor";

const APPLY = process.argv.includes("--apply");

// A script that rewrites rows says which database it is rewriting, the same
// way mine-triage-signals.ts prints it before counting: `.env not found` is a
// normal line here (tsx resolves it against the package dir), so the
// connection cannot be read off the command line.
const [{ current_database: database }] = (
  await pool.query<{ current_database: string }>("select current_database()")
).rows as [{ current_database: string }];
console.log(`database: ${database}`);

const bulks = await db
  .select({ id: benchmarkBulksTable.id, status: benchmarkBulksTable.status })
  .from(benchmarkBulksTable)
  .where(inArray(benchmarkBulksTable.status, ["complete", "partial", "failed"]));

const soloRuns = await db
  .select({
    id: benchmarkRunsTable.id,
    status: benchmarkRunsTable.status,
    callIds: benchmarkRunsTable.callIds,
    providerIds: benchmarkRunsTable.providerIds,
  })
  .from(benchmarkRunsTable)
  .where(
    and(
      isNull(benchmarkRunsTable.bulkId),
      inArray(benchmarkRunsTable.status, ["complete", "partial", "failed"]),
    ),
  );

const counts = await db
  .select({ bulkId: benchmarkRankingsTable.bulkId, rows: sql<number>`count(*)::int` })
  .from(benchmarkRankingsTable)
  .groupBy(benchmarkRankingsTable.bulkId);
const rowsByBulk = new Map(counts.map((c) => [c.bulkId, c.rows]));

const runCounts = await db
  .select({ runId: benchmarkRankingsTable.runId, rows: sql<number>`count(*)::int` })
  .from(benchmarkRankingsTable)
  .where(isNull(benchmarkRankingsTable.bulkId))
  .groupBy(benchmarkRankingsTable.runId);
const rowsByRun = new Map(runCounts.map((c) => [c.runId, c.rows]));

console.log(`${bulks.length} finished bulks`);
for (const b of bulks) console.log(`  ${b.id.slice(0, 8)}  ${b.status}  ${rowsByBulk.get(b.id) ?? 0} stored rows`);

console.log(`${soloRuns.length} finished standalone runs (no bulk)`);
for (const r of soloRuns) console.log(`  run ${r.id.slice(0, 8)}  ${r.status}  ${rowsByRun.get(r.id) ?? 0} stored rows`);

if (!APPLY) {
  console.log("dry run -- pass --apply to rewrite");
  await pool.end();
  process.exit(0);
}

for (const b of bulks) {
  await computeRankingsForBulk(b.id);
  const [after] = await db
    .select({ rows: sql<number>`count(*)::int` })
    .from(benchmarkRankingsTable)
    .where(eq(benchmarkRankingsTable.bulkId, b.id));
  console.log(`  ${b.id.slice(0, 8)}  rewrote ${after?.rows ?? 0} rows`);
}

for (const r of soloRuns) {
  await computeRankingsForRun(r.id, r.callIds, r.providerIds);
  const [after] = await db
    .select({ rows: sql<number>`count(*)::int` })
    .from(benchmarkRankingsTable)
    .where(eq(benchmarkRankingsTable.runId, r.id));
  console.log(`  run ${r.id.slice(0, 8)}  rewrote ${after?.rows ?? 0} rows`);
}

console.log(`recomputed ${bulks.length} bulks and ${soloRuns.length} standalone runs`);
await pool.end();
