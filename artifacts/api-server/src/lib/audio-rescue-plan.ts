// T-126: which uncached calls are worth an audio-fetch attempt, and which
// are beyond saving. Pure (no database, no disk) so it is unit-testable --
// the executor in audio-rescue.ts feeds it real rows.
import { isPastVapiRetention } from "./vapi-retention";

export type RescueCallPlan = {
  id: string;
  label: string;
  sourceStartedAt: Date | null;
};

export type RescuePlan = {
  /** Uncached and not past retention (or age unknown): worth an attempt. */
  attempt: RescueCallPlan[];
  /** Uncached and past the 14-day window: the recording is gone at the
   *  source; an attempt would fail identically for everyone. */
  expired: RescueCallPlan[];
  alreadyCachedCount: number;
};

export function planAudioRescue(
  calls: RescueCallPlan[],
  cachedIds: Set<string>,
  now: Date = new Date(),
): RescuePlan {
  const attempt: RescueCallPlan[] = [];
  const expired: RescueCallPlan[] = [];
  let alreadyCachedCount = 0;
  for (const call of calls) {
    if (cachedIds.has(call.id)) {
      alreadyCachedCount += 1;
    } else if (isPastVapiRetention(call.sourceStartedAt, now)) {
      expired.push(call);
    } else {
      attempt.push(call);
    }
  }
  return { attempt, expired, alreadyCachedCount };
}
