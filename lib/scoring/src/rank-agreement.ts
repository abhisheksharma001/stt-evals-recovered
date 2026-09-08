// M-18: how far the ranking this tool shows sits from the ranking a human
// transcript produces, on the calls a person actually checked.
//
// Two orderings over the same providers, both "lower is better": word error
// rate against the human gold, and the cross-provider disagreement the tool
// already ranks by. Agreement between them is the only evidence on file that
// the cheap proxy tracks the expensive truth.
//
// tau-b, NOT tau-a. Ties are not an edge case in this corpus, they are the
// normal case: read off the live rows 2026-09-07 (see ranking-recommendation
// .ts's header), rank 1 was TIED for fewest flags in 59 of 62 assistant
// groups, 33 of those with every provider tied. tau-a divides by every pair,
// so each tied pair counts against the score and the figure reads low for a
// reason that has nothing to do with the ranking being wrong. tau-b divides
// by the pairs that could have been ordered at all.
//
//   tau_b = (C - D) / sqrt((n0 - n1) * (n0 - n2))
//
//   n0 = n(n-1)/2, every pair
//   n1 = sum over a's tie groups of t(t-1)/2   (counted pairwise below --
//   n2 = the same over b's tie groups           a group of t contributes
//                                               exactly t(t-1)/2 pairs)

/**
 * Kendall's tau-b between two orderings of the same providers, each given as
 * scores where lower is better. +1 is the same order, -1 the reverse, 0 no
 * relationship.
 *
 * Null when the denominator is zero, which happens exactly when one side is a
 * single tie group -- every provider identical on WER, or every provider
 * identical on disagreement -- and when fewer than two providers are given.
 * Such a call carries no evidence either way. Callers must DROP it rather
 * than count it, and in particular must not fall back to "do the two best
 * sets overlap", which an all-tied side satisfies trivially and which would
 * fill the reported figure with calls that measured nothing.
 */
export function kendallTauB(a: readonly number[], b: readonly number[]): number | null {
  if (a.length !== b.length) {
    throw new Error("kendallTauB: both orderings must cover the same providers");
  }
  const n = a.length;
  let concordant = 0;
  let discordant = 0;
  let tiedInA = 0;
  let tiedInB = 0;
  for (let i = 0; i < n; i += 1) {
    for (let j = i + 1; j < n; j += 1) {
      const da = Math.sign(a[i]! - a[j]!);
      const db = Math.sign(b[i]! - b[j]!);
      // A pair tied on BOTH sides is tied in both totals, not in neither:
      // it is unorderable either way, so it must leave both denominators.
      if (da === 0) tiedInA += 1;
      if (db === 0) tiedInB += 1;
      if (da === 0 || db === 0) continue;
      if (da === db) concordant += 1;
      else discordant += 1;
    }
  }
  const pairs = (n * (n - 1)) / 2;
  const denominator = Math.sqrt((pairs - tiedInA) * (pairs - tiedInB));
  return denominator === 0 ? null : (concordant - discordant) / denominator;
}

/**
 * Whether some provider is best on both sides at once -- "the two rankings
 * share a top-1", the question a reader actually asks.
 *
 * Ties are read as sets, not broken arbitrarily: a provider counts when it is
 * among the best on WER AND among the best on disagreement. Only ever called
 * for a call kendallTauB accepted, so neither side is entirely tied here and
 * the sets cannot both be everything.
 */
export function sharesTop1(a: readonly number[], b: readonly number[]): boolean {
  if (a.length !== b.length) {
    throw new Error("sharesTop1: both orderings must cover the same providers");
  }
  if (a.length === 0) return false;
  const bestA = Math.min(...a);
  const bestB = Math.min(...b);
  return a.some((value, i) => value === bestA && b[i] === bestB);
}
