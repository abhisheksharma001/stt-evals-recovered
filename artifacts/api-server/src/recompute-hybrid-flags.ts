/**
 * T-101 (2026-08-30): re-run the free hybrid flag pass over every finished
 * batch run so stored flags reflect the equivalence rules in
 * lib/scoring/src/equivalence.ts (hyphen vs space, "gonna" / "going to",
 * a stray "um" ...). No provider or LLM call is made -- computeHybridFlagsForRun
 * only re-reads stored transcripts and rewrites benchmark_scores.detail /
 * flag columns. Agent scans (the judge's picks) are NOT re-run; they keep
 * their reasoning, and their flagged-span list may now be wider than what
 * the flags say. Rankings are recomputed by re-ranking a bulk, not here.
 *
 *   pnpm --filter @workspace/api-server exec tsx --env-file-if-exists=.env ./src/recompute-hybrid-flags.ts [--apply]
 *
 * Without --apply it only lists the runs it would touch.
 */
import { eq, inArray } from "drizzle-orm";
import { benchmarkRunsTable, db, pool } from "@workspace/db";
import { computeHybridFlagsForRun } from "./lib/hybrid-flagging";

const APPLY = process.argv.includes("--apply");
const runs = await db
  .select({ id: benchmarkRunsTable.id, status: benchmarkRunsTable.status })
  .from(benchmarkRunsTable)
  .where(inArray(benchmarkRunsTable.status, ["complete", "partial", "failed"]));
console.log(`${runs.length} finished runs`);
if (!APPLY) {
  console.log("dry run -- pass --apply to recompute");
  await pool.end();
  process.exit(0);
}
let n = 0;
for (const r of runs) {
  await computeHybridFlagsForRun(r.id);
  n += 1;
  if (n % 10 === 0) console.log(`${n}/${runs.length}`);
}
console.log(`recomputed ${n} runs`);
void eq;
await pool.end();
