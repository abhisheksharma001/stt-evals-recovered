/**
 * W-5d (PRD v8 Part B): the day's numbers move off the bulk and onto the
 * ledger.
 *
 * A `launched` ledger row points at a bulk and holds nothing of its own.
 * That pointer is not history: FR-BLK-10 evicts the oldest bulk the moment an
 * eleventh is created (`MAX_LIVE_BULKS`, 10 since W-13), taking its runs,
 * cells, scores and rankings with it, and setting `watch_runs.bulk_id` to
 * null. With ten schedules running daily that is a bulk gone inside a day.
 *
 * So once a bulk has finished scoring, its four T-19 numbers per
 * (agent, provider) are copied onto the row and the row reads `settled`.
 * **The ledger is the history, the bulk is the workbench** -- W-5a made the
 * row survive its bulk detached, and this is what makes that survival worth
 * something: the 30-day line on Layer 1 (W-6) is drawn from `totals`, never
 * from a bulk that may not exist any more.
 *
 * ## Why this is not inside the per-schedule loop
 *
 * `runWatchTick`'s loop body runs once per schedule per DAY -- `decideTick`
 * skips a schedule whose day is already in the ledger, which is every tick
 * after the first. A bulk launched at 03:00 finishes around 03:40, so
 * settling from inside that loop would wait for the next day's tick and
 * Layer 1 would be a day behind all day. This runs on every tick instead,
 * over every launched row in the table, with no reference to whose hour it
 * is.
 *
 * ## What it must not do
 *
 * Re-read a bulk it has already settled (the `launched` filter is what stops
 * that -- a settled row is no longer selected). Settle a row whose bulk is
 * still running, cancelled or failed (the status join). Write zeros for a
 * pair that scored nothing: absent is not zero, so a pair with no scored call
 * simply has no entry.
 */
import { and, eq, inArray, isNotNull } from "drizzle-orm";
import {
  benchmarkBulksTable,
  db,
  watchRunsTable,
  type WatchRunTotals,
} from "@workspace/db";
import { benchmarkTrend } from "./trend";
import { logger } from "./logger";
import type { Logger } from "pino";

/** The bulk statuses whose numbers are final. Same pair the trend strip
 *  joins on, and for the same reason: a running bulk's sums keep moving. */
const SETTLEABLE_BULK_STATUSES = ["complete", "partial"] as const;

/** One row this pass settled. Returned so a tick can log what it did without
 *  re-reading the ledger. */
export type SettledRun = {
  watchRunId: string;
  bulkId: string;
  pairs: number;
};

/**
 * Every `launched` ledger row whose bulk has finished scoring, settled.
 *
 * Rows whose `bulk_id` is already null are not selected at all: their bulk
 * was evicted before anyone copied its numbers, and there is nothing left to
 * copy. Such a row stays `launched` with `totals` null -- deliberately, not
 * as an oversight. `launched` is one of the two SPENDING_OUTCOMES, so the
 * money it spent keeps counting against the monthly cap, which it must; and
 * null totals mean "no numbers were captured", which is the truth. Calling it
 * `failed` would un-count real spend, and calling it `settled` with an empty
 * array would claim the day scored nothing.
 */
export async function settleLaunchedRuns(
  input: { log?: Logger } = {},
): Promise<SettledRun[]> {
  const log = input.log ?? logger;

  const due = await db
    .select({
      watchRunId: watchRunsTable.id,
      bulkId: benchmarkBulksTable.id,
    })
    .from(watchRunsTable)
    .innerJoin(benchmarkBulksTable, eq(benchmarkBulksTable.id, watchRunsTable.bulkId))
    .where(
      and(
        eq(watchRunsTable.outcome, "launched"),
        isNotNull(watchRunsTable.bulkId),
        inArray(benchmarkBulksTable.status, [...SETTLEABLE_BULK_STATUSES]),
      ),
    );

  const settled: SettledRun[] = [];
  for (const row of due) {
    const trend = await benchmarkTrend({ bulkId: row.bulkId });
    // The bulk was there when the join ran and is not there now -- evicted,
    // or flipped out of a finished status, between the two queries. Leave the
    // row `launched`: a `settled` row with an empty totals array would say
    // "this day scored nothing", which is a different claim from "the numbers
    // were gone before anyone read them".
    if (trend.bulks.length === 0) {
      log.warn(
        { watchRunId: row.watchRunId, bulkId: row.bulkId },
        "watch: bulk vanished between the settle query and the read -- left launched",
      );
      continue;
    }

    const totals = foldCellsToTotals(trend.cells);
    await db
      .update(watchRunsTable)
      .set({ outcome: "settled", totals })
      .where(eq(watchRunsTable.id, row.watchRunId));

    log.info(
      { watchRunId: row.watchRunId, bulkId: row.bulkId, pairs: totals.length },
      "watch: settled",
    );
    settled.push({ watchRunId: row.watchRunId, bulkId: row.bulkId, pairs: totals.length });
  }
  return settled;
}

/**
 * Trend cells for one bulk, summed down to what the ledger keeps.
 *
 * A cell carries `accountLabel` and `providerName`; `WatchRunTotals` keeps
 * neither, so cells that differ only by account fold together. A watch bulk
 * is one account's day by construction (the schedule names one `accountId`),
 * so in practice nothing folds -- but the fold is written rather than assumed,
 * because silently keeping the last cell of a pair would be a wrong number
 * rather than a missing one.
 */
export function foldCellsToTotals(
  cells: readonly {
    assistantId: string | null;
    providerId: string;
    peerFlags: number;
    words: number;
    callsScored: number;
    cleanCalls: number;
  }[],
): WatchRunTotals[] {
  const byPair = new Map<string, WatchRunTotals>();
  for (const cell of cells) {
    const key = `${cell.assistantId ?? ""}|${cell.providerId}`;
    const total =
      byPair.get(key) ??
      ({
        assistantId: cell.assistantId,
        providerId: cell.providerId,
        peerFlags: 0,
        words: 0,
        callsScored: 0,
        cleanCalls: 0,
      } satisfies WatchRunTotals);
    total.peerFlags += cell.peerFlags;
    total.words += cell.words;
    total.callsScored += cell.callsScored;
    total.cleanCalls += cell.cleanCalls;
    byPair.set(key, total);
  }
  return [...byPair.values()];
}
