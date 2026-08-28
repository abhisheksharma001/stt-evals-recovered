// T-23: trend across bulks. The API hands over one summed cell per
// (bulk, client, assistant, provider) -- raw totals, never rates -- and this
// module pools them for whatever scope the reader picked and turns the
// totals into the same rate metrics the rankings use (T-19: peer flags per
// 100 words, clean-call rate). Because the inputs are sums, pooling an
// assistant into its client (or a client into "everything") is exact --
// no averaging of averages.
//
// Nothing here decides anything. It draws where each provider was, bulk by
// bulk, and states the change between the last two bulks so a regression
// is visible instead of buried under a fresh ranking.

export type TrendBulk = {
  id: string;
  name: string;
  /** ISO timestamp the bulk is ordered by (completedAt, else createdAt). */
  at: string;
  status: string;
};

export type TrendCell = {
  bulkId: string;
  /** Vapi account label the calls came from -- the client. Null when the
   * call predates per-account labelling and was never backfilled. */
  accountLabel: string | null;
  assistantId: string | null;
  providerId: string;
  providerName: string;
  /** Sum of peer flags over this provider's flag-scored cells. */
  peerFlags: number;
  /** Sum of normalized words over the same cells. */
  words: number;
  /** Number of flag-scored cells (one per call). */
  callsScored: number;
  /** Of those, how many had zero peer flags. */
  cleanCalls: number;
};

export type TrendScope = {
  /** Restrict to one client. Omit for every client. */
  accountLabel?: string | null;
  /** Restrict to one assistant group. Omit for every assistant. */
  assistantId?: string | null;
};

export type TrendPoint = {
  bulkId: string;
  peerFlagsPer100Words: number | null;
  cleanCallRate: number | null;
  callsScored: number;
};

export type TrendDirection = "worse" | "better" | "flat" | "unknown";

export type TrendSeries = {
  providerId: string;
  providerName: string;
  /** One entry per bulk in `bulks` order; a bulk this provider did not
   * score has nulls and callsScored 0, never a fabricated 0 rate. */
  points: TrendPoint[];
  /** Latest bulk with evidence for this provider, and the one before it. */
  latest: TrendPoint | null;
  previous: TrendPoint | null;
  /** latest - previous in flags/100 words. Positive = more flags = worse. */
  deltaPer100Words: number | null;
  direction: TrendDirection;
};

export type Trend = {
  bulks: TrendBulk[];
  series: TrendSeries[];
};

/** Below this many flags/100 words of movement the change reads as noise,
 * not a regression. 0.05 = one flag per 2,000 words. */
export const TREND_FLAT_BAND_PER_100_WORDS = 0.05;

/** A point with fewer scored calls than this cannot call a direction on
 * its own -- the delta is still shown, the direction reads "unknown". */
export const TREND_MIN_CALLS_FOR_DIRECTION = 5;

function inScope(cell: TrendCell, scope: TrendScope): boolean {
  if (scope.accountLabel !== undefined && cell.accountLabel !== scope.accountLabel) return false;
  if (scope.assistantId !== undefined && cell.assistantId !== scope.assistantId) return false;
  return true;
}

export function buildTrend(cells: TrendCell[], bulks: TrendBulk[], scope: TrendScope = {}): Trend {
  const ordered = [...bulks].sort((a, b) => a.at.localeCompare(b.at) || a.id.localeCompare(b.id));
  const bulkIndex = new Map(ordered.map((b, i) => [b.id, i]));

  type Acc = { peerFlags: number; words: number; callsScored: number; cleanCalls: number };
  const byProvider = new Map<string, { name: string; perBulk: Map<string, Acc> }>();
  for (const cell of cells) {
    if (!inScope(cell, scope)) continue;
    if (!bulkIndex.has(cell.bulkId)) continue;
    const prov = byProvider.get(cell.providerId) ?? { name: cell.providerName, perBulk: new Map() };
    const acc = prov.perBulk.get(cell.bulkId) ?? { peerFlags: 0, words: 0, callsScored: 0, cleanCalls: 0 };
    acc.peerFlags += cell.peerFlags;
    acc.words += cell.words;
    acc.callsScored += cell.callsScored;
    acc.cleanCalls += cell.cleanCalls;
    prov.perBulk.set(cell.bulkId, acc);
    byProvider.set(cell.providerId, prov);
  }

  const series: TrendSeries[] = [...byProvider.entries()]
    .map(([providerId, prov]) => {
      const points: TrendPoint[] = ordered.map((b) => {
        const acc = prov.perBulk.get(b.id);
        if (!acc || acc.callsScored === 0) {
          return { bulkId: b.id, peerFlagsPer100Words: null, cleanCallRate: null, callsScored: 0 };
        }
        return {
          bulkId: b.id,
          peerFlagsPer100Words: acc.words > 0 ? (acc.peerFlags / acc.words) * 100 : null,
          cleanCallRate: acc.cleanCalls / acc.callsScored,
          callsScored: acc.callsScored,
        };
      });
      const withEvidence = points.filter((p) => p.peerFlagsPer100Words !== null);
      const latest = withEvidence.at(-1) ?? null;
      const previous = withEvidence.length >= 2 ? withEvidence[withEvidence.length - 2] : null;
      const deltaPer100Words =
        latest?.peerFlagsPer100Words != null && previous?.peerFlagsPer100Words != null
          ? latest.peerFlagsPer100Words - previous.peerFlagsPer100Words
          : null;
      let direction: TrendDirection = "unknown";
      if (
        deltaPer100Words !== null &&
        latest !== null &&
        previous !== null &&
        latest.callsScored >= TREND_MIN_CALLS_FOR_DIRECTION &&
        previous.callsScored >= TREND_MIN_CALLS_FOR_DIRECTION
      ) {
        direction =
          Math.abs(deltaPer100Words) < TREND_FLAT_BAND_PER_100_WORDS
            ? "flat"
            : deltaPer100Words > 0
              ? "worse"
              : "better";
      }
      return { providerId, providerName: prov.name, points, latest, previous, deltaPer100Words, direction };
    })
    .sort((a, b) => a.providerName.localeCompare(b.providerName));

  return { bulks: ordered, series };
}
