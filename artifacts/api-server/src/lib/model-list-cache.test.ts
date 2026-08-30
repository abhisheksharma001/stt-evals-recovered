import { beforeEach, describe, expect, it, vi } from "vitest";
import { cachedVendorModels, clearModelListCacheForTests } from "./model-list-cache";

const MODEL = {
  apiModel: "nova-3",
  label: "nova-3-general",
  latest: true,
  source: "live" as const,
  verifiedAt: "2026-08-31T00:00:00.000Z",
};

const T0 = 1_000_000_000;
const MIN = 60 * 1000;

describe("cachedVendorModels", () => {
  beforeEach(() => clearModelListCacheForTests());

  it("a fresh success is served from cache without calling the vendor again", async () => {
    const fetcher = vi.fn().mockResolvedValue([MODEL]);
    await cachedVendorModels("deepgram", "Deepgram", fetcher, T0);
    const second = await cachedVendorModels("deepgram", "Deepgram", fetcher, T0 + 29 * MIN);
    expect(second).toEqual({ models: [MODEL], error: null });
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it("past 30 minutes the vendor is asked again", async () => {
    const fetcher = vi.fn().mockResolvedValue([MODEL]);
    await cachedVendorModels("deepgram", "Deepgram", fetcher, T0);
    await cachedVendorModels("deepgram", "Deepgram", fetcher, T0 + 31 * MIN);
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it("a vendor error with a day-old good answer serves the cached list, not a blank", async () => {
    const fetcher = vi.fn().mockResolvedValueOnce([MODEL]).mockRejectedValue(new Error("HTTP 500"));
    await cachedVendorModels("deepgram", "Deepgram", fetcher, T0);
    const later = await cachedVendorModels("deepgram", "Deepgram", fetcher, T0 + 60 * MIN);
    expect(later).toEqual({ models: [MODEL], error: null });
  });

  it("a vendor error with nothing cached reports the error and an empty list", async () => {
    const fetcher = vi.fn().mockRejectedValue(new Error("HTTP 500"));
    const out = await cachedVendorModels("gladia", "Gladia", fetcher, T0);
    expect(out.models).toEqual([]);
    expect(out.error).toContain("HTTP 500");
  });

  it("a cached answer older than a day no longer stands in for a dead vendor", async () => {
    const fetcher = vi.fn().mockResolvedValueOnce([MODEL]).mockRejectedValue(new Error("HTTP 500"));
    await cachedVendorModels("deepgram", "Deepgram", fetcher, T0);
    const out = await cachedVendorModels("deepgram", "Deepgram", fetcher, T0 + 25 * 60 * MIN);
    expect(out.models).toEqual([]);
    expect(out.error).toContain("HTTP 500");
  });

  it("vendors do not share cache entries", async () => {
    await cachedVendorModels("deepgram", "Deepgram", vi.fn().mockResolvedValue([MODEL]), T0);
    const other = await cachedVendorModels("openai", "OpenAI", vi.fn().mockRejectedValue(new Error("down")), T0);
    expect(other.models).toEqual([]);
    expect(other.error).toContain("down");
  });
});
