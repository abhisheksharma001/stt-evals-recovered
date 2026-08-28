import { describe, expect, it } from "vitest";
import { computeProviderCorrelation, pairwiseAgreement } from "./provider-correlation";

describe("pairwiseAgreement", () => {
  it("is 1 for identical text after normalisation", () => {
    expect(pairwiseAgreement("Hello, World!", "hello world")).toBe(1);
  });
  it("is 0 when nothing aligns", () => {
    expect(pairwiseAgreement("one two", "three four")).toBe(0);
  });
  it("counts a single substitution against the aligned length", () => {
    expect(pairwiseAgreement("the power is out", "the power was out")).toBe(0.75);
  });
  it("treats two empty transcripts as full agreement", () => {
    expect(pairwiseAgreement("", "")).toBe(1);
  });
});

describe("computeProviderCorrelation", () => {
  it("averages per-call agreement over the calls a pair shares", () => {
    const out = computeProviderCorrelation([
      { callId: "c1", transcripts: [{ providerId: "a", transcript: "x y z w" }, { providerId: "b", transcript: "x y z w" }] },
      { callId: "c2", transcripts: [{ providerId: "a", transcript: "x y z w" }, { providerId: "b", transcript: "x y q w" }] },
    ]);
    expect(out.providerIds).toEqual(["a", "b"]);
    expect(out.callCount).toBe(2);
    expect(out.pairs).toEqual([{ providerAId: "a", providerBId: "b", sharedCalls: 2, agreement: 0.875, excessAgreement: null }]);
  });

  it("reports null, not 0, for a pair that never shared a call", () => {
    const out = computeProviderCorrelation([
      { callId: "c1", transcripts: [{ providerId: "a", transcript: "x" }] },
      { callId: "c2", transcripts: [{ providerId: "b", transcript: "x" }] },
    ]);
    expect(out.pairs).toEqual([{ providerAId: "a", providerBId: "b", sharedCalls: 0, agreement: null, excessAgreement: null }]);
  });

  it("emits every pair once, ordered, regardless of input order", () => {
    const out = computeProviderCorrelation([
      { callId: "c1", transcripts: [{ providerId: "c", transcript: "x" }, { providerId: "a", transcript: "x" }, { providerId: "b", transcript: "x" }] },
    ]);
    expect(out.pairs.map((p) => `${p.providerAId}-${p.providerBId}`)).toEqual(["a-b", "a-c", "b-c"]);
  });

  it("counts a call once per pair even if a provider appears twice on it", () => {
    const out = computeProviderCorrelation([
      { callId: "c1", transcripts: [{ providerId: "a", transcript: "x" }, { providerId: "a", transcript: "y" }, { providerId: "b", transcript: "x" }] },
    ]);
    expect(out.pairs[0]).toEqual({ providerAId: "a", providerBId: "b", sharedCalls: 1, agreement: 1, excessAgreement: null });
  });

  it("gives a shared-engine pair positive excess and independent pairs about zero", () => {
    // a and b are copies of each other; c differs from both by the same amount.
    const out = computeProviderCorrelation([
      {
        callId: "c1",
        transcripts: [
          { providerId: "a", transcript: "one two three four" },
          { providerId: "b", transcript: "one two three four" },
          { providerId: "c", transcript: "one two three five" },
        ],
      },
    ]);
    const byKey = Object.fromEntries(out.pairs.map((p) => [`${p.providerAId}-${p.providerBId}`, p]));
    // a-b agree 1.0; each agrees 0.75 with c -> excess = 1 - 0.75 = 0.25
    expect(byKey["a-b"]!.excessAgreement).toBeCloseTo(0.25);
    // a-c agree 0.75; a's baseline without c = a-b = 1; c's baseline without a = c-b = 0.75
    // -> 0.75 - (1 + 0.75) / 2 = -0.125
    expect(byKey["a-c"]!.excessAgreement).toBeCloseTo(-0.125);
    expect(byKey["b-c"]!.excessAgreement).toBeCloseTo(-0.125);
  });
});
