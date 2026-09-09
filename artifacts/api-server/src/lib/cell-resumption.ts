// R-26 (ox-alpha B-6): the two decisions that make a run resumable rather
// than retryable-by-luck, kept here as pure functions because the executor
// itself cannot be driven in the test suite -- doing so needs a "ready"
// provider, and a ready provider in a test spends real money.
//
// Both used to read only `status === "ok"`. An "ok" row is supposed to own a
// benchmark_scores row; T-27's replaceOk keeps that true whenever this
// process catches the scoring failure, but a hard kill between the result
// insert and the score insert leaves an ok row with no score. Under the old
// condition that cell was skipped on every retry, forever: paid for, absent
// from every ranking, and unreachable.

export type ResumableCellRow = {
  id: string;
  providerId: string;
  callId: string;
  status: string;
};

export const cellKey = (providerId: string, callId: string): string =>
  `${providerId}::${callId}`;

/** Done means scored, not merely ok. */
export function isCellDone(
  row: ResumableCellRow,
  scoredResultIds: ReadonlySet<string>,
): boolean {
  return row.status === "ok" && scoredResultIds.has(row.id);
}

/** Rows to clear before re-attempting, so the retry inserts fresh.
 *
 * Deleting an unscored "ok" row cannot orphan a score, precisely because it
 * has none. Clearing rather than overwriting is load-bearing: upsertResult's
 * default `setWhere: ne(status, "ok")` would refuse to update a surviving ok
 * row, so the cell would be sent to a paid provider and its answer discarded.
 *
 * Permanently-failed rows stay (T-43): they are not re-attempted, and their
 * row is the only record that the cell was tried and why. */
export function staleResultIdsToClear(
  rows: readonly ResumableCellRow[],
  scoredResultIds: ReadonlySet<string>,
  permanentlyFailed: ReadonlySet<string>,
): string[] {
  return rows
    .filter(
      (r) =>
        !isCellDone(r, scoredResultIds) &&
        !permanentlyFailed.has(cellKey(r.providerId, r.callId)),
    )
    .map((r) => r.id);
}
