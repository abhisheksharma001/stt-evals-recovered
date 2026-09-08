import { describe, expect, it } from "vitest";
import { rank1Recommendation, runnerUpRecommendation } from "./ranking-recommendation";

const p = (name: string, flagBadness: number | null, costPerMinute: number | null) => ({
  name,
  flagBadness,
  costPerMinute,
});

const SCOPE = "this assistant's 7 calls";

describe("rank1Recommendation", () => {
  it("opens with the group's own call count and makes no pick", () => {
    // R-4: the whole point. Every one of these sentences used to open
    // "Leading candidate for this assistant's calls" and close "Do not
    // treat as decision-grade" -- a pick and its retraction, on all 29
    // live assistant groups, 0 of which reach the >=12-call bar.
    const s = rank1Recommendation([p("Deepgram", 0.5, 0.006), p("Cartesia", 1.5, 0.002)], SCOPE);
    expect(s).toBe("On this assistant's 7 calls: fewest disagreements Deepgram, cheapest Cartesia.");
  });

  it("names no leader and no decision in any branch", () => {
    for (const s of [
      rank1Recommendation([p("A", 0.5, 0.006), p("B", 1.5, 0.002)], SCOPE),
      rank1Recommendation([p("A", 0, 0.002), p("B", 0, 0.002)], SCOPE),
      rank1Recommendation([p("A", 1, null), p("B", 1, 0.006)], SCOPE),
      rank1Recommendation([p("A", 0, 0.004)], SCOPE),
      rank1Recommendation([p("A", null, 0.004)], SCOPE),
    ]) {
      expect(s).not.toContain("Leading candidate");
      expect(s).not.toContain("decision-grade");
      expect(s).not.toContain("Confidence");
      expect(s).not.toContain("candidate");
    }
  });

  it("names the cleanest only when it is strictly the cleanest", () => {
    const s = rank1Recommendation(
      [p("Deepgram", 0.5, 0.006), p("Cartesia", 1.5, 0.002), p("OpenAI", 2, 0.01)],
      SCOPE,
    );
    expect(s).toContain("fewest disagreements Deepgram");
  });

  it("names nobody when every provider is tied on disagreements", () => {
    // The live shape on 2026-09-07: 33 of 62 groups had every provider
    // tied. "Fewest" was false on all of them.
    const s = rank1Recommendation(
      [p("Cartesia", 0, 0.0022), p("Deepgram", 0, 0.0043), p("OpenAI", 0, 0.0102)],
      SCOPE,
    );
    expect(s).toBe(
      "On this assistant's 7 calls: every provider raised the same disagreements, cheapest Cartesia.",
    );
    expect(s).not.toContain("fewest disagreements Cartesia");
  });

  it("counts a partial tie rather than naming one of the tied", () => {
    const s = rank1Recommendation(
      [p("Cartesia", 0, 0.0022), p("Deepgram", 0, 0.0043), p("OpenAI", 2, 0.0102)],
      SCOPE,
    );
    expect(s).toContain("2 providers tied for fewest disagreements");
    expect(s).not.toContain("fewest disagreements Cartesia");
  });

  it("treats an unknown price as unknown, not as the cheapest", () => {
    // hybridCompositeScore scores a null costPerMinute as the best possible
    // cost component. The sentence must not inherit that -- nobody knows
    // what that provider costs.
    const s = rank1Recommendation([p("Alpha", 1, null), p("Bravo", 2, 0.006)], SCOPE);
    expect(s).toContain("no price on file for every provider");
    expect(s).not.toContain("cheapest");
  });

  it("names nobody as cheapest when every price is the same", () => {
    const s = rank1Recommendation([p("Alpha", 0, 0.004), p("Bravo", 1, 0.004)], SCOPE);
    expect(s).toContain("every provider costs the same per minute");
    expect(s).not.toContain("cheapest Alpha");
  });

  it("counts a partial price tie rather than naming one of the tied", () => {
    const s = rank1Recommendation(
      [p("Alpha", 0, 0.004), p("Bravo", 1, 0.004), p("Charlie", 2, 0.009)],
      SCOPE,
    );
    expect(s).toContain("2 providers tied on price");
  });

  it("does not make a comparison claim about a group of one", () => {
    const s = rank1Recommendation([p("Alpha", 0, 0.004)], SCOPE);
    expect(s).toBe(
      "On this assistant's 7 calls: only Alpha produced a transcript to compare, so nothing here is a comparison.",
    );
    expect(s).not.toContain("fewest");
  });

  it("ignores providers with no flag evidence when judging the tie", () => {
    // A provider whose every cell failed has a null composite, sorts last,
    // and gets its own sentence. It is not a rival that ties or beats.
    const s = rank1Recommendation([p("Alpha", 0, 0.004), p("Ghost", null, 0.002)], SCOPE);
    expect(s).toContain("only Alpha produced a transcript to compare");
  });

  it("says so when the group has no disagreement numbers at all", () => {
    const s = rank1Recommendation([p("Ghost", null, 0.002)], SCOPE);
    expect(s).toBe("On this assistant's 7 calls: no disagreement numbers yet.");
  });

  it("names the no-assistant group with the phrase it is handed", () => {
    const s = rank1Recommendation(
      [p("Alpha", 0, 0.004), p("Bravo", 1, 0.006)],
      "3 calls with no assistant on file",
    );
    expect(s).toBe(
      "On 3 calls with no assistant on file: fewest disagreements Alpha, cheapest Alpha.",
    );
  });
});

