// R-40 (ox-alpha B-71): the sentence a failed cell is recorded with.
//
// Kept out of run-executor because the executor cannot be driven in the test
// suite -- that needs a "ready" provider, and a ready provider in a test
// spends real money. Same reason cell-resumption.ts exists.
//
// Nothing parses this string (checked across artifacts, lib and scripts), so
// it is safe to say what actually happened rather than what the ceiling is.

/** Appends the attempt count only when retrying actually happened.
 *
 *  Before this, the message interpolated CELL_MAX_ATTEMPTS unconditionally, so
 *  a cell that broke on its FIRST attempt -- a 401, or any non-retryable
 *  outcome -- was recorded as having failed "after 3 attempt(s)". An operator
 *  reads that as "we tried hard and it kept failing" and goes looking for a
 *  flaky provider, when the truth is that one call was refused once. */
export function cellFailureMessage(
  message: string,
  attemptsMade: number,
  hadOutcome: boolean,
): string {
  if (!hadOutcome || attemptsMade <= 1) return message;
  return `${message} (after ${attemptsMade} attempts)`;
}
