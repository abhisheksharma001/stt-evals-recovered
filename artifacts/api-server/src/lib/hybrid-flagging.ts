// Gold-free hybrid quality flagging (2026-08-27, per Abhishek). Orchestrates
// the pure signal functions in lib/scoring/src/hybrid.ts across every
// candidate transcript a call actually got in a run, and writes the result
// onto each cell's existing benchmark_scores row (created by run-executor's
// per-cell score() call, which now only produces null wer/entityAccuracy
// without a gold transcript -- this fills in what replaces them).
//
// This file owns the one piece of provider-specific knowledge the pure
// scoring lib deliberately doesn't have: how to pull word-level confidence
// back out of each provider's raw stored JSON. Confirmed against real
// captured responses in docs/provider-data-samples.md -- AssemblyAI and
// Deepgram/Gladia use different field names for the word text itself
// ("text" vs "word"), which is exactly the kind of thing this project's
// standing rule ("verify against the real API, not memory") exists for.
import { and, eq, inArray } from "drizzle-orm";
import {
  benchmarkProviderCallResultsTable,
  benchmarkScoresTable,
  db,
} from "@workspace/db";
import {
  combineHybridFlags,
  computeCrossProviderDisagreement,
  computeEntityMismatches,
  flagLowConfidenceSpans,
  type ConfidenceSpan,
  type EntityMismatch,
} from "@workspace/scoring";
import { logger } from "./logger";

// T-110: extraction lives in provider-confidence.ts (pure, no DB import) so
// it is unit-testable; re-exported here for the existing callers.
import { extractProviderConfidenceWords } from "./provider-confidence";
export { extractProviderConfidenceWords };

export type HybridFlagWriteResult = {
  resultId: string;
  providerId: string;
  flagCount: number;
  flagSeverity: "none" | "low" | "medium" | "high";
};

/** Runs the full hybrid pass for a single call's candidates and returns the
 * per-provider result -- does NOT write to the DB, so it's reusable by both
 * the automatic per-run pass (computeHybridFlagsForRun) and the on-demand
 * Agent-page scan, which needs the same computation without a run's
 * benchmark_scores rows to attach to. */
export function computeHybridFlagsForCandidates(
  candidates: { providerId: string; transcript: string; rawOutputJson: string | null }[],
): Map<string, ReturnType<typeof combineHybridFlags> & { providerId: string }> {
  const disagreements = computeCrossProviderDisagreement(
    candidates.map((c) => ({ providerId: c.providerId, transcript: c.transcript })),
  );
  const disagreementByProvider = new Map(disagreements.map((d) => [d.providerId, d]));

  const entityMismatches = computeEntityMismatches(
    candidates.map((c) => ({ providerId: c.providerId, transcript: c.transcript })),
  );
  const mismatchesByProvider = new Map<string, EntityMismatch[]>();
  for (const c of candidates) mismatchesByProvider.set(c.providerId, []);
  for (const mismatch of entityMismatches) {
    // T-3 fix: a provider that's MISSING a consensus entity must be
    // charged for it same as one that conflicts -- the old code only ever
    // looked at Object.keys(valuesByProvider), which by construction can
    // never include a provider that produced nothing of that type.
    const affected = new Set([
      ...Object.keys(mismatch.valuesByProvider),
      ...mismatch.missingProviderIds,
    ]);
    for (const providerId of affected) {
      mismatchesByProvider.get(providerId)?.push(mismatch);
    }
  }

  const results = new Map<string, ReturnType<typeof combineHybridFlags> & { providerId: string }>();
  for (const c of candidates) {
    const confidenceWords = extractProviderConfidenceWords(c.providerId, c.rawOutputJson);
    const confidenceSpans: ConfidenceSpan[] = confidenceWords ? flagLowConfidenceSpans(confidenceWords) : [];
    const combined = combineHybridFlags({
      disagreement: disagreementByProvider.get(c.providerId) ?? null,
      confidenceSpans,
      // T-2: whether THIS provider's raw output ever exposed confidence at
      // all -- null (not an empty array) from extractProviderConfidenceWords
      // means "not reported," distinct from "reported and clean."
      confidenceAvailable: confidenceWords !== null,
      entityMismatches: mismatchesByProvider.get(c.providerId) ?? [],
    });
    results.set(c.providerId, { ...combined, providerId: c.providerId });
  }
  return results;
}

/** Automatic pass, called once per run after every cell has finished
 * (run-executor.ts). Free -- no LLM call, just text comparison -- so it's
 * safe to run unconditionally on every run regardless of size. Writes onto
 * each cell's existing benchmark_scores row (already inserted by the
 * per-cell score() call), merging into `detail` rather than replacing it so
 * wordDiff/edits/entityResults survive. */
export async function computeHybridFlagsForRun(runId: string): Promise<void> {
  const rows = await db
    .select({ result: benchmarkProviderCallResultsTable, score: benchmarkScoresTable })
    .from(benchmarkProviderCallResultsTable)
    .leftJoin(benchmarkScoresTable, eq(benchmarkScoresTable.resultId, benchmarkProviderCallResultsTable.id))
    .where(
      and(
        eq(benchmarkProviderCallResultsTable.runId, runId),
        eq(benchmarkProviderCallResultsTable.status, "ok"),
      ),
    );

  const byCallId = new Map<string, typeof rows>();
  for (const row of rows) {
    if (!row.result.hypothesisTranscript) continue;
    if (!byCallId.has(row.result.callId)) byCallId.set(row.result.callId, []);
    byCallId.get(row.result.callId)!.push(row);
  }

  for (const [callId, callRows] of byCallId) {
    const candidates = callRows.map((r) => ({
      providerId: r.result.providerId,
      transcript: r.result.hypothesisTranscript!,
      rawOutputJson: r.result.rawOutput,
    }));
    const flagsByProvider = computeHybridFlagsForCandidates(candidates);

    for (const row of callRows) {
      const flags = flagsByProvider.get(row.result.providerId);
      if (!flags) continue;
      try {
        if (row.score) {
          await db
            .update(benchmarkScoresTable)
            .set({
              flagCount: flags.flagCount,
              flagSeverity: flags.flagSeverity,
              // T-2: the ranking composite reads these two, never the
              // confidence-inclusive columns above.
              peerFlagCount: flags.peerFlagCount,
              peerFlagSeverity: flags.peerFlagSeverity,
              detail: {
                ...(row.score.detail ?? {}),
                hybridFlags: {
                  crossProviderDisagreement: flags.crossProviderDisagreement,
                  lowConfidenceSpans: flags.lowConfidenceSpans,
                  confidenceAvailable: flags.confidenceAvailable,
                  entityMismatches: flags.entityMismatches,
                },
              },
            })
            .where(eq(benchmarkScoresTable.id, row.score.id));
        } else {
          // Defensive -- every "ok" cell should already have a score row
          // from run-executor's per-cell score() call; this only fires if
          // that invariant is ever broken.
          logger.warn({ runId, callId, resultId: row.result.id }, "hybrid flag pass found an ok cell with no score row");
        }
      } catch (err) {
        logger.error({ err, runId, callId, resultId: row.result.id }, "failed to persist hybrid flags for cell");
      }
    }
  }
}
