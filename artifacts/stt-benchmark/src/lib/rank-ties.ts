/**
 * R-2d: which providers share rank 1 on a Results card.
 *
 * Since R-2b the server ranks a card on the verdict's keys only -- flagged-
 * call rate, then disagreements per 100 words -- and breaks a remaining tie
 * on provider id, which is stable but means nothing. On bulk 42769f26 every
 * one of the 13 cards tied on both keys, so `assemblyai-universal` held rank
 * 1 on all 13 because it sorts first alphabetically. The stored rank cannot
 * say "tied"; this reads it back off the same two numbers the server sorted
 * on, so the card can.
 *
 * Mirrors runnerUpRecommendation (api-server ranking-recommendation.ts): a
 * provider is tied with rank 1 when its flagged-call rate is the same and
 * nothing else measured separates them -- the same per-100-words rate, or
 * one of the two missing. The flagged-call rate is 1 - cleanCallRate; the
 * clean-call rate is compared directly, so no subtraction can make two equal
 * shares differ.
 *
 * Returns the tied providers' ids, rank 1 included, or an empty set when
 * rank 1 stands alone or has no rate to be tied on.
 */
export type RankTieRow = {
  providerId: string
  rank: number
  score: { cleanCallRate?: number | null; peerFlagsPer100Words?: number | null }
}

export function tiedAtTop(rows: readonly RankTieRow[]): Set<string> {
  const top = rows.find((r) => r.rank === 1)
  const topRate = top?.score.cleanCallRate
  if (!top || topRate == null) return new Set()
  const topPer100 = top.score.peerFlagsPer100Words ?? null
  const tied = rows.filter((r) => {
    if (r.score.cleanCallRate !== topRate) return false
    const per100 = r.score.peerFlagsPer100Words ?? null
    return per100 === null || topPer100 === null || per100 === topPer100
  })
  return tied.length > 1 ? new Set(tied.map((r) => r.providerId)) : new Set()
}