describe("runnerUpRecommendation", () => {
  it("does not claim more disagreements when the runner-up is tied", () => {
    // cartesia-ink-whisper, cleanest and cheapest, was labelled "more or
    // more-severe flags" on every one of the 33 all-tied live groups.
    const s = runnerUpRecommendation(p("A", 0, 0.0022), p("B", 0, 0.0043));
    expect(s).not.toContain("more or more-severe");
    expect(s).toContain("Tied with rank 1 on disagreements");
  });

  it("says the runner-up lost on price when it is actually cleaner", () => {
    const s = runnerUpRecommendation(p("A", 4.0, 0.0022), p("B", 4.5, 0.0043));
    expect(s).toContain("Ranked below rank 1 on price, not on accuracy");
    expect(s).toContain("fewer or less-severe disagreements than rank 1");
  });

  it("keeps the claim when the runner-up really is noisier", () => {
    const s = runnerUpRecommendation(p("A", 3, 0.002), p("B", 1, 0.006));
    expect(s).toContain("Behind rank 1 on disagreements");
  });

  it("no longer blames confidence spans, which T-2 removed from the composite", () => {
    for (const s of [
      runnerUpRecommendation(p("A", 3, 0.002), p("B", 1, 0.006)),
      runnerUpRecommendation(p("A", 0, 0.002), p("B", 0, 0.006)),
      runnerUpRecommendation(p("A", 0, 0.002), p("B", 1, 0.006)),
    ]) {
      expect(s).not.toContain("confidence");
    }
  });

  it("calls a disagreement-and-price tie arbitrary rather than a loss", () => {
    const s = runnerUpRecommendation(p("A", 2, 0.004), p("B", 2, 0.004));
    expect(s).toContain("this order is arbitrary");
  });

  it("carries no confidence note and no decision claim", () => {
    for (const s of [
      runnerUpRecommendation(p("A", 3, 0.002), p("B", 1, 0.006)),
      runnerUpRecommendation(p("A", null, 0.002), p("B", 1, 0.006)),
      runnerUpRecommendation(p("A", 2, 0.004), p("B", 2, 0.004)),
    ]) {
      expect(s).not.toContain("decision-grade");
      expect(s).not.toContain("Confidence");
      expect(s).not.toContain("hybrid flags");
    }
  });
});
