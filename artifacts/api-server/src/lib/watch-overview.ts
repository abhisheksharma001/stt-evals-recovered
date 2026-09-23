/**
 * W-6b (PRD v8 Part C, Layer 1): the Orgs screen's data, from the ledger.
 *
 * One row per (account, agent) across every watch schedule, each with its
 * last 30 ledger days, production's rate on the days that settled one
 * (W-5e), and `watchBaseline`'s verdict over those days (W-6a). Everything a
 * tick or a settle wrote is read back here; nothing is computed in the
 * browser (D-13) and nothing is read from Vapi.
 *
 * ## Why the ledger and never the bulk
 *
 * FR-BLK-10 evicts a bulk inside a day at ten schedules. The ledger row
 * outlives it, carrying `totals` (W-5d) and `production` (W-5e). This module
 * reads only those two columns and `detail.estimatedCents`; a day whose bulk
 * is gone reads exactly like a day whose bulk is still there.
 *
 * ## Why the production transcriber is resolved offline
 *
 * `assistantTranscriberConfig` makes a live Vapi read per assistant behind a
 * ten-minute cache. An overview over N agents on a cold cache is N network
 * reads, and with no VAPI key it has no answer at all (T-168). The importer
 * already stored `source_transcriber_provider` / `_model` on every call, so
 * the agent's production transcriber is the most common pair among its own
 * calls -- the same rule the verdict uses for the production baseline, and
 * one that still works after every bulk is evicted, because eviction never
 * touches the corpus.
 *
 * ## Absent is not zero
 *
 * A day with no production entry for the agent carries its outcome and no
 * rate field. A `forming` baseline carries no band. A schedule the tick has
 * never run carries its days (there are none) and a null agent.
 */
import { and, desc, eq, gte, inArray, sql } from "drizzle-orm";
import {
  benchmarkCallsTable,
  db,
  watchRunsTable,
  watchSchedulesTable,
  type WatchRunProduction,
} from "@workspace/db";
import { MIN_SHARED_CALLS_FOR_VERDICT } from "@workspace/scoring";
import { listVapiAccounts } from "./vapi";
import { localDay } from "./watch-scheduler";
import { estimatedCentsThisMonth } from "./watch-tick";
import { watchBaseline, type BaselineDay, type WatchBaseline } from "./watch-baseline";

/** The tick bar's width. Thirty ledger days, today included. */
export const OVERVIEW_WINDOW_DAYS = 30;

export type WatchOverviewDay = {
  day: string;
  outcome: string;
  bulkId: string | null;
  /** Mismatched words per 100 compared words -- present only when the day
   *  settled a production measurement for this agent. */
  rate?: number;
  calls?: number;
  leaderProviderId?: string | null;
  leaderRate?: number | null;
};

export type WatchOverviewAgent = {
  scheduleId: string;
  enabled: boolean;
  assistantId: string | null;
  production: { vendor: string; model: string | null } | null;
  baseline: WatchBaseline;
  monthEstimatedCents: number;
  days: WatchOverviewDay[];
};

export type WatchOverviewAccount = {
  accountId: string;
  accountLabel: string | null;
  agents: WatchOverviewAgent[];
};

export type WatchOverview = {
  today: string;
  windowStart: string;
  accounts: WatchOverviewAccount[];
};

/** `YYYY-MM-DD` minus n days, in the process's local time -- the same clock
 *  the ledger's `day` was written from. */
function daysBefore(day: string, n: number): string {
  const [y, m, d] = day.split("-").map(Number) as [number, number, number];
  return localDay(new Date(y, m - 1, d - n));
}

/** Per 100 compared words, so the number reads on the same scale as the
 *  trend strip's flags per 100 words. */
function per100(mismatch: number, compared: number): number {
  return (mismatch / compared) * 100;
}

