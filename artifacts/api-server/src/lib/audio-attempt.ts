// T-131: persist the last audio-cache attempt outcome per call, so the
// Overview's "audio not saved" figure and the Calls "Save audio now (N)"
// button can tell "never tried" apart from "the source has refused this
// call" -- and reach a true zero. Batch 12 left this as the named residue:
// 14 calls Vapi refuses forever kept counting as a chore a person could
// still clear.
//
// Only rescue (lib/audio-rescue.ts) and import-time caching
// (routes/benchmark.ts importOne) record outcomes -- the run executor's
// audio pre-pass does not, deliberately: a cached call's truth is the bytes
// on disk (audioCached), and an uncached call the executor failed on still
// counts as attemptable unless the failure was a permanent refusal, which
// those two recorders already capture on their own attempts.
import { eq } from "drizzle-orm";
import { benchmarkCallsTable, db } from "@workspace/db";
import { logger } from "./logger";
import type { AudioAttemptOutcome } from "./audio-attempt-classify";

export { classifyAudioAttemptFailure, type AudioAttemptOutcome } from "./audio-attempt-classify";

/** Best-effort write of the attempt outcome -- never throws: losing the
 *  breadcrumb must not fail the rescue/import that produced it. */
export async function recordAudioCacheAttempt(
  callId: string,
  outcome: AudioAttemptOutcome,
  error: string | null,
): Promise<void> {
  try {
    await db
      .update(benchmarkCallsTable)
      .set({
        audioCacheLastOutcome: outcome,
        audioCacheLastError: outcome === "saved" ? null : error,
        audioCacheLastAttemptAt: new Date(),
      })
      .where(eq(benchmarkCallsTable.id, callId));
  } catch (err) {
    logger.warn({ err, callId }, "could not record audio-cache attempt outcome");
  }
}
