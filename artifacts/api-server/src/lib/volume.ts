// T-24: a client's real call volume, so a per-minute price can be stated
// as money per month. Read straight from Vapi for the account (every call
// in the trailing window, every assistant), not from the benchmark corpus
// -- the corpus is a filtered sample and would understate volume.
// Cached in memory per account for a short while: Results re-renders
// often and Vapi paginates at 1,000 calls per request.
import { durationSecondsOf, fetchVapiCallPage, listVapiAccounts, type VapiCall } from "./vapi";

export type ClientVolume = {
  accountId: string;
  accountLabel: string;
  windowDays: number;
  from: string;
  to: string;
  calls: number;
  minutes: number;
  /** True when the page cap was hit -- the window may be undercounted. */
  truncated: boolean;
  assistants: { assistantId: string | null; calls: number; minutes: number }[];
  fetchedAt: string;
};

/** Vapi's plan keeps 14 days of call history (verified live 2026-08-29:
 * a 30-day request came back HTTP 400 "Your subscription plan only covers
 * the last 14 days of call history"; same limit T-16 designed around). So
 * the window is 14 days and a month is a projection from it -- the UI
 * must say so. Start one hour inside the boundary so a clock skew at the
 * edge doesn't trip the same 400. */
export const VOLUME_WINDOW_DAYS = 14;
const WINDOW_SAFETY_MS = 60 * 60 * 1000;
/** Serve a cached answer up to this old without waiting... */
const CACHE_MAX_AGE_MS = 6 * 60 * 60 * 1000;
/** ...but past this age, refresh in the background on the next read. A
 * cold read (nothing cached) still waits: Vapi pages 1,000 heavy call
 * objects per request, ~40s each, so warmClientVolumes() runs at boot. */
const CACHE_FRESH_MS = 15 * 60 * 1000;
const PAGE_SIZE = 1000;
/** 50 pages x 1,000 = 50,000 calls in 14 days before we stop and say so. */
const MAX_PAGES = 50;

/**
 * Walks the window newest-first. Vapi returns /call newest-first (seen
 * live 2026-08-29: a 1,000-call page for a 1,000+ call window held the
 * newest 1,000), so the cursor is the OLDEST createdAt on each page,
 * passed as createdAtLe for the next; the Map dedupes the boundary tie.
 * (lib/vapi.ts's fetchVapiCalls walks with a newest-createdAt >= cursor,
 * which ends after one page under that order -- fine for the importer's
 * small limits, wrong for counting a whole window.)
 */
async function fetchWindow(accountId: string, from: Date, to: Date): Promise<{ calls: VapiCall[]; truncated: boolean }> {
  const collected = new Map<string, VapiCall>();
  let upper = to.toISOString();
  let truncated = true;
  for (let page = 0; page < MAX_PAGES; page++) {
    const batch = await fetchVapiCallPage(accountId, { limit: PAGE_SIZE, createdAtGe: from.toISOString(), createdAtLe: upper });
    let fresh = 0;
    let oldest = "";
    for (const c of batch) {
      if (!collected.has(c.id)) fresh += 1;
      collected.set(c.id, c);
      if (c.createdAt && (oldest === "" || c.createdAt < oldest)) oldest = c.createdAt;
    }
    if (batch.length < PAGE_SIZE || fresh === 0 || !oldest) {
      truncated = false;
      break;
    }
    upper = oldest;
  }
  return { calls: [...collected.values()], truncated };
}

const cache = new Map<string, { at: number; value: ClientVolume }>();
const inFlight = new Map<string, Promise<ClientVolume>>();

export function accountForLabel(label: string) {
  return listVapiAccounts().find((a) => a.label === label) ?? null;
}

export async function clientVolume(accountLabel: string): Promise<ClientVolume | null> {
  const account = accountForLabel(accountLabel);
  if (!account) return null;
  const hit = cache.get(account.id);
  const age = hit ? Date.now() - hit.at : Infinity;
  if (hit && age < CACHE_FRESH_MS) return hit.value;
  if (hit && age < CACHE_MAX_AGE_MS) {
    void refresh(account.id, account.label).catch(() => undefined); // stale-while-revalidate
    return hit.value;
  }
  return refresh(account.id, account.label);
}

/** Fill the cache for every configured account at boot so the first
 * Results visit doesn't sit through the cold fetch. Errors are logged by
 * the caller; a failed warm-up just means the first read waits. */
export function warmClientVolumes(): Promise<PromiseSettledResult<ClientVolume>[]> {
  return Promise.allSettled(listVapiAccounts().map((a) => refresh(a.id, a.label)));
}

function refresh(accountId: string, accountLabel: string): Promise<ClientVolume> {
  const running = inFlight.get(accountId);
  if (running) return running;
  const p = (async () => {
    const to = new Date();
    const from = new Date(to.getTime() - VOLUME_WINDOW_DAYS * 24 * 60 * 60 * 1000 + WINDOW_SAFETY_MS);
    const { calls, truncated } = await fetchWindow(accountId, from, to);

    const byAssistant = new Map<string | null, { calls: number; seconds: number }>();
    let seconds = 0;
    for (const c of calls) {
      const s = durationSecondsOf(c);
      seconds += s;
      const key = c.assistantId ?? null;
      const acc = byAssistant.get(key) ?? { calls: 0, seconds: 0 };
      acc.calls += 1;
      acc.seconds += s;
      byAssistant.set(key, acc);
    }

    const value: ClientVolume = {
      accountId,
      accountLabel,
      windowDays: VOLUME_WINDOW_DAYS,
      from: from.toISOString(),
      to: to.toISOString(),
      calls: calls.length,
      minutes: seconds / 60,
      truncated,
      assistants: [...byAssistant.entries()]
        .map(([assistantId, a]) => ({ assistantId, calls: a.calls, minutes: a.seconds / 60 }))
        .sort((a, b) => b.minutes - a.minutes),
      fetchedAt: to.toISOString(),
    };
    cache.set(accountId, { at: Date.now(), value });
    return value;
  })().finally(() => inFlight.delete(accountId));
  inFlight.set(accountId, p);
  return p;
}
