import { describe, expect, it } from "vitest";

import { kendallTauB, sharesTop1 } from "./rank-agreement";

describe("kendallTauB", () => {
  it("is +1 on the same order and -1 on the reverse", () => {
    expect(kendallTauB([1, 2, 3, 4], [10, 20, 30, 40])).toBe(1);
    expect(kendallTauB([1, 2, 3, 4], [40, 30, 20, 10])).toBe(-1);
  });

  it("scores one swapped pair against the five that agree", () => {
    // 6 pairs, 5 concordant, 1 discordant, nothing tied: (5 - 1) / 6.
    expect(kendallTauB([1, 2, 3, 4], [1, 2, 4, 3])).toBeCloseTo(4 / 6, 10);
  });

  it("takes a tied pair out of the denominator instead of counting it against the score", () => {
    // 3 pairs; one tie in a; both remaining pairs concordant.
    // tau-b = 2 / sqrt((3 - 1) * 3) = 0.8165. tau-a would have said 2/3.
    const tau = kendallTauB([1, 1, 2], [1, 2, 3]);
    expect(tau).toBeCloseTo(2 / Math.sqrt(6), 10);
    expect(tau).toBeGreaterThan(2 / 3);
  });

  it("counts a pair tied on both sides out of both denominators", () => {
    // Every pair tied on both sides -> nothing orderable -> null, not 0.
    expect(kendallTauB([1, 1, 1], [4, 4, 4])).toBeNull();
  });

  it("is null when one side is a single tie group, so the caller drops the call", () => {
    expect(kendallTauB([1, 2, 3], [5, 5, 5])).toBeNull();
    expect(kendallTauB([5, 5, 5], [1, 2, 3])).toBeNull();
  });

  it("is null below two providers -- one provider is not a ranking", () => {
    expect(kendallTauB([1], [1])).toBeNull();
    expect(kendallTauB([], [])).toBeNull();
  });

  it("refuses two orderings of different lengths rather than aligning them by index", () => {
    expect(() => kendallTauB([1, 2], [1])).toThrow(/same providers/);
  });
});

describe("sharesTop1", () => {
  it("is true when the same provider is best on both sides", () => {
    expect(sharesTop1([1, 2, 3], [1, 5, 5])).toBe(true);
  });

  it("is false when the best on one side is not among the best on the other", () => {
    expect(sharesTop1([1, 2, 3], [9, 1, 1])).toBe(false);
  });

  it("reads a tie for best as a set, so a provider tied for best on one side still counts", () => {
    expect(sharesTop1([1, 1, 3], [7, 2, 9])).toBe(true);
  });

  it("is false on nothing at all", () => {
    expect(sharesTop1([], [])).toBe(false);
  });
});
