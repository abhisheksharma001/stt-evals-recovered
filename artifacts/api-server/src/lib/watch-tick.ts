/**
 * W-5c2 (PRD v8 Part B): one pass of the watch scheduler -- for every enabled
 * policy, decide, claim the day, and then import, sample, price, and either
 * refuse or launch.
 *
 * **Nothing calls this.** W-5c3 is the three lines in
 * `artifacts/api-server/src/index.ts` that put it on a 60-second interval
 * behind `WATCH_SCHEDULER=1`, and that is a separate PR on purpose: this file
 * is long and the change that arms it is three lines, so the three lines get
 * their own review instead of being read at the end of four hundred.
 *
 * ## The order is the safety
 *
 * The ledger row is inserted BEFORE any work, with outcome `started`. A
 * second tick for the same (schedule, day) loses the unique index and stops
 * having done nothing. Move that insert after the import -- the obvious
 * "don't write a row until we know there is something to write" -- and two
 * ticks a minute apart both import and both launch, which is twice the money
 * with nobody watching. The break test for this step is exactly that move.
 *
 * ## It reads no clock and reaches no network of its own
 *
 * `now` is an argument (same reason as W-5b) and the Vapi half arrives as
 * `source`, defaulting to the real functions. Tests pass fakes, so every
 * assertion here holds whether or not a VAPI key is in the environment
 * (T-168) -- and no test can reach a provider even by accident.
 *
 * ## What it must never do
 *
 * Backfill. `decideTick` returns one day, never a list, so this file could
 * not choose otherwise if it wanted to. Call `launchBulk`:
 * `createBulkFromCriteria` already launches a `draft` itself, and calling it
 * again throws `bulk is running, not launchable`. Pass `confirm: true`: the
 * FR-BLK-5 gate is the last thing between an underestimated day and a real
 * bill, and a scheduler has nobody to ask.
 */

import { and, eq, gte, inArray, lt } from "drizzle-orm";
import {
  benchmarkCallsTable,
  bulkTemplatesTable,
  db,
  watchRunsTable,
  watchSchedulesTable,
  type BulkSelectionCriteria,
  type WatchRunDetail,
} from "@workspace/db";
import {
  BulkNameConflictError,
  createBulkFromCriteria,
  NO_CUSTOMER_AUDIO_BUCKET,
  isUniqueViolation,
  previewBulkSelection,
  resolveCriteriaSelection,
} from "./bulks";
import { decideTick, localDay } from "./watch-scheduler";
import { settleLaunchedRuns } from "./watch-settle";
import { sampleForDay, type SampleCandidate } from "./watch-sampler";
import {
  UnknownVapiAccountError,
  importVapiCalls,
  previewVapiCalls,
} from "./vapi-import";
import type { Logger } from "pino";
import { logger } from "./logger";

/** How many call ids go to `importVapiCalls` at once. The importer is already
 *  bounded-parallel inside; this bounds how much of a day is in flight at all,
 *  so a failure late in a busy account has not left 900 half-cached rows. */
export const WATCH_IMPORT_CHUNK = 200;

/** The `actorLabel` on every audit row this path writes, so a scheduled
 *  import and a hand-clicked one are told apart in the audit log forever. */
export const WATCH_ACTOR_LABEL = "watch-scheduler";

/** How far back a tick imports. A day, not "since the last run": a laptop
 *  asleep for three days runs the most recent day only, and reaching further
 *  back would be the backfill Part B refuses. */
const WATCH_WINDOW_HOURS = 24;

/** One schedule's answer for one day. Returned so W-5c3 can log a tick
 *  without re-reading the ledger, and so the tests can assert on the decision
 *  rather than only on its side effects. */
export type WatchTickResult = {
  scheduleId: string;
  day: string;
  outcome: string;
  bulkId: string | null;
};

