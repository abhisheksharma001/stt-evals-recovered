import { describe, expect, it } from "vitest";
import {
  computeCrossProviderDisagreement,
  computeEntityMismatches,
  extractEntities,
  flagLowConfidenceSpans,
  combineHybridFlags,
} from "./hybrid";

describe("computeCrossProviderDisagreement", () => {
  it("scores an outlier provider higher than the majority", () => {
    const result = computeCrossProviderDisagreement([
      { providerId: "a", transcript: "the truck needs a new part" },
      { providerId: "b", transcript: "the truck needs a new part" },
      { providerId: "c", transcript: "the duck needs a blue heart" },
    ]);
    const byId = Object.fromEntries(result.map((r) => [r.providerId, r]));
    expect(byId.a!.disagreementRate).toBeLessThan(byId.c!.disagreementRate);
    expect(byId.b!.disagreementRate).toBeLessThan(byId.c!.disagreementRate);
  });

  it("returns zero disagreement with fewer than 2 candidates", () => {
    const result = computeCrossProviderDisagreement([{ providerId: "a", transcript: "hello" }]);
    expect(result[0]!.disagreementRate).toBe(0);
  });

  it("returns zero for identical transcripts", () => {
    const result = computeCrossProviderDisagreement([
      { providerId: "a", transcript: "call the driver now" },
      { providerId: "b", transcript: "call the driver now" },
    ]);
    expect(result.every((r) => r.disagreementRate === 0)).toBe(true);
  });

  // T-4 (base-solidity fix): the old pairwise scheme made every PERFECT
  // provider absorb up to 1/(n-1) of an outlier's badness just by sharing a
  // run with it. Consensus voting must score the agreeing majority at
  // exactly zero regardless of how many outliers are in the run.
  it("scores three identical providers at zero disagreement even with a wildly different fourth", () => {
    const result = computeCrossProviderDisagreement([
      { providerId: "a", transcript: "the driver arrived at the loading dock early" },
      { providerId: "b", transcript: "the driver arrived at the loading dock early" },
      { providerId: "c", transcript: "the driver arrived at the loading dock early" },
      { providerId: "d", transcript: "purple weather bicycle jumping over nine clouds today" },
    ]);
    const byId = Object.fromEntries(result.map((r) => [r.providerId, r]));
    expect(byId.a!.disagreementRate).toBe(0);
    expect(byId.b!.disagreementRate).toBe(0);
    expect(byId.c!.disagreementRate).toBe(0);
    expect(byId.d!.disagreementRate).toBeGreaterThan(0);
  });
});

describe("extractEntities", () => {
  it("extracts a phone number", () => {
    const entities = extractEntities("call me at 555-123-4567 tomorrow");
    expect(entities).toContainEqual({ type: "phone_number", value: "5551234567", raw: "555-123-4567" });
  });

  it("extracts a plausible VIN (mixed letters and digits, 17 chars)", () => {
    const entities = extractEntities("the VIN is 1HGCM82633A004352 on file");
    expect(entities.some((e) => e.type === "vin" && e.value === "1HGCM82633A004352")).toBe(true);
  });

  it("does not flag a 17-digit or 17-letter run as a VIN", () => {
    const allDigits = extractEntities("tracking number 12345678901234567 confirmed");
    expect(allDigits.some((e) => e.type === "vin")).toBe(false);
  });

  it("extracts a reference number after a domain keyword", () => {
    const entities = extractEntities("please check on unit 4B for me");
    expect(entities.some((e) => e.type === "reference_number" && e.value === "4B")).toBe(true);
  });

  // T-5 (base-solidity fix): a provider that spells numbers out must be
  // able to produce the SAME entity as one that formats them -- otherwise
  // it can never be flagged for getting a reference/phone number wrong
  // (stacks with T-3: silence beats a near-miss).
  it("extracts a phone number from spelled-out spoken digits", () => {
    const entities = extractEntities("call five five five one two three one two one two now");
    expect(entities).toContainEqual({ type: "phone_number", value: "5551231212", raw: "5551231212" });
  });

  it("extracts a reference number from spelled-out spoken digits", () => {
    const entities = extractEntities("please check on unit four four seven one for me");
    expect(entities.some((e) => e.type === "reference_number" && e.value === "4471")).toBe(true);
  });
});

