import { describe, expect, it } from "vitest";
import { CATALOG_RECHECK_DAYS, catalogAge, staleCatalogVendors } from "./catalog-age";

const DAY = 86_400_000;
const NOW = Date.parse("2026-08-31T12:00:00Z");

function datedModel(daysAgo: number, latest = true) {
  return { latest, source: "dated", verifiedAt: new Date(NOW - daysAgo * DAY).toISOString() };
}

describe("catalogAge", () => {
  it("is null for a live catalog -- live vendors never age", () => {
    expect(catalogAge({ source: "live", verifiedAt: datedModel(90).verifiedAt }, NOW)).toBeNull();
  });

  it("is null for an unparseable verifiedAt instead of NaN", () => {
    expect(catalogAge({ source: "dated", verifiedAt: "not a date" }, NOW)).toBeNull();
  });

  it("counts whole days, floored", () => {
    expect(catalogAge(datedModel(0), NOW)).toBe(0);
    expect(catalogAge({ source: "dated", verifiedAt: new Date(NOW - 1.9 * DAY).toISOString() }, NOW)).toBe(1);
    expect(catalogAge(datedModel(61), NOW)).toBe(61);
  });

  it("clamps a future verifiedAt to 0, never negative", () => {
    expect(catalogAge({ source: "dated", verifiedAt: new Date(NOW + 3 * DAY).toISOString() }, NOW)).toBe(0);
  });
});

describe("staleCatalogVendors", () => {
  it("names only vendors whose latest dated model is past the window", () => {
    const vendors = [
      { vendorLabel: "AssemblyAI", models: [datedModel(CATALOG_RECHECK_DAYS + 1)] },
      { vendorLabel: "Gladia", models: [datedModel(5)] },
      { vendorLabel: "Deepgram", models: [{ latest: true, source: "live", verifiedAt: datedModel(999).verifiedAt }] },
    ];
    expect(staleCatalogVendors(vendors, NOW)).toEqual(["AssemblyAI"]);
  });

  it("a catalog exactly at the window is not yet stale -- strictly older only", () => {
    expect(staleCatalogVendors([{ vendorLabel: "Cartesia", models: [datedModel(CATALOG_RECHECK_DAYS)] }], NOW)).toEqual([]);
  });

  it("ignores non-latest models entirely", () => {
    const vendors = [{ vendorLabel: "ElevenLabs", models: [datedModel(400, false), datedModel(2, true)] }];
    expect(staleCatalogVendors(vendors, NOW)).toEqual([]);
  });

  it("a vendor with no latest-flagged model never counts as stale", () => {
    expect(staleCatalogVendors([{ vendorLabel: "Gladia", models: [datedModel(400, false)] }], NOW)).toEqual([]);
  });
});
