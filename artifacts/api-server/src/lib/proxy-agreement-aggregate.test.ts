import { describe, expect, it } from "vitest";

import {
  aggregateJudgeAccuracy,
  aggregateProxyAgreement,
  type JudgePickRow,
  type ProxyAgreementRow,
} from "./proxy-agreement-aggregate";

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

// M-20. The judge's pick has been shown as a verdict input since T-108 and
// never measured. Every case here is a way the measurement could lie.
const candidate = (
  callId: string,
  pickedProviderId: string,
  providerId: string,
  wer: number | null,
): JudgePickRow => ({ callId, pickedProviderId, providerId, wer });

describe("aggregateJudgeAccuracy (M-20)", () => {
  it("agrees when the judge picked the lowest-WER candidate", () => {
    expect(
      aggregateJudgeAccuracy([
        candidate("c1", "a", "a", 0.1),
        candidate("c1", "a", "b", 0.4),
      ]),
    ).toEqual({ n: 1, top1Agreement: 1 });
  });

  it("disagrees when it picked a worse one -- the live case", () => {
    // The one measurable call on the corpus 2026-09-09: the judge picked
    // openai (0.436) over deepgram (0.365). One call, zero agreement -- and
    // the figure must be able to say so rather than round it away.
    expect(
      aggregateJudgeAccuracy([
        candidate("c1", "openai", "gladia", 0.3974),
        candidate("c1", "openai", "assembly", 0.4103),
        candidate("c1", "openai", "deepgram", 0.3654),
        candidate("c1", "openai", "cartesia", 0.4423),
        candidate("c1", "openai", "openai", 0.4359),
      ]),
    ).toEqual({ n: 1, top1Agreement: 0 });
  });

  it("counts a tie at the minimum as agreement", () => {
    // Two providers equally best: picking either is not an error.
    expect(
      aggregateJudgeAccuracy([
        candidate("c1", "b", "a", 0.2),
        candidate("c1", "b", "b", 0.2),
        candidate("c1", "b", "c", 0.9),
      ]),
    ).toEqual({ n: 1, top1Agreement: 1 });
  });

  it("drops a call where the transcript separates nothing", () => {
    // Every candidate scored the same: there is no right answer to get
    // wrong, so this is not a call the judge agreed on -- it is not a call.
    expect(
      aggregateJudgeAccuracy([
        candidate("c1", "a", "a", 0.3),
        candidate("c1", "a", "b", 0.3),
      ]),
    ).toEqual({ n: 0, top1Agreement: null });
  });

  it("drops a call with only one scored candidate", () => {
    expect(
      aggregateJudgeAccuracy([candidate("c1", "a", "a", 0.1), candidate("c1", "a", "b", null)]),
    ).toEqual({ n: 0, top1Agreement: null });
  });

  it("drops a call whose picked provider was never scored", () => {
    // The pick cannot be placed in the ordering, so it can neither agree nor
    // disagree. Counting it as a miss would charge the judge for a gap in
    // the scoring.
    expect(
      aggregateJudgeAccuracy([
        candidate("c1", "z", "a", 0.1),
        candidate("c1", "z", "b", 0.4),
        candidate("c1", "z", "z", null),
      ]),
    ).toEqual({ n: 0, top1Agreement: null });
  });

  it("averages over calls, and a dropped call moves no average", () => {
    expect(
      aggregateJudgeAccuracy([
        // c1 agrees
        candidate("c1", "a", "a", 0.1),
        candidate("c1", "a", "b", 0.4),
        // c2 disagrees
        candidate("c2", "b", "a", 0.1),
        candidate("c2", "b", "b", 0.4),
        // c3 is all-tied and must not become a third call
        candidate("c3", "a", "a", 0.5),
        candidate("c3", "a", "b", 0.5),
      ]),
    ).toEqual({ n: 2, top1Agreement: 0.5 });
  });

  it("gives a provider one value per call, the mean of its cells", () => {
    // The picked provider holds two scored cells. Reading whichever row came
    // first would make the answer depend on row order: first row says 0.05
    // (best, agrees), second says 0.55 (worst, disagrees). The mean, 0.30, is
    // neither -- and it is the same rule aggregateProxyAgreement follows.
    expect(
      aggregateJudgeAccuracy([
        candidate("c1", "a", "a", 0.05),
        candidate("c1", "a", "a", 0.55),
        candidate("c1", "a", "b", 0.2),
      ]),
    ).toEqual({ n: 1, top1Agreement: 0 });
    // And the mirror: the same two cells make the pick best when the rival is
    // worse than their mean, so this is an average and not a "take the worst".
    expect(
      aggregateJudgeAccuracy([
        candidate("c2", "a", "a", 0.05),
        candidate("c2", "a", "a", 0.55),
        candidate("c2", "a", "b", 0.9),
      ]),
    ).toEqual({ n: 1, top1Agreement: 1 });
  });

  it("invents nothing with no picks at all", () => {
    expect(aggregateJudgeAccuracy([])).toEqual({ n: 0, top1Agreement: null });
  });
});
