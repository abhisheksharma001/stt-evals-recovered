import { describe, expect, it } from "vitest";

import { kendallTauB, sharesTop1, spearmanPermutationP, spearmanRho } from "./rank-agreement";

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

describe("spearmanRho", () => {
  it("is +1 on the same order and -1 on the reverse", () => {
    expect(spearmanRho([1, 2, 3, 4], [10, 20, 30, 40])).toBeCloseTo(1, 10);
    expect(spearmanRho([1, 2, 3, 4], [40, 30, 20, 10])).toBeCloseTo(-1, 10);
  });

  it("averages tied ranks instead of breaking the tie by position", () => {
    // a's ranks are [1.5, 1.5, 3]; b's are [1, 2, 3]. Deviations from the
    // mean rank 2: [-0.5, -0.5, 1] and [-1, 0, 1]. Covariance 1.5, variances
    // 1.5 and 2, so rho = 1.5 / sqrt(3) = 0.8660. Ordinal ranks would say 1.
    expect(spearmanRho([0.1, 0.1, 0.2], [3, 4, 5])).toBeCloseTo(1.5 / Math.sqrt(3), 10);
  });

  it("is null when one side is a single tie group, so the caller reports nothing measured", () => {
    expect(spearmanRho([1, 2, 3], [5, 5, 5])).toBeNull();
  });

  it("is null below three providers", () => {
    expect(spearmanRho([1, 2], [1, 2])).toBeNull();
  });

  it("refuses two orderings of different lengths", () => {
    expect(() => spearmanRho([1, 2, 3], [1, 2])).toThrow(/same providers/);
  });
});

describe("spearmanPermutationP", () => {
  it("matches the exact count for n = 7 with no ties: rho = 5/7 gives p = 222/5040", () => {
    // Two swaps (1<->3 and 4<->6) give sum d^2 = 16, rho = 1 - 6*16/336 = 5/7.
    const a = [1, 2, 3, 4, 5, 6, 7];
    const b = [3, 2, 1, 6, 5, 4, 7];
    expect(spearmanRho(a, b)).toBeCloseTo(5 / 7, 10);
    expect(spearmanPermutationP(a, b)).toBeCloseTo(222 / 5040, 10);
  });

  it("is 1/n! for a perfect order with no ties", () => {
    expect(spearmanPermutationP([1, 2, 3, 4], [1, 2, 3, 4])).toBeCloseTo(1 / 24, 10);
  });

  it("is null when rho is null", () => {
    expect(spearmanPermutationP([1, 2, 3], [5, 5, 5])).toBeNull();
  });

  it("refuses above n = 9 rather than approximating", () => {
    const ten = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10];
    expect(() => spearmanPermutationP(ten, ten)).toThrow(/n = 9/);
  });
});
