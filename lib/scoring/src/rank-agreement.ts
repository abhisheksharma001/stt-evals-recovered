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

// W-12b: Spearman, as PRD Part F names it, for the method check on the public
// set -- one ordering per provider over a whole bulk, not one per call, so
// the per-call tau-b above is not the figure asked for.
//
// Ranks are tie-averaged (mid-ranks): providers tied on a side share the
// mean of the positions they span. rho is then the Pearson correlation of the
// two rank vectors, which is the textbook definition that stays right under
// ties; the 1 - 6*sum(d^2)/(n(n^2-1)) shortcut is only exact without them.

function midRanks(values: readonly number[]): number[] {
  const order = values.map((value, index) => ({ value, index })).sort((x, y) => x.value - y.value);
  const ranks = new Array<number>(values.length);
  let start = 0;
  while (start < order.length) {
    let end = start;
    while (end + 1 < order.length && order[end + 1]!.value === order[start]!.value) end += 1;
    // Positions start..end are 1-based start+1..end+1; their mean is shared.
    const shared = (start + end + 2) / 2;
    for (let k = start; k <= end; k += 1) ranks[order[k]!.index] = shared;
    start = end + 1;
  }
  return ranks;
}

function pearson(a: readonly number[], b: readonly number[]): number | null {
  const n = a.length;
  const meanA = a.reduce((s, v) => s + v, 0) / n;
  const meanB = b.reduce((s, v) => s + v, 0) / n;
  let cov = 0;
  let varA = 0;
  let varB = 0;
  for (let i = 0; i < n; i += 1) {
    const da = a[i]! - meanA;
    const db = b[i]! - meanB;
    cov += da * db;
    varA += da * da;
    varB += db * db;
  }
  return varA === 0 || varB === 0 ? null : cov / Math.sqrt(varA * varB);
}

/**
 * Spearman's rho between two orderings of the same providers, each given as
 * scores where lower is better. +1 is the same order, -1 the reverse.
 *
 * Null below three providers, or when either side is a single tie group --
 * the same rule as kendallTauB: such an input measured nothing, and a caller
 * must report that rather than fall back to some other figure.
 */
export function spearmanRho(a: readonly number[], b: readonly number[]): number | null {
  if (a.length !== b.length) {
    throw new Error("spearmanRho: both orderings must cover the same providers");
  }
  if (a.length < 3) return null;
  return pearson(midRanks(a), midRanks(b));
}

/** Above this, n! orderings stop being instant and nobody has specified an
 *  approximation -- a t-distribution is exactly what W-12b forbids. */
export const MAX_EXACT_PERMUTATION_N = 9;

/**
 * Exact one-sided p-value for spearmanRho(a, b): the share of all n!
 * orderings of b's ranks whose rho against a's ranks is at least the
 * observed one. Computed on the real (tie-averaged) ranks, so ties are
 * handled exactly instead of read off a no-ties table.
 *
 * Null when spearmanRho is null. Throws above MAX_EXACT_PERMUTATION_N.
 */
export function spearmanPermutationP(a: readonly number[], b: readonly number[]): number | null {
  const observed = spearmanRho(a, b);
  if (observed === null) return null;
  const n = a.length;
  if (n > MAX_EXACT_PERMUTATION_N) {
    throw new Error(`spearmanPermutationP: exact p is only computed up to n = ${MAX_EXACT_PERMUTATION_N}`);
  }
  const ranksA = midRanks(a);
  const ranksB = midRanks(b);
  // Floating-point: an ordering equal to the observed one must count.
  const threshold = observed - 1e-9;
  let atLeast = 0;
  let total = 0;
  // Heap's algorithm, iterative: visits every ordering of ranksB once.
  const perm = [...ranksB];
  const c = new Array<number>(n).fill(0);
  const visit = () => {
    total += 1;
    const rho = pearson(ranksA, perm);
    if (rho !== null && rho >= threshold) atLeast += 1;
  };
  visit();
  let i = 0;
  while (i < n) {
    if (c[i]! < i) {
      const j = i % 2 === 0 ? 0 : c[i]!;
      [perm[j], perm[i]] = [perm[i]!, perm[j]!];
      visit();
      c[i]! += 1;
      i = 0;
    } else {
      c[i] = 0;
      i += 1;
    }
  }
  return atLeast / total;
}
