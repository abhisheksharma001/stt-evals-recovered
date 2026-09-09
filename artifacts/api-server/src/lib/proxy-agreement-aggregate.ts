// M-18: the pure half of proxy-agreement.ts. No db import so it can be
// unit-tested without DATABASE_URL, same split and same reason as T-85's
// call-disagreement-aggregate.ts.
import { kendallTauB, severityRank, sharesTop1, type HybridSeverity } from "@workspace/scoring";

export type ProxyAgreementRow = {
  callId: string;
  providerId: string;
  wer: number | null;
  peerFlagCount: number | null;
  peerFlagSeverity: string | null;
};

export type ProxyAgreementFigures = {
  /** Calls that actually contributed. Always <= the labelled calls. */
  n: number;
  top1Agreement: number | null;
  kendallTau: number | null;
};

const mean = (values: number[]): number | null =>
  values.length === 0 ? null : values.reduce((a, b) => a + b, 0) / values.length;

// The same quantity the ranking itself is built on: T-2's flagBadness,
// peerFlagCount + severityRank(peerFlagSeverity), NOT flagCount/flagSeverity.
// Copied in shape from run-executor's flagBadnessOf on purpose -- if this
// ranked by anything else, the figure would report agreement with a ranking
// nobody is shown.
const flagBadness = (row: ProxyAgreementRow): number | null =>
  row.peerFlagCount === null && row.peerFlagSeverity === null
    ? null
    : (row.peerFlagCount ?? 0) + severityRank((row.peerFlagSeverity as HybridSeverity | null) ?? "none");

/**
 * Per call, rank the providers two ways and compare the orders.
 *
 * A provider gets ONE value per call per side, the mean over its cells, not
 * one value per cell. A call sits in more than one run -- the cell key is
 * (run_id, call_id, provider_id) -- and on the live corpus the same provider
 * scored 0.40 and 3.56 WER on the same call in two different runs. Averaging
 * is what run-executor's providerAggregates already does for every number on
 * the Results page, so the ranking compared here is the ranking shown there.
 *
 * A call is DROPPED, not counted as agreement, whenever kendallTauB answers
 * null -- either ordering is a single tie group, or fewer than two providers
 * carry both a WER and a flag reading so there are no pairs to order. Both
 * mean the call distinguishes nothing, and "absent is not zero": a call that
 * measured nothing must not be reported as a call that agreed.
 */
export function aggregateProxyAgreement(rows: readonly ProxyAgreementRow[]): ProxyAgreementFigures {
  const byCall = new Map<string, Map<string, ProxyAgreementRow[]>>();
  for (const row of rows) {
    const call = byCall.get(row.callId) ?? new Map<string, ProxyAgreementRow[]>();
    call.set(row.providerId, [...(call.get(row.providerId) ?? []), row]);
    byCall.set(row.callId, call);
  }

  let n = 0;
  let tauTotal = 0;
  let top1Total = 0;

  for (const providers of byCall.values()) {
    const wers: number[] = [];
    const badnesses: number[] = [];
    for (const cells of providers.values()) {
      const wer = mean(cells.map((c) => c.wer).filter((v): v is number => v !== null));
      const badness = mean(cells.map(flagBadness).filter((v): v is number => v !== null));
      // Both sides or neither: a provider missing from one ordering cannot be
      // ranked against the other, and dropping it from just one side would
      // compare two orderings over different providers.
      if (wer === null || badness === null) continue;
      wers.push(wer);
      badnesses.push(badness);
    }
    // One rule, not two. A call with fewer than two rankable providers has
    // no pairs at all, so kendallTauB's denominator is zero and it already
    // answers null -- an explicit length check here was redundant, and the
    // break test proved it by mutating it with no observable effect.
    const tau = kendallTauB(wers, badnesses);
    if (tau === null) continue;
    n += 1;
    tauTotal += tau;
    if (sharesTop1(wers, badnesses)) top1Total += 1;
  }

  return {
    n,
    top1Agreement: n === 0 ? null : top1Total / n,
    kendallTau: n === 0 ? null : tauTotal / n,
  };
}

/**
 * M-20: one candidate the judge chose among, on a call a person transcribed.
 * `pickedProviderId` is the same on every row of a call -- it is a property of
 * the call's scan, carried here so the aggregate needs no second input.
 */
export type JudgePickRow = {
  callId: string;
  pickedProviderId: string;
  providerId: string;
  /** WER against the human transcript. Null = this candidate was never scored
   *  against it, so it cannot be ordered and takes no part. */
  wer: number | null;
};

export type JudgeAccuracyFigures = {
  /** Calls that could actually be measured. Always <= the calls with a pick. */
  n: number;
  /** Share of those where the judge picked a lowest-WER provider. Null at n=0. */
  top1Agreement: number | null;
};

/**
 * Did the judge pick the provider a human transcript says was best?
 *
 * The candidate set is the providers the judge ACTUALLY chose among -- the
 * scored cells of the scan's own run -- not every provider that ever ran this
 * call. Marking the judge wrong for missing a provider it was never shown
 * would measure the run's provider list, not the judge.
 *
 * A call is DROPPED, never counted as a disagreement, when: fewer than two
 * candidates carry a WER (nothing to choose between); every candidate carries
 * the same WER (the human transcript does not separate them, so there is no
 * right answer to get wrong); or the picked provider itself has no WER (the
 * pick cannot be placed in the ordering at all). Same rule M-18 follows --
 * a call that measured nothing must not be reported as a call that agreed.
 *
 * Ties AT THE MINIMUM count as agreement: when two providers are equally best,
 * picking either one is not an error.
 */
export function aggregateJudgeAccuracy(rows: readonly JudgePickRow[]): JudgeAccuracyFigures {
  const byCall = new Map<string, JudgePickRow[]>();
  for (const row of rows) byCall.set(row.callId, [...(byCall.get(row.callId) ?? []), row]);

  let n = 0;
  let agreed = 0;

  for (const candidates of byCall.values()) {
    // Every row of a call carries the same pick -- it is a property of the
    // call's scan, not of the candidate.
    const pickedProviderId = candidates[0]!.pickedProviderId;

    // ONE value per provider, the mean of its cells: the same rule
    // aggregateProxyAgreement follows above, and for the same reason. A
    // provider can hold more than one scored cell on a call, and reading
    // whichever row came back first would make the answer depend on row
    // order. Found by a break test -- removing the run filter in the query
    // let a second cell through and nothing moved, because the duplicate was
    // simply never looked at.
    const werByProvider = new Map<string, number[]>();
    for (const candidate of candidates) {
      if (candidate.wer === null) continue;
      werByProvider.set(candidate.providerId, [...(werByProvider.get(candidate.providerId) ?? []), candidate.wer]);
    }
    const scored = [...werByProvider].map(([providerId, wers]) => ({ providerId, wer: mean(wers)! }));

    // No length guard: Math.min of nothing is Infinity and `every` over an
    // empty list is true, so a call with no scored candidate falls out here;
    // and a call with exactly ONE is uniformly equal to its own minimum, so
    // it falls out here too. A break test proved an explicit `< 2` check
    // could be deleted without a single test moving.
    const lowest = Math.min(...scored.map((candidate) => candidate.wer));
    if (scored.every((candidate) => candidate.wer === lowest)) continue;

    const picked = scored.find((candidate) => candidate.providerId === pickedProviderId);
    if (!picked) continue;
    n += 1;
    if (picked.wer === lowest) agreed += 1;
  }

  return { n, top1Agreement: n === 0 ? null : agreed / n };
}
