// T-128: server-side cache for the vendor model lists behind
// GET /benchmark/providers/models. On 2026-08-30 Deepgram's /v1/models took
// 51 s to answer; T-119 added an 8 s per-vendor timeout so the page stops
// hanging, but every Overview and Setup visit still paid the fetch (and,
// past 8 s, saw "not answering" for a vendor that was merely slow). This
// cache makes a successful list good for 30 minutes, and keeps serving the
// last good list (up to a day old) when a vendor errors or times out --
// each model's own verifiedAt says when the vendor actually confirmed it,
// so a cached answer never pretends to be fresher than it is. The dated
// (non-live) catalogs are constants; caching them is free but harmless.
import type { ProviderModelOption } from "@workspace/stt-providers";
import { logger } from "./logger";

const FRESH_MS = 30 * 60 * 1000;
/** Past this, a dead vendor's cached list is too old to stand in for a live
 *  answer -- report the error instead. */
const STALE_MAX_MS = 24 * 60 * 60 * 1000;
/** T-119's per-vendor budget: a vendor that has not answered by now reports
 *  an error and the other vendors still render. */
const VENDOR_MODEL_LIST_TIMEOUT_MS = 8_000;

function withTimeout<T>(p: Promise<T>, ms: number, what: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${what} did not answer within ${Math.round(ms / 1000)} s.`)), ms);
  });
  return Promise.race([p, timeout]).finally(() => clearTimeout(timer));
}

type Entry = { models: ProviderModelOption[]; fetchedAt: number };
const cache = new Map<string, Entry>();

export async function cachedVendorModels(
  vendor: string,
  vendorLabel: string,
  fetcher: () => Promise<ProviderModelOption[]>,
  now: number = Date.now(),
): Promise<{ models: ProviderModelOption[]; error: string | null }> {
  const hit = cache.get(vendor);
  if (hit && now - hit.fetchedAt < FRESH_MS) {
    return { models: hit.models, error: null };
  }
  try {
    const models = await withTimeout(fetcher(), VENDOR_MODEL_LIST_TIMEOUT_MS, `${vendorLabel}'s model list`);
    cache.set(vendor, { models, fetchedAt: now });
    return { models, error: null };
  } catch (err) {
    if (hit && now - hit.fetchedAt < STALE_MAX_MS) {
      // The vendor is down or slow RIGHT NOW, but we have an answer it gave
      // within the last day. Serve that (verifiedAt on each model carries
      // its real age) and log the live failure instead of blanking the list.
      logger.warn({ err, vendor }, "vendor model list unreachable -- serving the cached list from within the last day");
      return { models: hit.models, error: null };
    }
    return { models: [], error: err instanceof Error ? err.message : String(err) };
  }
}

/** Tests only: the cache is module state; each test starts empty. */
export function clearModelListCacheForTests(): void {
  cache.clear();
}
