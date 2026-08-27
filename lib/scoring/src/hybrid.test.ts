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
      disagreement: { providerId: "a", mismatchWords: 0, comparedWords: 10, disagreementRate: 0 },
      confidenceSpans: [],
      entityMismatches: [],
    });
    expect(result.flagCount).toBe(0);
    expect(result.flagSeverity).toBe("none");
  });

  it("escalates severity to high when an entity mismatch is present", () => {
    const result = combineHybridFlags({
      disagreement: null,
      confidenceSpans: [],
      entityMismatches: [{ type: "vin", valuesByProvider: { a: ["X"], b: ["Y"] } }],
    });
    expect(result.flagCount).toBe(1);
    expect(result.flagSeverity).toBe("high");
  });

  it("ignores disagreement below the noise threshold", () => {
    const result = combineHybridFlags({
      disagreement: { providerId: "a", mismatchWords: 1, comparedWords: 100, disagreementRate: 0.01 },
      confidenceSpans: [],
      entityMismatches: [],
    });
    expect(result.flagCount).toBe(0);
    expect(result.flagSeverity).toBe("none");
  });
});
