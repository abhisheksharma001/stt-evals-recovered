import type { FailureClass } from "./failure-class";

export type PollOptions = {
  intervalMs?: number;
  timeoutMs?: number;
};

// T-8 fix (2026-08-27, base-solidity review): a fixed 120s timeout meant
// any call whose async job legitimately took longer (a real possibility --
// this project's whole corpus is real client call recordings, some long)
// threw here, and run-executor's isRetryableError treated a generic Error
// as retryable -- so the cell retried, which for AssemblyAI/Gladia/
// Speechmatics means RE-UPLOADING the audio and submitting a BRAND NEW job.
// Three attempts, three paid transcriptions, all of which time out again --
// silent triple-billing on exactly the long calls that matter most, and the
// cell still ends up failed either way. PollTimeoutError is a distinct,
// checkable type so the executor can treat a timeout as terminal (a
// timed-out job is a job that was already submitted and paid for --
// retrying pays twice for the same work, it doesn't get a different
// outcome).
export class PollTimeoutError extends Error {
  // T-06: carried on the error itself so every adapter's catch can read the
  // class off the throw rather than matching on this message.
  readonly failureClass: FailureClass = "provider_timeout";

  constructor(timeoutMs: number) {
    super(`Polling timed out after ${timeoutMs}ms`);
    this.name = "PollTimeoutError";
  }
}

/** timeoutMs scaled to how long the call actually is: 3x realtime, floored
 * at 60s (short calls still need room for queueing/startup latency) and
 * capped at 15 minutes (a sane outer bound regardless of call length).
 * Callers that don't know the call's duration (or are testing) can pass a
 * fixed timeoutMs to pollUntil directly instead. */
export function scaledPollTimeoutMs(durationSeconds: number | null | undefined): number {
  if (!durationSeconds || durationSeconds <= 0) return 120_000;
  return Math.min(900_000, Math.max(60_000, durationSeconds * 1000 * 3));
}

/**
 * Polls `fn` until it returns a non-null result or `timeoutMs` elapses.
 * Used by the async-job providers (AssemblyAI, Gladia, Speechmatics) whose
 * batch transcription APIs return a job id immediately and require polling
 * for completion.
 */
export async function pollUntil<T>(
  fn: () => Promise<T | null>,
  { intervalMs = 3000, timeoutMs = 120_000 }: PollOptions = {},
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const remaining = deadline - Date.now();
    if (remaining <= 0) throw new PollTimeoutError(timeoutMs);
    // R-48: bounded by what is left of the budget, not merely checked between
    // attempts. `timeoutMs` used to be advisory: the deadline was only read
    // after `fn()` resolved, so a poll GET that stalled held the worker slot,
    // the vendor concurrency slot and the run's advisory-lock client until
    // undici's own default gave up -- minutes past a budget of seconds. There
    // is no AbortSignal anywhere in this package, so nothing else bounded it.
    const result = await withinRemaining(fn(), remaining, timeoutMs);
    if (result !== null) return result;
    const left = deadline - Date.now();
    if (left <= 0) throw new PollTimeoutError(timeoutMs);
    // Clamped: sleeping a full interval past the deadline is how the loop used
    // to issue one more request after its budget was spent.
    await new Promise((resolve) => setTimeout(resolve, Math.min(intervalMs, left)));
  }
}

/** Resolves with `pending`'s value, or throws PollTimeoutError once `ms` has
 *  passed -- whichever happens first.
 *
 *  This does NOT cancel the request behind `pending`: there is no AbortSignal
 *  to hand it, and adding one changes every adapter's fetch call. The socket
 *  is left to undici's own bound. What it frees on time is what the run is
 *  actually short of -- the worker slot, the vendor slot and the pooled
 *  client -- and a poll GET is a read, so abandoning one bills nothing and
 *  loses nothing that a later attempt could not read again.
 *
 *  The abandoned promise gets a catch of its own: without one, a rejection
 *  arriving after the race is an unhandled rejection, which is a different
 *  way to kill the process (see R-45). */
async function withinRemaining<T>(
  pending: Promise<T | null>,
  ms: number,
  timeoutMs: number,
): Promise<T | null> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const expiry = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => reject(new PollTimeoutError(timeoutMs)), ms);
  });
  try {
    return await Promise.race([pending, expiry]);
  } catch (err) {
    if (err instanceof PollTimeoutError) pending.catch(() => {});
    throw err;
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}