/** The Vapi half, injected. Defaults to the real functions; every test passes
 *  fakes, which is what makes "no test can reach a provider" a property of
 *  the shape rather than a promise in a comment. */
export type WatchTickSource = {
  preview: typeof previewVapiCalls;
  import: typeof importVapiCalls;
};

const REAL_SOURCE: WatchTickSource = {
  preview: previewVapiCalls,
  import: importVapiCalls,
};

/** What one schedule's day came to, before it is written down. `bulkId` is
 *  null on every refusal -- a ledger row pointing at a bulk it did not create
 *  would be worse than no pointer. */
type Settlement = {
  outcome: string;
  detail: WatchRunDetail;
  bulkId: string | null;
};

function chunk<T>(items: readonly T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

/**
 * Every enabled policy, once. Errors inside one schedule are caught and
 * written to that schedule's own ledger row as `failed` -- one broken account
 * must not stop the other policies from running their day.
 */
export async function runWatchTick(input: {
  now: Date;
  source?: WatchTickSource;
  log?: Logger;
}): Promise<WatchTickResult[]> {
  const { now } = input;
  const source = input.source ?? REAL_SOURCE;
  const log = input.log ?? logger;

  // W-5d: yesterday's numbers before today's decisions, and outside the loop
  // below -- that loop runs once per schedule per DAY, so settling from
  // inside it would leave Layer 1 a day behind. Caught here rather than
  // allowed to escape: settling is a read-back, and a broken read-back must
  // not stop the policies from running their day.
  try {
    await settleLaunchedRuns({ log });
  } catch (err) {
    log.error({ err }, "watch: settle pass failed");
  }

  const schedules = await db
    .select()
    .from(watchSchedulesTable)
    .where(eq(watchSchedulesTable.enabled, true));

  const results: WatchTickResult[] = [];
  for (const schedule of schedules) {
    const ledgerDays = await db
      .select({ day: watchRunsTable.day })
      .from(watchRunsTable)
      .where(eq(watchRunsTable.scheduleId, schedule.id));

    const decision = decideTick({
      schedule,
      now,
      ledgerDays: ledgerDays.map((r) => r.day),
    });
    if (decision.action === "skip") continue;
    const day = decision.day;

    // THE CLAIM. First write, before any work. A second tick for this pair
    // bounces off watch_runs_schedule_day_unique here and stops, having done
    // nothing -- not after importing a day it is about to discard.
    let runId: string;
    try {
      const [row] = await db
        .insert(watchRunsTable)
        .values({ scheduleId: schedule.id, day, outcome: "started" })
        .returning({ id: watchRunsTable.id });
      runId = row.id;
    } catch (err) {
      if (isUniqueViolation(err)) {
        log.info({ scheduleId: schedule.id, day }, "watch: another tick already claimed this day");
        continue;
      }
      throw err;
    }

    let settlement: Settlement;
    try {
      settlement = await runOneSchedule({ schedule, day, now, source });
    } catch (err) {
      // Counts and messages only. `detail` is read by the UI and dumped in
      // logs, and the corpus's PII rules do not stop at the corpus.
      const message = err instanceof Error ? err.message : String(err);
      log.error({ err, scheduleId: schedule.id, day }, "watch: tick failed");
      settlement = { outcome: "failed", detail: { error: message }, bulkId: null };
    }

    await db
      .update(watchRunsTable)
      .set({
        outcome: settlement.outcome,
        detail: settlement.detail,
        bulkId: settlement.bulkId,
      })
      .where(eq(watchRunsTable.id, runId));

    results.push({
      scheduleId: schedule.id,
      day,
      outcome: settlement.outcome,
      bulkId: settlement.bulkId,
    });
  }
  return results;
}

type ScheduleRow = typeof watchSchedulesTable.$inferSelect;

async function runOneSchedule(input: {
  schedule: ScheduleRow;
  day: string;
  now: Date;
  source: WatchTickSource;
}): Promise<Settlement> {
  const { schedule, day, now, source } = input;

  const [template] = await db
    .select()
    .from(bulkTemplatesTable)
    .where(eq(bulkTemplatesTable.id, schedule.templateId))
    .limit(1);
  if (!template) {
    // The column is a real foreign key, so this is unreachable short of a
    // hand-run delete. Said out loud rather than thrown as a TypeError on
    // the next line.
    return { outcome: "failed", detail: { error: "template row is missing" }, bulkId: null };
  }

  const windowTo = now;
  const windowFrom = new Date(now.getTime() - WATCH_WINDOW_HOURS * 60 * 60 * 1000);

  // 1. What Vapi has for this account in the window, and what of it is new.
  let preview: Awaited<ReturnType<typeof previewVapiCalls>>;
  try {
    preview = await source.preview({
      accountId: schedule.accountId,
      // fetchVapiCalls pages internally up to this; the window is what bounds
      // the answer, not the number.
      limit: 1000,
      startDate: windowFrom,
      endDate: windowTo,
      assistantId: schedule.assistantId ?? undefined,
    });
  } catch (err) {
    // No key for this account means no key: `listVapiAccounts()` derives its
    // ids from env-var NAMES, so an account this server holds no key for is
    // an account it has never heard of.
    if (err instanceof UnknownVapiAccountError) {
      return { outcome: "refused:no_key", detail: {}, bulkId: null };
    }
    throw err;
  }

  // 2. Import the new ones, in chunks.
  const toImport = preview.calls
    .filter((c) => c.hasRecording && !c.alreadyImported)
    .map((c) => c.vapiCallId);
  let imported = 0;
  for (const batch of chunk(toImport, WATCH_IMPORT_CHUNK)) {
    const res = await source.import(
      { accountId: schedule.accountId, vertical: schedule.vertical, vapiCallIds: batch },
      WATCH_ACTOR_LABEL,
    );
    imported += res.importedCount;
  }

  // 3. What the policy's own criteria match in that window. The template's
  //    filters, narrowed to this account, this window and (when the policy
  //    names one) this agent. `lastNDays` is dropped rather than left to
  //    re-resolve: the window this tick ran is the window it reports.
  // W-5f (Abhishek, 2026-09-23, option a): a watch runs on the caller track
  // unless its template says otherwise. Decided HERE, before the draw, and
  // not only at pricing: the sampler must only ever see calls that can go
  // into the bulk, or the ledger would say it sampled ten and the freeze
  // would quietly keep six. A template with no opinion on file gets `true`
  // -- a watch that has never run has no earlier numbers to keep matching,
  // which is the reason the hand template-launch route keeps `false`.
  const requireCustomerAudio = template.selectionCriteria.requireCustomerAudio ?? true;
  const matchCriteria: BulkSelectionCriteria = {
    ...template.selectionCriteria,
    requireCustomerAudio,
    accountLabel: preview.accountLabel,
    assistantIds: schedule.assistantId
      ? [schedule.assistantId]
      : template.selectionCriteria.assistantIds,
    lastNDays: undefined,
    startedAtFrom: windowFrom.toISOString(),
    startedAtTo: windowTo.toISOString(),
  };
  const matched = await resolveCriteriaSelection(
    matchCriteria,
    template.minDurationSeconds,
    template.maxDurationSeconds ?? null,
    now,
  );
  const noCustomerAudio = matched.excluded.find((e) => e.bucket === NO_CUSTOMER_AUDIO_BUCKET)?.count ?? 0;
  if (matched.callIds.length === 0) {
    return {
      outcome: "refused:no_calls",
      detail: { imported, matched: 0, sampled: 0, noCustomerAudio },
      bulkId: null,
    };
  }

  // 4. Draw. Per agent, seeded on (schedule, day, agent) -- W-3.
  const rows = await db
    .select({
      id: benchmarkCallsTable.id,
      assistantId: benchmarkCallsTable.sourceAssistantId,
    })
    .from(benchmarkCallsTable)
    .where(inArray(benchmarkCallsTable.id, matched.callIds));
  const candidates: SampleCandidate[] = rows.map((r) => ({
    id: r.id,
    assistantId: r.assistantId,
  }));
  const { picks } = sampleForDay({
    scheduleId: schedule.id,
    day,
    sampleSize: schedule.sampleSize,
    calls: candidates,
  });
  const picked = picks.flatMap((p) => p.callIds);
  const shortfall = picks.reduce((sum, p) => sum + p.shortfall, 0);
  const counts: WatchRunDetail = {
    imported,
    matched: matched.callIds.length,
    sampled: picked.length,
    shortfall,
    noCustomerAudio,
  };
  // Reachable: `sample_size` is an ordinary integer column and a policy set
  // to 0 draws nothing. A bulk of no calls is not a smaller bulk, it is a
  // launch with nothing in it -- refuse, and say the count that made it so.
  if (picked.length === 0) {
    return { outcome: "refused:no_calls", detail: counts, bulkId: null };
  }

  // 5. Price exactly what will run. Explicit picks only: `resolveCriteriaSelection`
  //    selects precisely those ids when no "who" filter is present, so the
  //    number priced here is the number that gets frozen.
  const bulkCriteria: BulkSelectionCriteria = {
    callIds: picked,
    requireCustomerAudio,
    minCustomerWords: template.selectionCriteria.minCustomerWords,
  };
  const priced = await previewBulkSelection({
    criteria: bulkCriteria,
    providerIds: template.providerIds,
    minDurationSeconds: template.minDurationSeconds,
    maxDurationSeconds: template.maxDurationSeconds ?? null,
    // The channel is already explicit on `bulkCriteria` (W-5f), so this
    // default never decides anything; it is `true` so the answer would be the
    // same if it ever did. M-16's floor keeps the template-launch route's
    // rule: no opinion on file means no floor.
    requireCustomerAudioDefault: true,
    minCustomerWordsDefault: undefined,
  });
  if (!priced.estimate) {
    // No providers on the template, so there is no number to check a cap
    // against. Unknown is not zero: refuse rather than launch blind.
    return { outcome: "refused:no_estimate", detail: counts, bulkId: null };
  }
  const estimatedCents = priced.estimate.totalCostCents;
  const detail: WatchRunDetail = { ...counts, estimatedCents };

  // 6. Both caps. Daily first because it is the cheaper question.
  if (estimatedCents > schedule.dailyCapCents) {
    return { outcome: "refused:daily_cap", detail, bulkId: null };
  }
  const spentThisMonth = await estimatedCentsThisMonth(schedule.id, day);
  if (spentThisMonth + estimatedCents > schedule.monthlyCapCents) {
    return { outcome: "refused:monthly_cap", detail, bulkId: null };
  }

  // 7. Create. This LAUNCHES when the bulk comes back `draft` --
  //    createBulkFromCriteria does it itself, and calling launchBulk here as
  //    well would throw `bulk is running, not launchable`.
  const result = await createBulkWithName({
    schedule,
    day,
    template,
    criteria: bulkCriteria,
  });
  return {
    outcome: result.launched ? "launched" : "held:cost_gate",
    detail,
    bulkId: result.bulk.id,
  };
}

/** "YYYY-MM-01" for the month `day` falls in, and for the month after it.
 *  Built by string, not by `Date`: `watch_runs.day` is stored and compared as
 *  a string in local terms, and routing the month boundary through a Date
 *  would put it back through a timezone -- the one thing every date in Part B
 *  is written to avoid. */
function monthStart(day: string): string {
  return `${day.slice(0, 7)}-01`;
}

function nextMonthStart(day: string): string {
  const year = Number(day.slice(0, 4));
  const month = Number(day.slice(5, 7));
  return month === 12
    ? `${year + 1}-01-01`
    : `${year}-${`${month + 1}`.padStart(2, "0")}-01`;
}

/** This schedule's own estimated spend in `day`'s calendar month, from the
 *  ledger. Its own rows only: another policy's spend is not this policy's cap.
 *  The row being settled right now still reads `started` and carries no
 *  `estimatedCents`, so it cannot count itself.
 *
 *  **Only the days that actually ran count.** A `refused:daily_cap` row
 *  carries the number it refused -- that is the whole point of writing it
 *  down -- and counting it here would let a single expensive refusal eat a
 *  month's budget without a cent having been spent. `held:cost_gate` is the
 *  same: the bulk is parked, nothing has run. Launched and settled days are
 *  the ones that cost money. */
const SPENDING_OUTCOMES = ["launched", "settled"];
export async function estimatedCentsThisMonth(scheduleId: string, day: string): Promise<number> {
  const rows = await db
    .select({ detail: watchRunsTable.detail, outcome: watchRunsTable.outcome })
    .from(watchRunsTable)
    .where(
      and(
        eq(watchRunsTable.scheduleId, scheduleId),
        // A half-open range on the date, NOT `like(day, "2026-09%")`:
        // `day` is a real `date` column and Postgres has no `date ~~ text`
        // operator, so the LIKE form does not fail a type check anywhere --
        // it throws at runtime, inside the tick, and lands as a `failed`
        // ledger row (found exactly that way, 2026-09-17).
        gte(watchRunsTable.day, monthStart(day)),
        lt(watchRunsTable.day, nextMonthStart(day)),
      ),
    );
  return rows
    .filter((r) => SPENDING_OUTCOMES.includes(r.outcome))
    .reduce((sum, r) => sum + (r.detail?.estimatedCents ?? 0), 0);
}

/**
 * FR-BLK-2 names a bulk by day, and two policies launching on one day would
 * collide. The name carries the schedule as well -- and the day comes from
 * the ledger's own string, which came from `localDay()`, never from
 * `toISOString()`, which is UTC and would name the 15th's bulk `2026-09-14`
 * on this machine (see docs/backlog/good-to-have.md).
 *
 * A name collision is still possible if a person has already used this exact
 * name. It is retried once under a time suffix rather than failing the day:
 * `benchmark_bulks_watch_schedule_day_unique` is what stops a second bulk for
 * the day, so a retry here cannot double-spend, and leaving the day
 * permanently unrunnable because somebody squatted a name would be the worse
 * outcome.
 */
async function createBulkWithName(input: {
  schedule: ScheduleRow;
  day: string;
  template: typeof bulkTemplatesTable.$inferSelect;
  criteria: BulkSelectionCriteria;
}): Promise<Awaited<ReturnType<typeof createBulkFromCriteria>>> {
  const { schedule, day, template, criteria } = input;
  const base = `${template.name} ${day} watch-${schedule.id.slice(0, 8)}`;
  const attempt = (name: string) =>
    createBulkFromCriteria({
      name,
      criteria,
      providerIds: template.providerIds,
      shardSize: template.shardSize,
      minDurationSeconds: template.minDurationSeconds,
      maxDurationSeconds: template.maxDurationSeconds ?? null,
      // Never true. The cost gate is the last thing between an underestimated
      // day and a real bill, and a scheduler has nobody to ask.
      confirm: false,
      actorLabel: WATCH_ACTOR_LABEL,
      // W-5f: explicit on `criteria` already; `true` so preview and creation
      // answer alike if a caller ever passes criteria without it.
      requireCustomerAudioDefault: true,
      minCustomerWordsDefault: undefined,
      watchScheduleId: schedule.id,
      watchDay: day,
    });
  try {
    return await attempt(base);
  } catch (err) {
    if (err instanceof BulkNameConflictError) {
      return await attempt(`${base} ${Date.now()}`);
    }
    throw err;
  }
}
