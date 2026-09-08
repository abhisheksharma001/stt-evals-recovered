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
 * A call is DROPPED, not counted as agreement, when:
 *   - fewer than two providers carry both a WER and a flag reading, or
 *   - either ordering is a single tie group (kendallTauB returns null).
 * Both mean the call distinguishes nothing, and "absent is not zero": a call
 * that measured nothing must not be reported as a call that agreed.
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
    if (wers.length < 2) continue;
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
