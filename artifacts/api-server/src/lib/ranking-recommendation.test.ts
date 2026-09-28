import { describe, expect, it } from "vitest";
import { rank1Recommendation, runnerUpRecommendation, withFailures } from "./ranking-recommendation";

const p = (name: string, flaggedCallRate: number | null, peerFlagsPer100Words: number | null = 0) => ({
  name,
  flaggedCallRate,
  peerFlagsPer100Words,
});

const SCOPE = "this assistant's 7 calls";

describe("rank1Recommendation", () => {
  it("opens with the group's own call count and makes no pick", () => {
    // R-4: the whole point. Every one of these sentences used to open
    // "Leading candidate for this assistant's calls" and close "Do not
    // treat as decision-grade" -- a pick and its retraction, on all 29
    // live assistant groups, 0 of which reach the >=12-call bar.
    const s = rank1Recommendation([p("Deepgram", 0.25), p("Cartesia", 0.5)], SCOPE);
    expect(s).toBe("On this assistant's 7 calls: fewest flagged calls Deepgram.");
  });

  it("names no leader and no decision in any branch", () => {
    for (const s of [
      rank1Recommendation([p("A", 0.25), p("B", 0.5)], SCOPE),
      rank1Recommendation([p("A", 0), p("B", 0)], SCOPE),
      rank1Recommendation([p("A", 0.5, 1), p("B", 0.5, 2)], SCOPE),
      rank1Recommendation([p("A", 0)], SCOPE),
      rank1Recommendation([p("A", null)], SCOPE),
    ]) {
      expect(s).not.toContain("Leading candidate");
      expect(s).not.toContain("decision-grade");
      expect(s).not.toContain("Confidence");
      expect(s).not.toContain("candidate");
    }
  });

  // R-2b: price does not rank, so the sentence never names it -- not even
  // as a side note next to a tie, which is where it used to decide rank 1.
  it("never mentions price", () => {
    for (const s of [
      rank1Recommendation([p("Cartesia", 0), p("Deepgram", 0), p("OpenAI", 0)], SCOPE),
      rank1Recommendation([p("A", 0.25), p("B", 0.5)], SCOPE),
      rank1Recommendation([p("A", 0.5, 1), p("B", 0.5, 2)], SCOPE),
    ]) {
      expect(s).not.toMatch(/cheap|price|cost/i);
    }
  });

  it("names nobody when every provider is tied on both keys", () => {
    // The live shape on bulk 42769f26: 1-2 calls per card, every provider
    // flagged on the same calls. Cartesia used to be rank 1 on price here.
    const s = rank1Recommendation([p("Cartesia", 0), p("Deepgram", 0), p("OpenAI", 0)], SCOPE);
    expect(s).toBe("On this assistant's 7 calls: every provider tied on flagged calls and disagreements per 100 words.");
    expect(s).not.toContain("Cartesia");
  });

  it("names the per-100-words leader when the flagged-call rate is tied", () => {
    const s = rank1Recommendation([p("Alpha", 0.5, 1.2), p("Bravo", 0.5, 3.4)], SCOPE);
    expect(s).toBe(
      "On this assistant's 7 calls: every provider tied on flagged calls, fewest disagreements per 100 words Alpha.",
    );
  });

  it("counts a partial flagged-call tie before naming the per-100-words leader", () => {
    const s = rank1Recommendation([p("Alpha", 0.5, 1.2), p("Bravo", 0.5, 3.4), p("Charlie", 1, 0)], SCOPE);
    expect(s).toContain("2 providers tied on flagged calls, fewest disagreements per 100 words Alpha");
  });

  it("counts a partial tie on both keys rather than naming one of the tied", () => {
    const s = rank1Recommendation([p("Alpha", 0), p("Bravo", 0), p("Charlie", 0.5)], SCOPE);
    expect(s).toContain("2 providers tied for fewest flagged calls and disagreements per 100 words");
    expect(s).not.toContain("Alpha");
  });

  it("does not make a comparison claim about a group of one", () => {
    const s = rank1Recommendation([p("Alpha", 0)], SCOPE);
    expect(s).toBe(
      "On this assistant's 7 calls: only Alpha produced a transcript to compare, so nothing here is a comparison.",
    );
    expect(s).not.toContain("fewest");
  });

  it("ignores providers with no flag evidence when judging the tie", () => {
    // A provider with no flagged-call rate sorts last and gets its own
    // sentence. It is not a rival that ties or beats.
    const s = rank1Recommendation([p("Alpha", 0), p("Ghost", null)], SCOPE);
    expect(s).toContain("only Alpha produced a transcript to compare");
  });

  it("says so when the group has no disagreement numbers at all", () => {
    const s = rank1Recommendation([p("Ghost", null)], SCOPE);
    expect(s).toBe("On this assistant's 7 calls: no disagreement numbers yet.");
  });

  it("names the no-assistant group with the phrase it is handed", () => {
    const s = rank1Recommendation([p("Alpha", 0), p("Bravo", 0.5)], "3 calls with no assistant on file");
    expect(s).toBe("On 3 calls with no assistant on file: fewest flagged calls Alpha.");
  });
});

describe("runnerUpRecommendation", () => {
  it("says behind when the runner-up was flagged on more of its calls", () => {
    const s = runnerUpRecommendation(p("A", 0.5), p("B", 0.25));
    expect(s).toBe("Behind rank 1: flagged on a larger share of its calls.");
  });

  it("says behind on per 100 words when the flagged-call rate is tied", () => {
    const s = runnerUpRecommendation(p("A", 0.5, 3), p("B", 0.5, 1));
    expect(s).toBe("Tied with rank 1 on flagged calls; behind it on disagreements per 100 words.");
  });

  it("calls a tie on both keys arbitrary rather than a loss", () => {
    // Cartesia, cleanest and cheapest, used to be the rank 1 of exactly this
    // tie; the runner-up was told it lost "on price alone".
    const s = runnerUpRecommendation(p("A", 0), p("B", 0));
    expect(s).toContain("this order is arbitrary");
    expect(s).not.toMatch(/price/i);
  });

  it("calls it arbitrary when a per-100-words figure is missing", () => {
    const s = runnerUpRecommendation(p("A", 0.5, null), p("B", 0.5, 2));
    expect(s).toContain("this order is arbitrary");
  });

  it("carries no confidence note, no decision claim and no price", () => {
    for (const s of [
      runnerUpRecommendation(p("A", 0.5), p("B", 0.25)),
      runnerUpRecommendation(p("A", null), p("B", 0.25)),
      runnerUpRecommendation(p("A", 0.5, 3), p("B", 0.5, 1)),
      runnerUpRecommendation(p("A", 0), p("B", 0)),
    ]) {
      expect(s).not.toContain("decision-grade");
      expect(s).not.toContain("Confidence");
      expect(s).not.toContain("hybrid flags");
      expect(s).not.toMatch(/cheap|price|cost/i);
    }
  });
});

describe("withFailures", () => {
  it("names the provider's failures after the sentence", () => {
    const s = withFailures("Behind rank 1: flagged on a larger share of its calls.", { ...p("Cartesia", 0.5), failedCalls: 2 });
    expect(s).toBe(
      "Behind rank 1: flagged on a larger share of its calls. Cartesia failed on 2 calls (timeout or server error); each counts as a flagged call.",
    );
  });

  it("leaves the sentence alone when nothing failed", () => {
    expect(withFailures("x.", p("A", 0))).toBe("x.");
    expect(withFailures("x.", { ...p("A", 0), failedCalls: 0 })).toBe("x.");
  });
});
