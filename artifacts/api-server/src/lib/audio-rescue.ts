// T-126: save every uncached call's audio bytes to the server's disk while
// Vapi will still hand them out. Downloading a recording costs nothing (it
// is the client's own call audio); NOT downloading it costs the call
// forever once Vapi's 14-day retention window closes. Recon on 2026-08-31
// found 57 of 121 corpus calls uncached -- this exists so that number can
// be driven to ~zero with one click instead of waiting for a paid run to
// happen to touch each call.
//
// Resumability rule applies here too: a call already cached is never
// re-fetched (getOrCacheAudioBytes reads disk first), so the endpoint is
// safe to click twice.
import { desc } from "drizzle-orm";
import { benchmarkCallsTable, db } from "@workspace/db";
import { getOrCacheAudioBytes, listCachedCallIds } from "./audio-cache";
import { classifyAudioAttemptFailure, recordAudioCacheAttempt } from "./audio-attempt";
import { drainWithConcurrency } from "./concurrency";
import { VAPI_RETENTION_WINDOW_DAYS } from "./vapi-retention";
import { planAudioRescue } from "./audio-rescue-plan";
import { logger } from "./logger";

/** How many audio downloads run at once. Deliberately small: this hits
 *  Vapi's API (fresh-URL resolution) plus a storage bucket per call, and a
 *  rescue is a background chore, not a latency-sensitive path. */
const RESCUE_CONCURRENCY = 4;

export type RescueOutcome = {
  callId: string;
  label: string;
  outcome: "saved" | "failed" | "expired";
  error: string | null;
};

export type RescueResult = {
  alreadyCachedCount: number;
  savedCount: number;
  failedCount: number;
  expiredCount: number;
  results: RescueOutcome[];
};

/**
 * Attempts to cache audio for every uncached corpus call still inside the
 * retention window. Per-call failures (the known storage-bucket calls, a
 * flaky fetch) are reported per call, never thrown -- one bad call must not
 * stop the other fifty from being saved.
 */
export async function rescueUncachedAudio(): Promise<RescueResult> {
  const calls = await db
    .select({
      id: benchmarkCallsTable.id,
      label: benchmarkCallsTable.label,
      sourceStartedAt: benchmarkCallsTable.sourceStartedAt,
      sourceCallId: benchmarkCallsTable.sourceCallId,
      sourceAccountLabel: benchmarkCallsTable.sourceAccountLabel,
      audioObjectPath: benchmarkCallsTable.audioObjectPath,
    })
    .from(benchmarkCallsTable)
    .orderBy(desc(benchmarkCallsTable.createdAt));

  const cachedIds = await listCachedCallIds();
  const byId = new Map(calls.map((c) => [c.id, c]));
  const plan = planAudioRescue(calls, cachedIds);

  const results: RescueOutcome[] = plan.expired.map((c) => ({
    callId: c.id,
    label: c.label,
    outcome: "expired",
    error: `Past Vapi's ${VAPI_RETENTION_WINDOW_DAYS}-day retention window and never cached -- the recording is gone at the source.`,
  }));

  let savedCount = 0;
  let failedCount = 0;
  await drainWithConcurrency(plan.attempt, RESCUE_CONCURRENCY, async (target) => {
    const call = byId.get(target.id)!;
    try {
      await getOrCacheAudioBytes(call);
      savedCount += 1;
      results.push({ callId: call.id, label: call.label, outcome: "saved", error: null });
      await recordAudioCacheAttempt(call.id, "saved", null);
    } catch (err) {
      failedCount += 1;
      const message = err instanceof Error ? err.message : String(err);
      logger.warn({ err, callId: call.id }, "audio rescue: could not cache this call's audio");
      results.push({ callId: call.id, label: call.label, outcome: "failed", error: message });
      // T-131: persist what this attempt learned, so a permanent refusal
      // (classifyAudioAttemptFailure) stops counting as saveable in the
      // Overview figure and the "Save audio now" button. The attempt itself
      // still runs on every rescue -- re-checking a refusal is free.
      await recordAudioCacheAttempt(call.id, classifyAudioAttemptFailure(message), message);
    }
  });

  return {
    alreadyCachedCount: plan.alreadyCachedCount,
    savedCount,
    failedCount,
    expiredCount: plan.expired.length,
    results,
  };
}
