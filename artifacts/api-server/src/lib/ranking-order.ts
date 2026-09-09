// R-46 (ox-alpha B-96). Extracted from run-executor's ranking loop so the
// order it produces can be tested without a run, a database or a provider.
//
// Why it needed extracting at all: the composite alone is not a total order.
// Measured 2026-09-10 across the 275 stored ranking rows, 33 of 58 groups hold
// at least two providers with an identical quality vector -- 94 rows -- so
// more than half of every ranking ends in a tie.
//
// `Array.prototype.sort` is stable, so a tie keeps input order, and the input
// order is whatever a SELECT with no ORDER BY happened to return. PostgreSQL
// is free to change that between two reads of unchanged data, which means
// "Leading candidate" could swap on a re-execute with nothing having changed.

export type RankableAggregate = { providerId: string; composite: number | null };

/** Highest composite first; a missing composite sorts last.
 *
 *  providerId breaks ties because it is the only stable unique key on the
 *  aggregate -- providerName is operator-editable and can repeat. This decides
 *  nothing about which of two tied providers is better. It decides that the
 *  answer stops moving on its own. */
export function compareRankedProviders(
  a: RankableAggregate,
  b: RankableAggregate,
): number {
  return (
    (b.composite ?? -1) - (a.composite ?? -1) ||
    a.providerId.localeCompare(b.providerId)
  );
}
