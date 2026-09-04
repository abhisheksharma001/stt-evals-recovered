/**
 * M-3b: the sentence a refused bulk launch answers with, split out of
 * `bulks.ts` so it can be unit-tested -- `bulks.ts` opens the database at
 * import time and the offline suite has no DATABASE_URL. Same split as
 * `lib/audio-attempt.ts`.
 */

/**
 * T-14: one named bucket per reason a call in scope did NOT make it into the
 * selection. Every call in scope lands in exactly one place -- selected, or
 * one of these -- so `inScopeCount === callIds.length + sum(excluded.count)`
 * always holds and nothing is dropped silently.
 */
export type SelectionExclusion = { bucket: string; count: number };

/**
 * Names every exclusion bucket and its count against the in-scope total --
 * the same numbers `POST /benchmark/bulks/preview` shows, in the same order,
 * so the refusal and the preview never tell different stories.
 */
export function describeEmptySelection(
  inScopeCount: number,
  excluded: SelectionExclusion[],
): string {
  const head = `no corpus calls matched: 0 of ${inScopeCount} in scope`;
  if (excluded.length === 0) return head;
  // Already ordered by resolveCriteriaSelection (biggest first, ties
  // alphabetical). Do not re-sort -- the refusal must read in the same order
  // as the preview a person saw a moment earlier.
  const reasons = excluded.map((e) => `${e.bucket} ${e.count}`).join(", ");
  return `${head} (${reasons})`;
}
