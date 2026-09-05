import { describe, expect, it } from "vitest";
import { countMeasured, interruptedShare, medianMs, roundMs } from "./production-signals";

describe("medianMs", () => {
  it("null when nothing in the group was measured -- not 0", () => {
    expect(medianMs([])).toBeNull();
    expect(medianMs([null, undefined, null])).toBeNull();
  });

  it("ignores the unmeasured calls instead of counting them as instant", () => {
    // The corpus shape: 3 measured, 2 never timed. Median of the 3, not of 5.
    expect(medianMs([378.3, null, 495, undefined, 206.5])).toBe(378);
  });

  it("averages the two middle values on an even count", () => {
    expect(medianMs([200, 300, 400, 500])).toBe(350);
  });

  it("rounds float4 round-trip noise to whole ms", () => {
    // What Postgres real() actually hands back for 378.3.
    expect(medianMs([378.29998779296875])).toBe(378);
  });
});

describe("countMeasured", () => {
  it("counts calls carrying a number, not calls in the group", () => {
    expect(countMeasured([378.3, null, 495, undefined])).toBe(2);
  });
});

describe("interruptedShare", () => {
  it("null when Vapi counted on no call -- says nothing rather than 0 of 0", () => {
    expect(interruptedShare([null, undefined])).toBeNull();
  });

  it("denominator is calls with a count, never the group size", () => {
    // 2 interrupted, 2 counted-and-quiet, 2 never counted.
    expect(interruptedShare([2, 0, 1, 0, null, undefined])).toEqual({ interrupted: 2, measured: 4 });
  });

  it("a group Vapi counted where nobody interrupted is a real 0", () => {
    expect(interruptedShare([0, 0])).toEqual({ interrupted: 0, measured: 2 });
  });
});

describe("roundMs", () => {
  it("keeps absent absent and rounds what is there", () => {
    expect(roundMs(null)).toBeNull();
    expect(roundMs(undefined)).toBeNull();
    expect(roundMs(378.29998779296875)).toBe(378);
  });
});
