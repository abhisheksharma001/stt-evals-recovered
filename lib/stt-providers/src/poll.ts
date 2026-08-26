export type PollOptions = {
  intervalMs?: number;
  timeoutMs?: number;
};

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
      throw new Error(`Polling timed out after ${timeoutMs}ms`);
    }
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
}
