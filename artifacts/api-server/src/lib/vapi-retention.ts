// T-126: the one place the 14-day number lives on the server. Vapi's
// subscription plan keeps a call's recording for 14 days after the call --
// past that, no fresh URL can ever be obtained again (confirmed live:
// HTTP 400 past day 14, see docs/backlog/good-to-have.md). The UI has its
// own copy in artifacts/stt-benchmark/src/lib/retention.ts, kept in sync by
// convention (the API deliberately sends facts -- `audioCached` -- not
// countdowns, so the two constants only have to agree about wording).
export const VAPI_RETENTION_WINDOW_DAYS = 14;

/**
 * Whether a call's source recording is already past Vapi's retention window
 * (so a fetch attempt is pointless -- the recording is gone at the source).
 * A call with no known start date is NOT treated as past retention: unknown
 * age is unknown, not expired -- an attempt is the only way to find out.
 */
export function isPastVapiRetention(
  sourceStartedAt: Date | null,
  now: Date = new Date(),
): boolean {
  if (!sourceStartedAt) return false;
  const cutoff = new Date(now.getTime() - VAPI_RETENTION_WINDOW_DAYS * 24 * 60 * 60 * 1000);
  return sourceStartedAt < cutoff;
}