describe("computeEntityMismatches", () => {
  it("flags providers that extracted different values for the same entity type", () => {
    const mismatches = computeEntityMismatches([
      { providerId: "a", transcript: "call 555-123-4567 please" },
      { providerId: "b", transcript: "call 555-123-4568 please" },
    ]);
    expect(mismatches).toHaveLength(1);
    expect(mismatches[0]!.type).toBe("phone_number");
  });

  it("does not flag agreement", () => {
    const mismatches = computeEntityMismatches([
      { providerId: "a", transcript: "call 555-123-4567 please" },
      { providerId: "b", transcript: "call 555-123-4567 please" },
    ]);
    expect(mismatches).toHaveLength(0);
  });

  it("does not flag when only one provider mentions the entity at all", () => {
    const mismatches = computeEntityMismatches([
      { providerId: "a", transcript: "call 555-123-4567 please" },
      { providerId: "b", transcript: "no numbers here at all" },
    ]);
    expect(mismatches).toHaveLength(0);
  });

  // T-3 (base-solidity fix): a provider that DROPS an entity entirely must
  // not score better than one that got it slightly wrong. Needs 3+
  // providers (2 is just a disagreement, not corroboration).
  it("flags a provider that mentions nothing when the other two agree", () => {
    const mismatches = computeEntityMismatches([
      { providerId: "a", transcript: "please check on unit 4471 for me" },
      { providerId: "b", transcript: "please check on unit 4471 for me" },
      { providerId: "c", transcript: "please check on that vehicle for me" },
    ]);
    expect(mismatches).toHaveLength(1);
    expect(mismatches[0]!.missingProviderIds).toEqual(["c"]);
  });

  it("does not flag missing when fewer than 3 providers ran", () => {
    const mismatches = computeEntityMismatches([
      { providerId: "a", transcript: "please check on unit 4471 for me" },
      { providerId: "b", transcript: "please check on that vehicle for me" },
    ]);
    expect(mismatches).toHaveLength(0);
  });
});

describe("flagLowConfidenceSpans", () => {
  it("flags a single very-low-confidence word", () => {
    const spans = flagLowConfidenceSpans([
      { word: "the", confidence: 0.99 },
      { word: "gronk", confidence: 0.3 },
      { word: "truck", confidence: 0.98 },
    ]);
    expect(spans).toHaveLength(1);
    expect(spans[0]!.words).toEqual(["gronk"]);
    expect(spans[0]!.severity).toBe("low");
  });

  it("flags a run of consecutive low-confidence words as high severity", () => {
    const spans = flagLowConfidenceSpans([
      { word: "the", confidence: 0.99 },
      { word: "aaa", confidence: 0.4 },
      { word: "bbb", confidence: 0.5 },
      { word: "truck", confidence: 0.98 },
    ]);
    expect(spans).toHaveLength(1);
    expect(spans[0]!.severity).toBe("high");
    expect(spans[0]!.words).toEqual(["aaa", "bbb"]);
  });

  it("does not flag confident words", () => {
    const spans = flagLowConfidenceSpans([
      { word: "the", confidence: 0.99 },
      { word: "truck", confidence: 0.95 },
    ]);
    expect(spans).toHaveLength(0);
  });
});

describe("combineHybridFlags", () => {
  it("produces no flags when every signal is clean", () => {
    const result = combineHybridFlags({
      disagreement: { providerId: "a", mismatchWords: 0, comparedWords: 10, disagreementRate: 0, consensusProviderCount: 3 },
      confidenceSpans: [],
      confidenceAvailable: true,
      entityMismatches: [],
    });
    expect(result.flagCount).toBe(0);
    expect(result.peerFlagCount).toBe(0);
    expect(result.flagSeverity).toBe("none");
  });

  it("escalates severity to high when an entity mismatch is present", () => {
    const result = combineHybridFlags({
      disagreement: null,
      confidenceSpans: [],
      confidenceAvailable: true,
      entityMismatches: [{ type: "vin", valuesByProvider: { a: ["X"], b: ["Y"] }, missingProviderIds: [] }],
    });
    expect(result.flagCount).toBe(1);
    expect(result.peerFlagCount).toBe(1);
    expect(result.flagSeverity).toBe("high");
    expect(result.peerFlagSeverity).toBe("high");
  });

  it("ignores disagreement below the noise threshold", () => {
    const result = combineHybridFlags({
      disagreement: { providerId: "a", mismatchWords: 1, comparedWords: 100, disagreementRate: 0.01, consensusProviderCount: 3 },
      confidenceSpans: [],
      confidenceAvailable: true,
      entityMismatches: [],
    });
    expect(result.flagCount).toBe(0);
    expect(result.flagSeverity).toBe("none");
  });

  // T-2 (base-solidity fix): confidence spans must never touch peerFlagCount
  // /peerFlagSeverity -- that's what the ranking composite reads, and only 3
  // of 7 providers report confidence at all. A provider honest enough to
  // expose low-confidence spans must not rank worse for it.
  it("keeps confidence spans out of the peer (ranking) signal", () => {
    const result = combineHybridFlags({
      disagreement: null,
      confidenceSpans: [
        { words: ["gronk"], startIndex: 0, avgConfidence: 0.3, severity: "low" },
        { words: ["aaa", "bbb"], startIndex: 5, avgConfidence: 0.4, severity: "high" },
      ],
      confidenceAvailable: true,
      entityMismatches: [],
    });
    expect(result.flagCount).toBe(2);
    expect(result.flagSeverity).toBe("high");
    expect(result.peerFlagCount).toBe(0);
    expect(result.peerFlagSeverity).toBe("none");
  });

  it("marks confidenceAvailable false through untouched, without inventing flags", () => {
    const result = combineHybridFlags({
      disagreement: null,
      confidenceSpans: [],
      confidenceAvailable: false,
      entityMismatches: [],
    });
    expect(result.confidenceAvailable).toBe(false);
    expect(result.flagCount).toBe(0);
  });
});
