/**
 * R-7: the arithmetic behind "is this stored signal worth building a monitor
 * on?", kept out of the mining script so it can be proved against synthetic
 * fixtures rather than against a corpus of real callers. Same split M-15 made
 * for the same reason (`lib/confirmed-entities.ts`): the numbers this produces
 * go into PRD v7 Part E as a decision, so they have to be provable without
 * running against the database.
 *
 * Reads nothing and writes nothing.
 */

/** One call that carried a verdict, for one signal. Calls whose signal column
 *  is null, and calls whose latest scan is not a verdict, never become a cell
 *  — "not measured" is not "no". */
export type SignalCell = { selected: boolean; flagged: boolean };

export type SeedRule = {
  /** Precision must beat the base rate by at least this many points. */
  liftMarginPoints: number;
  /** A signal that picks nearly everything leaves no work out, whatever its
   *  precision, so it is not a trigger. */
  maxSelectedShare: number;
};

export type SignalStats = {
  population: number;
  selected: number;
  selectedFlagged: number;
  selectedClean: number;
  restFlagged: number;
  restClean: number;
  precision: number;
  recall: number;
  base: number;
  lift: number;
  /** The most lift arithmetic allows: a perfect signal reaches precision 1, so
   *  the ceiling is 1 - base. When this is under the rule's margin the signal
   *  cannot pass however good it is, and a plain "no" would be read as "tested
   *  and lost" when the truth is "the truth column is too nearly constant". */
  headroom: number;
  verdict: "seed" | "untestable" | "no";
};

export function signalStats(cells: readonly SignalCell[], rule: SeedRule): SignalStats {
  let selectedFlagged = 0;
  let selectedClean = 0;
  let restFlagged = 0;
  let restClean = 0;
  for (const cell of cells) {
    if (cell.selected) cell.flagged ? (selectedFlagged += 1) : (selectedClean += 1);
    else cell.flagged ? (restFlagged += 1) : (restClean += 1);
  }
  const population = cells.length;
  const selected = selectedFlagged + selectedClean;
  const flaggedTotal = selectedFlagged + restFlagged;
  const precision = selected === 0 ? 0 : selectedFlagged / selected;
  const recall = flaggedTotal === 0 ? 0 : selectedFlagged / flaggedTotal;
  const base = population === 0 ? 0 : flaggedTotal / population;
  const lift = precision - base;
  const headroom = (1 - base) * 100;
  const seed =
    selected > 0 &&
    selected / population <= rule.maxSelectedShare &&
    lift * 100 >= rule.liftMarginPoints;
  // No `population > 0` guard: `selected > 0` already implies it, and a break
  // test proved the extra clause could be deleted without a single test
  // moving. The two branches below also cannot fight: precision never exceeds
  // 1, so lift <= headroom/100, so a seed always has headroom >= the margin.
  // "untestable" therefore only ever explains a failure, whichever order it
  // is written in.
  const verdict = seed ? "seed" : headroom < rule.liftMarginPoints ? "untestable" : "no";
  return {
    population,
    selected,
    selectedFlagged,
    selectedClean,
    restFlagged,
    restClean,
    precision,
    recall,
    base,
    lift,
    headroom,
    verdict,
  };
}
