/**
 * W-6a (PRD v8 Part C, Layer 1): has this agent's production transcriber moved
 * off its own normal, or is today an ordinary day?
 *
 * Pure arithmetic over days that already happened. Reads nothing, writes
 * nothing, makes no network call -- the same split R-7 made for
 * `triage-signals.ts` and for the same reason: this number is the amber tick
 * on the Orgs page, so it has to be provable against fixtures rather than
 * against whatever the corpus happens to hold this week.
 *
 * ## The question it answers
 *
 * A watch schedule scores the same agent every day with the same providers.
 * The interesting event is not "which provider is best" -- that is the verdict
 * (`lib/scoring/src/verdict.ts`) -- it is "the transcriber that is actually in
 * production today started disagreeing with its peers more (or less) than it
 * has been". That is a change against the agent's OWN history, not against a
 * threshold someone picked, because a 2.1 rate is alarming for one agent and
 * unremarkable for another.
 *
 * So the band is the agent's own trailing days, 5th to 95th percentile, and
 * `moved` means today fell outside it.
 *
 * ## Why two gates rather than one
 *
 * **Seven settled days before any band at all.** With fewer, the percentile is
 * drawn from so few points that the first slightly-odd day is guaranteed to be
 * a record and the tick would be amber on day two of every schedule. Below
 * seven the row reads `forming` and is never amber -- W-6's acceptance says so
 * in as many words.
 *
 * **Five calls scored today before today can move it.** `MIN_SHARED_CALLS_FOR_VERDICT`
 * is the same floor the headline verdict refuses to speak below, and for the
 * same reason: a rate over two calls is mostly the two calls. A day that
 * scored four calls at a wild rate is not evidence of a change, it is a thin
 * day, and it reads `steady`.
 *
 * ## What it must not do
 *
 * Turn an absent measurement into a number. A day the tick refused, or settled
 * with nothing scored, has no rate -- it is not a 0, and it is not a day for
 * the purpose of counting to seven. The caller is responsible for not handing
 * such a day in at all; this module has no way to tell a real 0.0 (a provider
 * that agreed with every peer all day) from a missing one, and a real 0.0 is a
 * perfectly good day that belongs in the band.
 */
import { MIN_SHARED_CALLS_FOR_VERDICT, percentile } from "@workspace/scoring";

/**
 * The fewest settled days that can produce a band. Below this the row reads
 * `forming` and the tick is never amber.
 */
export const MIN_BASELINE_DAYS = 7;

/** One settled day for one (agent, provider) pair. Only days that produced a
 *  rate belong here -- see the module header on absent-is-not-zero. */
export type BaselineDay = {
  /** `YYYY-MM-DD`, the ledger's `day`. Carried so a caller can label the band;
   *  the arithmetic does not use it and does not assume the days are
   *  contiguous, because a refused day leaves a real gap. */
  day: string;
  /** `peerFlags / words * 100`, the same rate the trend strip and the verdict
   *  report. */
  flagsPer100Words: number;
  /** How many calls that day's rate was drawn from. */
  callsScored: number;
};

export type BaselineState = "forming" | "steady" | "moved";

export type WatchBaseline = {
  state: BaselineState;
  /** How many settled days the band was drawn from. Rendered as the "N days"
   *  next to the tick, so `forming` can say how far off it is. */
  priorDays: number;
  /** The band, or null while `forming`. Never invented: no band, no number. */
  low: number | null;
  high: number | null;
};

/**
 * Today's day against the trailing ones.
 *
 * `today` is null when the agent has no settled run for today -- a schedule
 * that has not fired yet, or a day the tick refused. That is `steady` with the
 * band still reported, not `moved`: nothing was measured, so nothing moved.
 */
export function watchBaseline(input: {
  today: BaselineDay | null;
  /** The settled days BEFORE today, in any order. */
  prior: readonly BaselineDay[];
}): WatchBaseline {
  const priorDays = input.prior.length;
  if (priorDays < MIN_BASELINE_DAYS) {
    return { state: "forming", priorDays, low: null, high: null };
  }

  const sorted = input.prior.map((d) => d.flagsPer100Words).sort((a, b) => a - b);
  const low = percentile(sorted, 0.05);
  const high = percentile(sorted, 0.95);

  const today = input.today;
  if (today === null) return { state: "steady", priorDays, low, high };
  if (today.callsScored < MIN_SHARED_CALLS_FOR_VERDICT) {
    return { state: "steady", priorDays, low, high };
  }

  // Strictly outside. A day that lands exactly on the edge of its own trailing
  // band has matched a day it already had, which is the definition of
  // unremarkable.
  const moved = today.flagsPer100Words < low || today.flagsPer100Words > high;
  return { state: moved ? "moved" : "steady", priorDays, low, high };
}
