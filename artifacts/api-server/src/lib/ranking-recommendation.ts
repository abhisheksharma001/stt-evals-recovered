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
// tooltip, and R-3's lesson is that one quantity gets one name on one page.
//
// R-2b (2026-09-28, Abhishek: "we want the most reliable STT"): price no
// longer ranks, so it no longer appears here -- the cards order on the org
// verdict's keys (ranking-order.ts), and the sentence names only those: the
// flagged-call rate, then disagreements per 100 words. Everything above about
// price ("cost decided the order", "an unknown price is never the cheapest")
// is history; the rules that survive are that a tie is never a win and one
// provider is never a comparison.

export type RecommendationInput = {
  /** R-4: the sentence names who was cleanest, so the provider's display
   *  name travels with its numbers. */
  name: string;
  /** R-2b: the two keys the card ranks on (ranking-order.ts). Null when no
   *  cell carried a peer flag count. */
  flaggedCallRate: number | null;
  peerFlagsPer100Words: number | null;
  /** R-2e: calls this provider failed (a timeout or a server error), each
   *  already counted in flaggedCallRate. */
  failedCalls?: number;
};

const many = (n: number, noun: string): string => `${n} ${noun}${n === 1 ? "" : "s"}`;

/**
 * The stored sentence for rank 1: what this group's calls showed, with no
 * pick in it. `ranked` is the group's providers in rank order, rank 1
 * first; providers with no flagged-call rate get their own sentence
 * upstream, and are not rivals that tie or beat. `scopePhrase` already
 * carries the call count ("this assistant's 7 calls"), because how it is
 * worded depends on whether the group has an assistant at all.
 */
export function rank1Recommendation(
  ranked: readonly RecommendationInput[],
  scopePhrase: string,
): string {
  const ready = ranked.filter((p) => p.flaggedCallRate !== null);

  if (ready.length === 0) return `On ${scopePhrase}: no disagreement numbers yet.`;
  if (ready.length === 1) {
    return `On ${scopePhrase}: only ${ready[0]!.name} produced a transcript to compare, so nothing here is a comparison.`;
  }

  const lowestRate = Math.min(...ready.map((p) => p.flaggedCallRate!));
  const atLowest = ready.filter((p) => p.flaggedCallRate === lowestRate);
  if (atLowest.length === 1) return `On ${scopePhrase}: fewest flagged calls ${atLowest[0]!.name}.`;

  const per100 = atLowest.filter((p) => p.peerFlagsPer100Words !== null);
  const lowestPer100 = Math.min(...per100.map((p) => p.peerFlagsPer100Words!));
  const cleanest = per100.filter((p) => p.peerFlagsPer100Words === lowestPer100);
  const tiedOnRate = atLowest.length === ready.length ? "every provider" : many(atLowest.length, "provider");
  if (cleanest.length === 1) {
    return `On ${scopePhrase}: ${tiedOnRate} tied on flagged calls, fewest disagreements per 100 words ${cleanest[0]!.name}.`;
  }
  const tied = cleanest.length === 0 ? atLowest : cleanest;
  return tied.length === ready.length
    ? `On ${scopePhrase}: every provider tied on flagged calls and disagreements per 100 words.`
    : `On ${scopePhrase}: ${many(tied.length, "provider")} tied for fewest flagged calls and disagreements per 100 words.`;
}

/** The stored recommendation for rank 2 and below. */
export function runnerUpRecommendation(
  me: RecommendationInput,
  rank1: RecommendationInput,
): string {
  if (me.flaggedCallRate === null || rank1.flaggedCallRate === null) {
    return "Ranked below rank 1. Not enough evidence to say what separated them.";
  }
  if (me.flaggedCallRate > rank1.flaggedCallRate) {
    return "Behind rank 1: flagged on a larger share of its calls.";
  }
  if (
    me.peerFlagsPer100Words !== null &&
    rank1.peerFlagsPer100Words !== null &&
    me.peerFlagsPer100Words > rank1.peerFlagsPer100Words
  ) {
    return "Tied with rank 1 on flagged calls; behind it on disagreements per 100 words.";
  }
  return "Tied with rank 1 on flagged calls, and nothing else measured separates them -- this order is arbitrary.";
}

/**
 * R-2e: a row whose provider failed on some calls says so, after whatever
 * the sentence already said. Those failures are inside its flagged-call rate;
 * without this a reader would take every flagged call for a disagreement.
 */
export function withFailures(sentence: string, me: RecommendationInput): string {
  const failed = me.failedCalls ?? 0;
  if (failed === 0) return sentence;
  return `${sentence} ${me.name} failed on ${many(failed, "call")} (timeout or server error); each counts as a flagged call.`;
}
