/**
 * One-off data backfill for register row R-55b (2026-09-27).
 *
 * Before R-55, runCell skipped scoring when `!hypothesisTranscript`, which an
 * empty string satisfies: a provider that succeeded and heard nothing left an
 * `ok` cell with no score row. Retry never revisits an `ok` cell, so R-55's
 * code fix cannot reach the one such cell already stored (result 07e4f6e3,
 * AssemblyAI, bulk 4fee349b "Public: Pipecat 1k", a 1-second clip).
 *
 * Abhishek's decision (2026-09-26): score it as a miss, no re-run. This writes
 * the score row runCell now writes -- same functions, same SCORING_VERSION,
 * latencies from the stored timestamps, cost from the provider row's current
 * rate. Two fields the adapter hands runCell are not stored on the result row:
 * diarizationScore (AssemblyAI's adapter always returns null) and
 * latencyEndOfAudioMs (streaming adapters only). Both are null, as on every
 * other AssemblyAI score in that bulk.
 *
 * Then the free passes a finishing run makes: the run's hybrid flags, and the
 * ranking rows of its bulk (or of the run, if it has no bulk).
 *
 * Idempotent: a second run finds nothing to score. No provider, no LLM, no
 * spend. PII: prints ids and numbers only.
 *
 *   pnpm --filter @workspace/api-server exec tsx --env-file-if-exists=.env ./src/backfill-r55b-score-empty-transcript.ts [--apply]
 */
import { and, eq, inArray, isNull } from "drizzle-orm";
import { SCORING_VERSION, score, scoreEntities } from "@workspace/scoring";

const APPLY = process.argv.includes("--apply");
const {
  db,
  pool,
  benchmarkCallsTable,
  benchmarkProviderCallResultsTable,
  benchmarkProvidersTable,
  benchmarkRunsTable,
  benchmarkScoresTable,
} = await import("@workspace/db");
const { writeAudit } = await import("./lib/audit");
const { computeHybridFlagsForRun } = await import("./lib/hybrid-flagging");
const { computeRankingsForBulk, computeRankingsForRun } = await import("./lib/run-executor");

const [{ current_database: database }] = (
  await pool.query<{ current_database: string }>("select current_database()")
).rows as [{ current_database: string }];
console.log(`database: ${database}`);

const unscoredEmpty = and(
  eq(benchmarkProviderCallResultsTable.status, "ok"),
  eq(benchmarkProviderCallResultsTable.hypothesisTranscript, ""),
  isNull(benchmarkScoresTable.id),
);
const targets = await db
  .select({ result: benchmarkProviderCallResultsTable })
  .from(benchmarkProviderCallResultsTable)
  .leftJoin(benchmarkScoresTable, eq(benchmarkScoresTable.resultId, benchmarkProviderCallResultsTable.id))
  .where(unscoredEmpty);

console.log(`R-55b: ${targets.length} ok cells with an empty transcript and no score`);
for (const { result } of targets) {
  console.log(`  ${result.id.slice(0, 8)}  ${result.providerId}  run ${result.runId.slice(0, 8)}`);
}
if (!APPLY) {
  console.log("dry run -- pass --apply to write");
  await pool.end();
  process.exit(0);
}

const touchedRuns = new Set<string>();
let scoredCount = 0;
for (const { result } of targets) {
  const [call] = await db.select().from(benchmarkCallsTable).where(eq(benchmarkCallsTable.id, result.callId));
  const [provider] = await db
    .select()
    .from(benchmarkProvidersTable)
    .where(eq(benchmarkProvidersTable.id, result.providerId));
  if (!call || !provider) throw new Error(`R-55b: call or provider row missing for ${result.id}`);

  // Same arithmetic as runCell (artifacts/api-server/src/lib/run-executor.ts).
  const latencyFinalMs =
    result.finalAt && result.submittedAt ? result.finalAt.getTime() - result.submittedAt.getTime() : null;
  const latencyFirstPartialMs =
    result.firstPartialAt && result.submittedAt
      ? result.firstPartialAt.getTime() - result.submittedAt.getTime()
      : null;
  const costForThisCell = (provider.costPerMinute * call.durationSeconds) / 60;
  const hypothesis = result.hypothesisTranscript ?? "";
  let wer: number | null;
  let entityAccuracy: number | null;
  let alphanumericAccuracy: number | null;
  let detail: Record<string, unknown>;
  if (call.goldTranscript?.trim()) {
    const scored = score({
      callId: call.id,
      vertical: call.vertical as "rush" | "property_management" | "trucking" | "public_benchmark",
      providerId: provider.id,
      goldTranscript: call.goldTranscript,
      hypothesisTranscript: hypothesis,
      entities: call.entityReferences,
      latencyFinalMs,
      latencyFirstPartialMs,
      costPerMinute: costForThisCell,
      diarizationScore: null,
    });
    wer = scored.wer;
    entityAccuracy = scored.entityAccuracy;
    alphanumericAccuracy = scored.alphanumericAccuracy;
    detail = { edits: scored.edits, entityResults: scored.entityResults, wordDiff: scored.wordDiff };
  } else {
    const entity = scoreEntities(call.entityReferences, hypothesis);
    wer = null;
    entityAccuracy = entity.accuracy;
    alphanumericAccuracy = entity.alphanumericAccuracy;
    detail = { entityResults: entity.results };
  }

  const written = await db.transaction(async (tx) => {
    const existing = await tx
      .select({ id: benchmarkScoresTable.id })
      .from(benchmarkScoresTable)
      .where(eq(benchmarkScoresTable.resultId, result.id));
    if (existing.length > 0) return null;
    const [row] = await tx
      .insert(benchmarkScoresTable)
      .values({
        resultId: result.id,
        scoringVersion: SCORING_VERSION,
        wer,
        entityAccuracy,
        alphanumericAccuracy,
        latencyFirstPartialMs,
        latencyFinalMs,
        latencyEndOfAudioMs: null,
        costPerMinute: costForThisCell,
        costMicrocents: Math.round(costForThisCell * 1_000_000),
        diarizationScore: null,
        detail,
      })
      .returning({ id: benchmarkScoresTable.id });
    return row ?? null;
  });
  if (!written) continue;
  await writeAudit({
    entityType: "result",
    entityId: result.id,
    actorLabel: "backfill-r55b-score-empty-transcript",
    action: "update",
    beforeState: { score: null },
    afterState: { scoreId: written.id, scoringVersion: SCORING_VERSION, wer },
  });
  touchedRuns.add(result.runId);
  scoredCount += 1;
  console.log(`  scored ${result.id.slice(0, 8)}: wer ${wer}`);
}

if (touchedRuns.size > 0) {
  const runs = await db.select().from(benchmarkRunsTable).where(inArray(benchmarkRunsTable.id, [...touchedRuns]));
  for (const run of runs) {
    await computeHybridFlagsForRun(run.id);
    // A bulk's ranking rows belong to the bulk; computeRankingsForRun on one
    // of its shards would delete them (see recompute-rankings.ts).
    if (run.bulkId) await computeRankingsForBulk(run.bulkId);
    else await computeRankingsForRun(run.id, run.callIds, run.providerIds);
    console.log(`  run ${run.id.slice(0, 8)}: flags and rankings recomputed`);
  }
}
console.log(`scored ${scoredCount}`);
await pool.end();
