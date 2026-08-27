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

type ConfidenceWord = { word: string; confidence: number };

/** Provider-specific: pulls {word, confidence} pairs out of a provider's raw
 * response JSON. Returns null when the provider doesn't expose confidence at
 * all (Cartesia, OpenAI, ElevenLabs, Speechmatics -- confirmed absent from
 * real captured responses, docs/provider-data-samples.md), never an empty
 * array for that case -- callers need to tell "not available" apart from
 * "available and clean." */
export function extractProviderConfidenceWords(
  providerId: string,
  rawOutputJson: string | null,
): ConfidenceWord[] | null {
  if (!rawOutputJson) return null;
  let body: unknown;
  try {
    body = JSON.parse(rawOutputJson);
  } catch {
    return null;
  }
  if (!body || typeof body !== "object") return null;

  try {
    if (providerId === "assemblyai-universal") {
      const words = (body as { words?: Array<{ text?: string; confidence?: number }> }).words;
      if (!Array.isArray(words)) return null;
      return words
        .filter((w) => typeof w.text === "string" && typeof w.confidence === "number")
        .map((w) => ({ word: w.text!, confidence: w.confidence! }));
    }
    if (providerId === "deepgram-nova-3") {
      const words = (
        body as {
          results?: { channels?: Array<{ alternatives?: Array<{ words?: Array<{ word?: string; confidence?: number }> }> }> };
        }
      ).results?.channels?.[0]?.alternatives?.[0]?.words;
      if (!Array.isArray(words)) return null;
      return words
        .filter((w) => typeof w.word === "string" && typeof w.confidence === "number")
        .map((w) => ({ word: w.word!, confidence: w.confidence! }));
    }
    if (providerId === "gladia-solaria") {
      const utterances = (
        body as { result?: { transcription?: { utterances?: Array<{ words?: Array<{ word?: string; confidence?: number }> }> } } }
      ).result?.transcription?.utterances;
      if (!Array.isArray(utterances)) return null;
      const words: ConfidenceWord[] = [];
      for (const u of utterances) {
        for (const w of u.words ?? []) {
          if (typeof w.word === "string" && typeof w.confidence === "number") {
            words.push({ word: w.word, confidence: w.confidence });
          }
        }
      }
      return words.length ? words : null;
    }
  } catch {
    return null;
  }
  // cartesia-ink-whisper, openai-gpt-4o-transcribe, elevenlabs-scribe,
  // speechmatics: no per-word confidence in their real responses.
  return null;
}

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
    for (const providerId of Object.keys(mismatch.valuesByProvider)) {
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
              detail: {
                ...(row.score.detail ?? {}),
                hybridFlags: {
                  crossProviderDisagreement: flags.crossProviderDisagreement,
                  lowConfidenceSpans: flags.lowConfidenceSpans,
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