export async function watchOverview(input: { now?: Date } = {}): Promise<WatchOverview> {
  const now = input.now ?? new Date();
  const today = localDay(now);
  const windowStart = daysBefore(today, OVERVIEW_WINDOW_DAYS - 1);

  const schedules = await db.select().from(watchSchedulesTable).orderBy(watchSchedulesTable.createdAt);
  if (schedules.length === 0) return { today, windowStart, accounts: [] };

  const runs = await db
    .select({
      scheduleId: watchRunsTable.scheduleId,
      day: watchRunsTable.day,
      outcome: watchRunsTable.outcome,
      bulkId: watchRunsTable.bulkId,
      totals: watchRunsTable.totals,
      production: watchRunsTable.production,
    })
    .from(watchRunsTable)
    .where(
      and(
        inArray(
          watchRunsTable.scheduleId,
          schedules.map((s) => s.id),
        ),
        gte(watchRunsTable.day, windowStart),
      ),
    )
    .orderBy(desc(watchRunsTable.day));

  const runsBySchedule = new Map<string, typeof runs>();
  for (const r of runs) runsBySchedule.set(r.scheduleId, [...(runsBySchedule.get(r.scheduleId) ?? []), r]);

  // Which agents each schedule has seen: everything a settle wrote an entry
  // for, else the agent the policy names, else the null agent.
  const agentsOf = (scheduleId: string, named: string | null): (string | null)[] => {
    const seen = new Set<string | null>();
    for (const r of runsBySchedule.get(scheduleId) ?? []) {
      for (const p of r.production ?? []) seen.add(p.assistantId);
      for (const t of r.totals ?? []) seen.add(t.assistantId);
    }
    if (seen.size === 0) return [named];
    return [...seen].sort((a, b) => (a ?? "").localeCompare(b ?? ""));
  };

  const allAssistantIds = new Set<string>();
  for (const s of schedules) for (const a of agentsOf(s.id, s.assistantId ?? null)) if (a) allAssistantIds.add(a);
  const productionByAssistant = await productionTranscribers([...allAssistantIds]);

  const accountLabels = new Map(listVapiAccounts().map((a) => [a.id, a.label]));
  const byAccount = new Map<string, WatchOverviewAccount>();

  for (const schedule of schedules) {
    const scheduleRuns = runsBySchedule.get(schedule.id) ?? [];
    const monthEstimatedCents = await estimatedCentsThisMonth(schedule.id, today);
    const account =
      byAccount.get(schedule.accountId) ??
      { accountId: schedule.accountId, accountLabel: accountLabels.get(schedule.accountId) ?? null, agents: [] };
    byAccount.set(schedule.accountId, account);

    for (const assistantId of agentsOf(schedule.id, schedule.assistantId ?? null)) {
      const days: WatchOverviewDay[] = scheduleRuns.map((r) => {
        const entry: WatchRunProduction | undefined = (r.production ?? []).find((p) => p.assistantId === assistantId);
        const day: WatchOverviewDay = { day: r.day, outcome: r.outcome, bulkId: r.bulkId };
        if (entry && entry.comparedWords > 0) {
          day.rate = per100(entry.mismatchWords, entry.comparedWords);
          day.calls = entry.calls;
          day.leaderProviderId = entry.leaderProviderId;
          day.leaderRate =
            entry.leaderProviderId === null || entry.leaderComparedWords === 0
              ? null
              : per100(entry.leaderMismatchWords, entry.leaderComparedWords);
        }
        return day;
      });

      const measured: BaselineDay[] = days
        .filter((d): d is WatchOverviewDay & { rate: number; calls: number } => d.rate !== undefined && d.calls !== undefined)
        .map((d) => ({ day: d.day, flagsPer100Words: d.rate, callsScored: d.calls }));
      const todayDay = measured.find((d) => d.day === today) ?? null;
      const prior = measured.filter((d) => d.day < today);
      const baseline = watchBaseline({ today: todayDay, prior });

      account.agents.push({
        scheduleId: schedule.id,
        enabled: schedule.enabled,
        assistantId,
        production: assistantId ? (productionByAssistant.get(assistantId) ?? null) : null,
        baseline,
        monthEstimatedCents,
        days,
      });
    }
  }

  return { today, windowStart, accounts: [...byAccount.values()] };
}

/** The most common (vendor, model) among each assistant's imported calls.
 *  One grouped query for every agent on the screen; an agent with no call
 *  that says is simply absent from the map. */
async function productionTranscribers(
  assistantIds: string[],
): Promise<Map<string, { vendor: string; model: string | null }>> {
  const out = new Map<string, { vendor: string; model: string | null }>();
  if (assistantIds.length === 0) return out;
  const rows = await db
    .select({
      assistantId: benchmarkCallsTable.sourceAssistantId,
      vendor: benchmarkCallsTable.sourceTranscriberProvider,
      model: benchmarkCallsTable.sourceTranscriberModel,
      n: sql<number>`count(*)::int`,
    })
    .from(benchmarkCallsTable)
    .where(inArray(benchmarkCallsTable.sourceAssistantId, assistantIds))
    .groupBy(
      benchmarkCallsTable.sourceAssistantId,
      benchmarkCallsTable.sourceTranscriberProvider,
      benchmarkCallsTable.sourceTranscriberModel,
    );
  const best = new Map<string, { n: number; vendor: string; model: string | null }>();
  for (const r of rows) {
    if (!r.assistantId || !r.vendor) continue;
    const cur = best.get(r.assistantId);
    if (!cur || r.n > cur.n) best.set(r.assistantId, { n: r.n, vendor: r.vendor, model: r.model ?? null });
  }
  for (const [id, b] of best) out.set(id, { vendor: b.vendor, model: b.model });
  return out;
}

// Re-exported so the route can say, in its own words, what "enough calls"
// means without importing the scoring package for one number.
export { MIN_SHARED_CALLS_FOR_VERDICT };
