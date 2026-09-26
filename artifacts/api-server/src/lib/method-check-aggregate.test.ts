import { describe, expect, it } from "vitest";

import { aggregateMethodCheck, methodCheckVerdict, type MethodCheckRow } from "./method-check-aggregate";

// Every call has 100 hypothesis words on every provider, so the R-1 word
// basis is 100 and flags per 100 words equals the flag count.
const cell = (
  callId: string,
  providerId: string,
  errors: number | null,
  peerFlagCount: number | null,
  referenceWords: number | null = 100,
): MethodCheckRow => ({ callId, providerId, errors, referenceWords, peerFlagCount, words: 100 });

describe("methodCheckVerdict", () => {
  it("reads the four cases off rho and p", () => {
    expect(methodCheckVerdict(0.8, 0.01)).toBe("agrees");
    expect(methodCheckVerdict(0.3, 0.3)).toBe("weak");
    expect(methodCheckVerdict(0, 0.5)).toBe("disagrees");
    expect(methodCheckVerdict(-0.5, 0.9)).toBe("disagrees");
    expect(methodCheckVerdict(null, null)).toBe("not_measurable");
  });
});

describe("aggregateMethodCheck", () => {
  it("pools WER as total errors over total gold words, not a mean of per-call WERs", () => {
    // Provider a: 1 error in 10 words, 0 in 90 -> pooled 1/100 = 0.01.
    // A mean of per-call WERs would say (0.1 + 0) / 2 = 0.05.
    const figures = aggregateMethodCheck([
      cell("c1", "a", 1, 0, 10),
      cell("c2", "a", 0, 0, 90),
      cell("c1", "b", 2, 1, 10),
      cell("c2", "b", 2, 1, 90),
      cell("c1", "c", 3, 2, 10),
      cell("c2", "c", 3, 2, 90),
    ]);
    expect(figures.providers.find((p) => p.providerId === "a")?.wer).toBeCloseTo(0.01, 10);
    expect(figures.providers.find((p) => p.providerId === "a")?.calls).toBe(2);
  });

  it("orders the same way on both sides: rho 1 and the verdict follows p", () => {
    const figures = aggregateMethodCheck([
      cell("c1", "a", 1, 1),
      cell("c1", "b", 2, 2),
      cell("c1", "c", 3, 3),
      cell("c1", "d", 4, 4),
    ]);
    expect(figures.n).toBe(4);
    expect(figures.rho).toBeCloseTo(1, 10);
    // Only the one ordering of 24 reaches rho 1.
    expect(figures.pOneSided).toBeCloseTo(1 / 24, 10);
    expect(figures.verdict).toBe("agrees");
  });

  it("leaves a provider with no flag reading out of n instead of scoring it clean", () => {
    const figures = aggregateMethodCheck([
      cell("c1", "a", 1, 1),
      cell("c1", "b", 2, 2),
      cell("c1", "c", 3, 3),
      cell("c1", "d", 4, null),
    ]);
    expect(figures.providers.map((p) => p.providerId)).toEqual(["a", "b", "c"]);
    expect(figures.n).toBe(3);
  });

  it("is not_measurable when every provider ties on flags", () => {
    const figures = aggregateMethodCheck([cell("c1", "a", 1, 2), cell("c1", "b", 2, 2), cell("c1", "c", 3, 2)]);
    expect(figures.rho).toBeNull();
    expect(figures.pOneSided).toBeNull();
    expect(figures.verdict).toBe("not_measurable");
  });

  it("is not_measurable on nothing at all", () => {
    expect(aggregateMethodCheck([])).toEqual({ providers: [], n: 0, rho: null, pOneSided: null, verdict: "not_measurable" });
  });
});
