import { describe, expect, it } from "vitest";

import { aggregateProxyAgreement, type ProxyAgreementRow } from "./proxy-agreement-aggregate";

const cell = (
  callId: string,
  providerId: string,
  wer: number | null,
  peerFlagCount: number | null,
  peerFlagSeverity: string | null = "none",
): ProxyAgreementRow => ({ callId, providerId, wer, peerFlagCount, peerFlagSeverity });

describe("aggregateProxyAgreement", () => {
  it("reports perfect agreement when both orderings put the providers the same way", () => {
    expect(
      aggregateProxyAgreement([
        cell("c1", "a", 0.1, 1),
        cell("c1", "b", 0.2, 2),
        cell("c1", "c", 0.3, 3),
      ]),
    ).toEqual({ n: 1, kendallTau: 1, top1Agreement: 1 });
  });

  it("reports the reverse as -1, and no shared top-1", () => {
    expect(
      aggregateProxyAgreement([
        cell("c1", "a", 0.1, 3),
        cell("c1", "b", 0.2, 2),
        cell("c1", "c", 0.3, 1),
      ]),
    ).toEqual({ n: 1, kendallTau: -1, top1Agreement: 0 });
  });

  it("averages a provider's cells across runs instead of taking whichever came first", () => {
    // The live shape: one call sits in several runs, and provider "a" scored
    // 0.05 in one and 1.95 in another. Averaged, a (1.00) is worse than
    // b (0.50) and the two orderings agree. Taking a's first cell would put
    // a first and report the exact opposite.
    const figures = aggregateProxyAgreement([
      cell("c1", "a", 0.05, 1),
      cell("c1", "a", 1.95, 1),
      cell("c1", "b", 0.5, 0),
    ]);
    expect(figures).toEqual({ n: 1, kendallTau: 1, top1Agreement: 1 });
  });

  it("folds flag severity into the disagreement ordering, not just the count", () => {
    // a has no flags but a high-severity one recorded (badness 0 + 3);
    // b has one flag at no severity (badness 1 + 0). b is the better of the
    // two, which agrees with b's lower WER. Counting flags alone would rank
    // a first and report disagreement.
    expect(
      aggregateProxyAgreement([cell("c1", "a", 0.5, 0, "high"), cell("c1", "b", 0.1, 1, "none")]),
    ).toEqual({ n: 1, kendallTau: 1, top1Agreement: 1 });
  });

  it("drops a call whose disagreement ordering is entirely tied rather than scoring it as agreement", () => {
    // Every provider identical on flags: the call distinguishes nothing.
    // Counting it would inflate the figure with calls that measured nothing.
    expect(
      aggregateProxyAgreement([
        cell("c1", "a", 0.1, 0),
        cell("c1", "b", 0.2, 0),
        cell("c1", "c", 0.3, 0),
      ]),
    ).toEqual({ n: 0, kendallTau: null, top1Agreement: null });
  });

  it("drops a call with fewer than two rankable providers", () => {
    expect(aggregateProxyAgreement([cell("c1", "a", 0.1, 1)])).toEqual({
      n: 0,
      kendallTau: null,
      top1Agreement: null,
    });
  });

  it("drops a provider missing a WER from BOTH orderings, not just the one it is missing from", () => {
    // c has no gold-scored WER. If it stayed on the disagreement side it
    // would be the best there (0 flags) while a is best on WER, and the call
    // would wrongly report no shared top-1 -- comparing two orderings over
    // different providers.
    expect(
      aggregateProxyAgreement([
        cell("c1", "a", 0.1, 1),
        cell("c1", "b", 0.2, 2),
        cell("c1", "c", null, 0),
      ]),
    ).toEqual({ n: 1, kendallTau: 1, top1Agreement: 1 });
  });

  it("treats a cell with no flag reading at all as absent, not as zero flags", () => {
    // a has the lowest WER but no flag reading of any kind, so it leaves both
    // orderings and b and c are compared alone -- they agree, and b is best
    // on both. Read as "zero flags" instead, a would have been best on the
    // disagreement side while b was best on WER, and this would report no
    // shared top-1. The difference between absent and zero is the assertion.
    expect(
      aggregateProxyAgreement([
        cell("c1", "a", 0.1, null, null),
        cell("c1", "b", 0.2, 2),
        cell("c1", "c", 0.3, 3),
      ]),
    ).toEqual({ n: 1, kendallTau: 1, top1Agreement: 1 });
  });

  it("averages over the calls that contributed, and reports nulls when none did", () => {
    const figures = aggregateProxyAgreement([
      // agrees
      cell("c1", "a", 0.1, 1),
      cell("c1", "b", 0.2, 2),
      // disagrees
      cell("c2", "a", 0.1, 2),
      cell("c2", "b", 0.2, 1),
      // all tied on flags -- dropped, so it must not pull the mean toward 0
      cell("c3", "a", 0.1, 5),
      cell("c3", "b", 0.2, 5),
    ]);
    expect(figures).toEqual({ n: 2, kendallTau: 0, top1Agreement: 0.5 });

    expect(aggregateProxyAgreement([])).toEqual({ n: 0, kendallTau: null, top1Agreement: null });
  });
});
