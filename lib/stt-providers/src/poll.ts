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
    const result = await fn();
    if (result !== null) return result;
    if (Date.now() >= deadline) {
      throw new PollTimeoutError(timeoutMs);
    }
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
}
