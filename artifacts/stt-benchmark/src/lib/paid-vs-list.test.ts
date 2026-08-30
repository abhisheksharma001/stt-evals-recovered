import { describe, expect, it } from "vitest";
import { PAID_VS_LIST_TOLERANCE, paidVsListDiffers } from "./paid-vs-list";

describe("paidVsListDiffers", () => {
  it("silent when either side is missing -- no note over absent data", () => {
    expect(paidVsListDiffers(null, 0.0077)).toBe(false);
    expect(paidVsListDiffers(0.0077, undefined)).toBe(false);
  });

  it("silent on a zero or negative list price instead of dividing by it", () => {
    expect(paidVsListDiffers(0.0077, 0)).toBe(false);
    expect(paidVsListDiffers(0.0077, -1)).toBe(false);
  });

  it("exactly at the tolerance stays quiet; just past it speaks", () => {
    // Values chosen so the ratio is exact in floating point: (102-100)/100
    // is 0.02 to the bit; 0.01 * 1.02 would land a hair above it.
    expect(paidVsListDiffers(100 * (1 + PAID_VS_LIST_TOLERANCE), 100)).toBe(false);
    expect(paidVsListDiffers(100 * (1 + PAID_VS_LIST_TOLERANCE) + 0.1, 100)).toBe(true);
  });

  it("drift in either direction counts -- paid above or below list", () => {
    expect(paidVsListDiffers(0.0043, 0.0077)).toBe(true);
    expect(paidVsListDiffers(0.0077, 0.0043)).toBe(true);
  });

  it("the T-62 case that motivated the note: paid at the old flux price, list at the new one", () => {
    expect(paidVsListDiffers(0.0043, 0.0077)).toBe(true);
  });
});
