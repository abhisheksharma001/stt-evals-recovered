// T-16 (2026-08-29). One place for the number every date default in the UI
// leans on. Vapi's plan keeps a call's recording for 14 days; past that the
// audio is gone for everyone (confirmed live: HTTP 400 "exceeds your
// retention window"), so importing or selecting older calls only produces
// identical failures on every provider -- UNLESS a run already cached the
// audio locally, in which case the call is still perfectly runnable. That is
// why the defaults below are defaults, not limits: earlier stays selectable.
//
// Mirrors VAPI_RETENTION_WINDOW_DAYS in api-server/src/lib/bulks.ts and
// RETENTION_WINDOW_DAYS in pages/Corpus.tsx (which now imports this).
export const VAPI_RETENTION_WINDOW_DAYS = 14

/** Short reason shown next to any input that defaults to this window. */
export const RETENTION_DEFAULT_REASON = `Vapi keeps recordings ${VAPI_RETENTION_WINDOW_DAYS} days; older calls can only run if their audio was already cached by an earlier run.`

/** Today minus the window, as a local-date "YYYY-MM-DD" for <input type="date">. */
export function defaultDateLowerBound(now: Date = new Date()): string {
  const d = new Date(now)
  d.setDate(d.getDate() - VAPI_RETENTION_WINDOW_DAYS)
  const pad = (n: number) => String(n).padStart(2, "0")
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
}
