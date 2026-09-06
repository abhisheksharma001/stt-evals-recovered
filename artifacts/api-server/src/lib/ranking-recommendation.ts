// M-10c: the sentence stored on every ranking row and shown on Results
// under "Why this order:" (Rankings.tsx:952), and again as the row tooltip
// (Rankings.tsx:484, :516).
//
// It used to be two fixed sentences: rank 1 got "fewest/least-severe hybrid
// flags among ready providers", everyone else got "Behind rank 1 on hybrid
// flag composite (more or more-severe cross-provider/confidence/entity
// flags)". Read off the live DB 2026-09-07, rank 1 actually had the fewest
// flags in 1 of 62 assistant groups. In 59 it was tied for fewest (33 of
// those with every provider tied), and in 2 it had MORE flags than the
// provider directly below it -- which was also half the price. The
// runner-up sentence is wrong in the same 61 groups, and its parenthetical
// still names confidence spans, which T-2 took out of the composite on
// 2026-08-27.
//
// So the sentence is derived from the aggregates instead of fixed. What can
// honestly be said depends on only two quantities, because after M-10a the
// composite is only two quantities: HYBRID_RANKING_WEIGHTS.flags *
// flagComponent + .cost * costComponent.
//
//   flags equal                  -> cost decided the order
//   flags unequal, flaggier won  -> cost outweighed the flag gap. Possible
//                                   even at a 0.85 flag weight, because a
//                                   small flagComponent gap is worth less
//                                   than the full 0.15 the cost term can
//                                   swing.
//   flags equal and cost equal   -> nothing decided it; the order is
//                                   whatever the sort left (bug-register
//                                   B-96)
//
// "Absent is not zero" applies to causes, not just numbers: a null
// costPerMinute is an unknown price, not a winning one, so a flag tie next
// to a null price reads as undecided rather than as a price win -- even
// though hybridCompositeScore itself scores that null as the best possible
// cost. Mirroring the composite's arithmetic here would let the sentence
// claim a provider was cheapest when nobody knows what it costs.

export type RecommendationInput = {
  /** avgFlagCount-equivalent the composite actually reads: the average of
   *  (peerFlagCount + severityRank(peerFlagSeverity)) across this
   *  provider's cells. Null when no cell carried either. */
  flagBadness: number | null;
  costPerMinute: number | null;
};

const providers = (n: number): string => (n === 1 ? "1 other provider" : `${n} other providers`);

const strictlyCheaper = (a: RecommendationInput, b: RecommendationInput): boolean =>
  a.costPerMinute !== null && b.costPerMinute !== null && a.costPerMinute < b.costPerMinute;

/**
 * The stored recommendation for rank 1. `ranked` is the group's providers in
 * rank order, rank 1 first; providers with a null composite (no cell
 * succeeded) get their own sentence upstream and are ignored here.
 */
export function rank1Recommendation(
  ranked: readonly RecommendationInput[],
  groupPhrase: string,
): string {
  const me = ranked[0];
  const peers = ranked.slice(1).filter((p) => p.flagBadness !== null);

  if (me === undefined || me.flagBadness === null || peers.length === 0) {
    // One provider ran. "Fewest flags among ready providers" is a
    // comparison with nothing to compare against -- 2 such groups exist in
    // the live corpus today.
    return `Only candidate for ${groupPhrase} -- one provider ran, so this is not a comparison.`;
  }

  const cleaner = peers.filter((p) => p.flagBadness! < me.flagBadness!).length;
  if (cleaner > 0) {
    return `Leading candidate for ${groupPhrase} -- cheaper per minute, though ${providers(cleaner)} raised fewer or less-severe hybrid flags. Price outweighed the flag gap; this is not an accuracy win.`;
  }

  const tied = peers.filter((p) => p.flagBadness! === me.flagBadness!).length;
  if (tied === 0) {
    return `Leading candidate for ${groupPhrase} -- fewest/least-severe hybrid flags among ready providers.`;
  }

  const priceDecided = peers.every(
    (p) => p.flagBadness! !== me.flagBadness! || strictlyCheaper(me, p),
  );
  return priceDecided
    ? `Leading candidate for ${groupPhrase} -- tied on hybrid flags with ${providers(tied)} and the cheapest of the tied. Price decided this order, not accuracy.`
    : `No leader for ${groupPhrase} -- tied on hybrid flags with ${providers(tied)} and nothing separates them on price either, so this order is arbitrary. Do not read rank 1 as a pick.`;
}

/** The stored recommendation for rank 2 and below. */
export function runnerUpRecommendation(
  me: RecommendationInput,
  rank1: RecommendationInput,
): string {
  if (me.flagBadness === null || rank1.flagBadness === null) {
    return "Ranked below rank 1. Not enough flag evidence to say what separated them.";
  }
  if (me.flagBadness < rank1.flagBadness) {
    return "Ranked below rank 1 on price, not on accuracy -- it raised fewer or less-severe hybrid flags than rank 1 did.";
  }
  if (me.flagBadness > rank1.flagBadness) {
    return "Behind rank 1 on hybrid flags: more or more-severe cross-provider disagreement and entity mismatches.";
  }
  return strictlyCheaper(rank1, me)
    ? "Tied with rank 1 on hybrid flags; ranked below it on price alone."
    : "Tied with rank 1 on hybrid flags with nothing separating them on price either -- this order is arbitrary.";
}
