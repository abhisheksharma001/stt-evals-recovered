import { describe, expect, it } from "vitest";
import { rank1Recommendation, runnerUpRecommendation } from "./ranking-recommendation";

const p = (flagBadness: number | null, costPerMinute: number | null) => ({
  flagBadness,
  costPerMinute,
});

const GROUP = "this assistant's calls";

describe("rank1Recommendation", () => {
  it("claims fewest flags only when rank 1 is strictly the cleanest", () => {
    const s = rank1Recommendation([p(0.5, 0.006), p(1.5, 0.002), p(2, 0.01)], GROUP);
    expect(s).toBe(
      "Leading candidate for this assistant's calls -- fewest/least-severe hybrid flags among ready providers.",
    );
  });

  it("never claims fewest flags when rank 1 only tied for fewest", () => {
    // The live shape on 2026-09-07: 59 of 62 groups had rank 1 tied for
    // fewest, 33 of them with every provider tied. This is the sentence
    // that was false on 61 of 62 groups.
    const s = rank1Recommendation([p(0, 0.0022), p(0, 0.0043), p(0, 0.0102)], GROUP);
    expect(s).not.toContain("fewest");
    expect(s).toBe(
      "Leading candidate for this assistant's calls -- tied on hybrid flags with 2 other providers and the cheapest of the tied. Price decided this order, not accuracy.",
    );
  });

  it("says so when rank 1 won despite raising more flags than a rival", () => {
    // deepgram-nova-3 at 4.5 flags / $0.0043 ranked above cartesia at
    // 4.0 flags / $0.0022 in 2 live groups.
    const s = rank1Recommendation([p(4.5, 0.0043), p(4.0, 0.0022), p(4.5, 0.006)], GROUP);
    expect(s).not.toContain("fewest");
    expect(s).toContain("1 other provider raised fewer or less-severe hybrid flags");
    expect(s).toContain("this is not an accuracy win");
  });

  it("calls the order arbitrary when flags and price both tie", () => {
    const s = rank1Recommendation([p(2, 0.004), p(2, 0.004)], GROUP);
    expect(s).toContain("this order is arbitrary");
    expect(s).toContain("Do not read rank 1 as a pick");
    expect(s).not.toContain("Leading candidate");
  });

  it("treats an unknown price as unknown, not as the cheapest", () => {
    // hybridCompositeScore scores a null costPerMinute as the best possible
    // cost component. The sentence must not inherit that -- nobody knows
    // what this provider costs, so nothing can be said to have decided it.
    const s = rank1Recommendation([p(1, null), p(1, 0.006)], GROUP);
    expect(s).toContain("this order is arbitrary");
    expect(s).not.toContain("cheapest");
  });

  it("does not make a comparison claim about a group of one", () => {
    const s = rank1Recommendation([p(0, 0.004)], GROUP);
    expect(s).toBe(
      "Only candidate for this assistant's calls -- one provider ran, so this is not a comparison.",
    );
    expect(s).not.toContain("fewest");
  });

  it("ignores providers with no flag evidence when judging the tie", () => {
    // A provider whose every cell failed has a null composite, sorts last,
    // and gets its own sentence. It is not a rival that ties or beats.
    const s = rank1Recommendation([p(0, 0.004), p(null, 0.002)], GROUP);
    expect(s).toContain("one provider ran");
  });

  it("names the no-assistant group with the phrase it is handed", () => {
    const s = rank1Recommendation([p(0, 0.004), p(1, 0.006)], "calls with no assistant on file");
    expect(s).toContain("calls with no assistant on file");
  });
});

describe("runnerUpRecommendation", () => {
  it("does not claim more flags when the runner-up is tied on flags", () => {
    // cartesia-ink-whisper, cleanest and cheapest, was labelled "more or
    // more-severe flags" on every one of the 33 all-tied live groups.
    const s = runnerUpRecommendation(p(0, 0.0022), p(0, 0.0043));
    expect(s).not.toContain("more or more-severe");
    expect(s).toContain("Tied with rank 1 on hybrid flags");
  });

  it("says the runner-up lost on price when it is actually cleaner", () => {
    const s = runnerUpRecommendation(p(4.0, 0.0022), p(4.5, 0.0043));
    expect(s).toContain("Ranked below rank 1 on price, not on accuracy");
    expect(s).toContain("fewer or less-severe hybrid flags than rank 1");
  });

  it("keeps the flag claim when the runner-up really is flaggier", () => {
    const s = runnerUpRecommendation(p(3, 0.002), p(1, 0.006));
    expect(s).toContain("Behind rank 1 on hybrid flags");
  });

  it("no longer blames confidence spans, which T-2 removed from the composite", () => {
    for (const s of [
      runnerUpRecommendation(p(3, 0.002), p(1, 0.006)),
      runnerUpRecommendation(p(0, 0.002), p(0, 0.006)),
      runnerUpRecommendation(p(0, 0.002), p(1, 0.006)),
    ]) {
      expect(s).not.toContain("confidence");
    }
  });

  it("calls a flag-and-price tie arbitrary rather than a loss", () => {
    const s = runnerUpRecommendation(p(2, 0.004), p(2, 0.004));
    expect(s).toContain("this order is arbitrary");
  });
});
