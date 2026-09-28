// R-46 (ox-alpha B-96). Extracted from run-executor's ranking loop so the
// order it produces can be tested without a run, a database or a provider.
//
// Why it needed extracting at all: the ranking keys alone are not a total
// order. Measured 2026-09-10 across the 275 stored ranking rows, 33 of 58
// groups hold at least two providers with an identical quality vector -- 94
// rows -- so more than half of every ranking ends in a tie.
//
// `Array.prototype.sort` is stable, so a tie keeps input order, and the input
// order is whatever a SELECT with no ORDER BY happened to return. PostgreSQL
// is free to change that between two reads of unchanged data, which means
// "Leading candidate" could swap on a re-execute with nothing having changed.
//
// R-2b (2026-09-28, Abhishek: "we are not seeing the cheapest option in this
// whole thing, we want the most reliable STT"): the cards rank on the org
// verdict's own keys -- flagged-call rate, then peer flags per 100 words
// (lib/scoring/src/verdict.ts) -- and price is no longer one of them. It was
// 15% of a composite, and on cards of 1-2 calls where every provider tied on
// flags it decided rank 1 alone: Cartesia, the cheapest, was rank 1 in 12 of
// 13 cards on bulk 42769f26 while the banner named nobody.

export type RankableAggregate = {
  providerId: string;
  /** Calls with at least one peer flag / calls with a peer flag count. Null
   *  when no cell carried one -- the provider has no evidence to rank on. */
  flaggedCallRate: number | null;
  peerFlagsPer100Words: number | null;
};

/** Lowest flagged-call rate first, then lowest peer flags per 100 words; a
 *  missing number sorts after any present one.
 *
 *  providerId breaks the remaining ties because it is the only stable unique
 *  key on the aggregate -- providerName is operator-editable and can repeat.
 *  This decides nothing about which of two tied providers is better. It
 *  decides that the answer stops moving on its own. */
export function compareRankedProviders(
  a: RankableAggregate,
  b: RankableAggregate,
): number {
  return (
    ascNullsLast(a.flaggedCallRate, b.flaggedCallRate) ||
    ascNullsLast(a.peerFlagsPer100Words, b.peerFlagsPer100Words) ||
    a.providerId.localeCompare(b.providerId)
  );
}

function ascNullsLast(a: number | null, b: number | null): number {
  if (a === null) return b === null ? 0 : 1;
  if (b === null) return -1;
  return a - b;
}
