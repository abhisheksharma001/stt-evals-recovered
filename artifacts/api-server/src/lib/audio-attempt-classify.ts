// T-131 (pure half, no db import -- unit-testable without DATABASE_URL,
// same split as audio-rescue-plan.ts). See audio-attempt.ts for the writer.
export type AudioAttemptOutcome = "saved" | "failed" | "source_refused";

/**
 * Classify one failed fetch attempt. "source_refused" = the recording can
 * never be obtained from the source again; anything else stays "failed"
 * (retryable). Patterns are evidence, not guesses (T-132 verified the sets
 * behind both):
 *  - Vapi HTTP 400 "Your subscription plan only covers the last 14 days of
 *    call history" -- observed on all 14 refused calls in the batch-12
 *    rescue, including 5 calls only 12 days old (their real problem is the
 *    storage bucket below; Vapi wraps it in the retention message).
 *  - HTTP 403 from the storage bucket after a FRESH url resolution -- the
 *    Supabase `archive`-bucket calls whose links Vapi hands out unsigned
 *    (0/15 cells ever succeeded; confirmed bucket-correlated 2026-08-24).
 *    A fresh resolution immediately 403ing is not an expired link.
 */
export function classifyAudioAttemptFailure(message: string): Exclude<AudioAttemptOutcome, "saved"> {
  if (/only covers the last \d+ days of call history/i.test(message)) return "source_refused";
  if (/HTTP 403\b/i.test(message)) return "source_refused";
  return "failed";
}
