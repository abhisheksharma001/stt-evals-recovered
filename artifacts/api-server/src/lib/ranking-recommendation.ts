// M-10c: the sentence stored on every ranking row and shown on Results
// under "What the calls showed:" (Rankings.tsx), and again as the row
// tooltip.
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
//
// R-4 (2026-09-09): the sentence stopped being a recommendation. Rank 1
// used to open "Leading candidate for this assistant's calls" and close
// with "Confidence: low ... Do not treat as decision-grade" -- a pick and
// its retraction in one sentence, on every card. Read live 2026-09-09: 0
// of 29 assistant groups reach the >=12-call decision bar (the largest has
// 9 scored calls), and 31 assistants over 176 calls means none reaches it
// for months. The org verdict is the only surface that decides
// (PROVISIONAL_EVIDENCE_CALLS = 20, MIN_SHARED_CALLS_FOR_VERDICT = 5), so
// this sentence only describes now: how many calls, who raised the fewest
// disagreements, who was cheapest. WHERE the decision is made is added by
// the page, not stored here -- the aggregation cannot know the org or its
// verdict's evidence count (Rankings.tsx). The claims stay as careful as
// M-10c made them: a tie is never a win, an unknown price is never the
// cheapest, and one provider is never a comparison.
//
// "disagreements" replaces "hybrid flags" throughout, including in the
// runner-up sentences: both halves sit in the same column and the same
// tooltip, and R-3's lesson is that one quantity gets one name on one page
// (the table header has said "Ranked by disagreements, price" since T-57).

export type RecommendationInput = {
  /** R-4: the sentence names who was cleanest and who was cheapest, so the
   *  provider's display name travels with its numbers. */
  name: string;
  /** avgFlagCount-equivalent the composite actually reads: the average of
   *  (peerFlagCount + severityRank(peerFlagSeverity)) across this
   *  provider's cells. Null when no cell carried either. */
  flagBadness: number | null;
  costPerMinute: number | null;
};

const many = (n: number, noun: string): string => `${n} ${noun}${n === 1 ? "" : "s"}`;

const strictlyCheaper = (a: RecommendationInput, b: RecommendationInput): boolean =>
  a.costPerMinute !== null && b.costPerMinute !== null && a.costPerMinute < b.costPerMinute;

/**
 * The stored sentence for rank 1: what this group's calls showed, with no
 * pick in it. `ranked` is the group's providers in rank order, rank 1
 * first; providers whose every cell failed carry a null flagBadness, get
 * their own sentence upstream, and are not rivals that tie or beat.
 * `scopePhrase` already carries the call count ("this assistant's 7
 * calls"), because how it is worded depends on whether the group has an
 * assistant at all.
 */
export function rank1Recommendation(
  ranked: readonly RecommendationInput[],
  scopePhrase: string,
): string {
  const ready = ranked.filter((p) => p.flagBadness !== null);

  if (ready.length === 0) return `On ${scopePhrase}: no disagreement numbers yet.`;
  if (ready.length === 1) {
    return `On ${scopePhrase}: only ${ready[0]!.name} produced a transcript to compare, so nothing here is a comparison.`;
  }

  const fewestBadness = Math.min(...ready.map((p) => p.flagBadness!));
  const cleanest = ready.filter((p) => p.flagBadness === fewestBadness);
  const fewest =
    cleanest.length === 1
      ? `fewest disagreements ${cleanest[0]!.name}`
      : cleanest.length === ready.length
        ? "every provider raised the same disagreements"
        : `${many(cleanest.length, "provider")} tied for fewest disagreements`;

  // "Absent is not zero": a null costPerMinute is an unknown price, so the
  // group cannot be said to have a cheapest until every provider in it has
  // a price. hybridCompositeScore scores that null as the best possible
  // cost; this sentence must not inherit that.
  const priced = ready.filter((p) => p.costPerMinute !== null);
  let cheapest: string;
  if (priced.length < ready.length) {
    cheapest = "no price on file for every provider";
  } else {
    const lowestCost = Math.min(...priced.map((p) => p.costPerMinute!));
    const cheapestOnes = priced.filter((p) => p.costPerMinute === lowestCost);
    cheapest =
      cheapestOnes.length === 1
        ? `cheapest ${cheapestOnes[0]!.name}`
        : cheapestOnes.length === priced.length
          ? "every provider costs the same per minute"
          : `${many(cheapestOnes.length, "provider")} tied on price`;
  }

  return `On ${scopePhrase}: ${fewest}, ${cheapest}.`;
}

/** The stored recommendation for rank 2 and below. */
export function runnerUpRecommendation(
  me: RecommendationInput,
  rank1: RecommendationInput,
): string {
  if (me.flagBadness === null || rank1.flagBadness === null) {
    return "Ranked below rank 1. Not enough evidence to say what separated them.";
  }
  if (me.flagBadness < rank1.flagBadness) {
    return "Ranked below rank 1 on price, not on accuracy -- it raised fewer or less-severe disagreements than rank 1 did.";
  }
  if (me.flagBadness > rank1.flagBadness) {
    return "Behind rank 1 on disagreements: more or more-severe cross-provider disagreement and entity mismatches.";
  }
  return strictlyCheaper(rank1, me)
    ? "Tied with rank 1 on disagreements; ranked below it on price alone."
    : "Tied with rank 1 on disagreements with nothing separating them on price either -- this order is arbitrary.";
}
