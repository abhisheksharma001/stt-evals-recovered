// W-5c2: `runWatchTick` -- the money step's body, held against the real
// database.
//
// SAFETY, read before editing. This file exercises the one function in the
// repo whose job is to spend provider money, so what keeps it free is written
// down rather than assumed:
//
//   1. The Vapi half is INJECTED (`source`). Every case here passes a fake,
//      so no preview and no import can leave the machine -- with or without a
//      VAPI key in the environment (T-168).
//   2. Every provider is a Fixtures provider whose id (`fx-<suffix>-N`)
//      matches no adapter in the registry, so even the case that launches
//      cannot reach a transcription API.
//   3. No provider is ever seeded `ready`, here or anywhere in this suite.
//
// Never put a real provider id or a real Vapi account id in this file.
import { afterAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import {
  db,
  pool,
  benchmarkBulksTable,
  watchRunsTable,
  watchSchedulesTable as watchSchedulesRef,
} from "@workspace/db";
import { runWatchTick, type WatchTickSource } from "../../lib/watch-tick";
import { UnknownVapiAccountError } from "../../lib/vapi-import";
import { Fixtures } from "./fixtures";

const fx = new Fixtures();

afterAll(async () => {
  await fx.cleanup();
  await pool.end();
});

/** 09:00 local on the 15th -- past the default `hourLocal` of 3, and built
 *  with the local constructor, never an ISO string. `hour_local` is local to
 *  the PROCESS (`watch_schedules` carries no timezone column), so a date
 *  built from an ISO string asserts UTC and would pass on a UTC+5:30 laptop
 *  and fail on CI. Same rule as W-5b's unit tests. */
const NOW = new Date(2026, 8, 15, 9, 0);
const DAY = "2026-09-15";

/** A source that hands the tick nothing new from Vapi. The corpus rows the
 *  cases need are inserted directly, so "what Vapi has" and "what is already
 *  imported" stay two separate questions.
 *
 *  The account label it answers with is derived from the account it was
 *  ASKED about, never a fixed one. A fake that answered this file's label for
 *  every account would make another suite's schedule resolve to this file's
 *  calls, and the tick would launch a bulk under a policy this file does not
 *  own -- which is exactly what happened the first time this ran. */
function quietSource(overrides: Partial<WatchTickSource> = {}): {
  source: WatchTickSource;
  /** Mutable on purpose: `Object.assign` with a getter copies the getter's
   *  VALUE at assign time, which reads 0 forever. */
  state: { previewCalls: number; previewsByAccount: Record<string, number> };
} {
  const state = { previewCalls: 0, previewsByAccount: {} as Record<string, number> };
  const source = {
    preview: async (input: { accountId: string }) => {
      state.previewCalls += 1;
      state.previewsByAccount[input.accountId] = (state.previewsByAccount[input.accountId] ?? 0) + 1;
      return {
        accountId: input.accountId,
        accountLabel: labelForAccount(input.accountId),
        fetchedCount: 0,
        importableCount: 0,
        calls: [],
      };
    },
    import: async () => ({ importedCount: 0, skippedCount: 0, failedCount: 0, results: [] }),
    ...overrides,
  } as unknown as WatchTickSource;
  return { source, state };
}

/** One label per account, so a schedule this file does not own resolves to a
 *  label no call in the corpus carries. */
function labelForAccount(accountId: string): string {
  return `label-of-${accountId}`;
}

/** One schedule whose template matches one in-window call, priced by one
 *  provider. `costPerMinute` is the dial every cap case turns. */
let policyCount = 0;

async function policy(opts: {
  costPerMinute: number;
  dailyCapCents?: number;
  monthlyCapCents?: number;
  calls?: number;
}) {
  const accountId = `fx-account-${fx.suffix}-${policyCount++}`;
  const accountLabel = labelForAccount(accountId);
  const provider = await fx.provider({ costPerMinute: opts.costPerMinute });
  for (let i = 0; i < (opts.calls ?? 3); i += 1) {
    await fx.call({
      durationSeconds: 120,
      sourceAccountLabel: accountLabel,
      sourceStartedAt: new Date(NOW.getTime() - 60 * 60 * 1000),
      sourceAssistantId: `fx-agent-${i % 2}`,
    });
  }
  const template = await fx.template({
    providerIds: [provider.id],
    minDurationSeconds: 0,
    // The fixture calls carry no draft transcript, so an inherited M-16 floor
    // would empty the selection and turn every case below into no_calls.
    selectionCriteria: { requireCustomerAudio: false, minCustomerWords: 0 },
  });
  const schedule = await fx.schedule({
    templateId: template.id,
    accountId,
    // The fixture default is `false` so no other suite's tick can act on it;
    // this is the file that ticks, so this is the file that opts in.
    enabled: true,
    sampleSize: 2,
    hourLocal: 3,
    dailyCapCents: opts.dailyCapCents ?? 100,
    monthlyCapCents: opts.monthlyCapCents ?? 3000,
  });
  return { schedule, template, provider, accountId, accountLabel };
}

async function ledgerFor(scheduleId: string) {
  const rows = await db.select().from(watchRunsTable).where(eq(watchRunsTable.scheduleId, scheduleId));
  for (const r of rows) fx.adoptWatchRun(r.id);
  return rows;
}

async function bulksFor(scheduleId: string) {
  const rows = await db
    .select()
    .from(benchmarkBulksTable)
    .where(eq(benchmarkBulksTable.watchScheduleId, scheduleId));
  for (const r of rows) fx.adoptBulk(r.id);
  return rows;
}

describe("runWatchTick (W-5c2)", () => {
  it("claims the day before it works, so two ticks at once import once", async () => {
    const { schedule, accountId } = await policy({ costPerMinute: 0.01 });
    const { source, state } = quietSource();

    // CONCURRENT, not one after the other, and that is the whole test. A
    // second tick that starts AFTER the first has finished never reaches the
    // insert at all -- it reads the ledger, sees the day, and skips at
    // `decideTick`. Written sequentially this case passes with the claim
    // moved to after the import, which is a test that pins nothing (found
    // exactly that way while running the break test, 2026-09-17).
    //
    // Two ticks that start together both read an empty ledger and both decide
    // to run. From there only the order of the insert decides it: claim
    // first, and the loser bounces off watch_runs_schedule_day_unique before
    // touching Vapi. Claim last, and both import a day's calls and both try
    // to launch -- twice the money, with nobody watching.
    const [a, b] = await Promise.all([
      runWatchTick({ now: NOW, source }),
      runWatchTick({ now: NOW, source }),
    ]);

    // Counted for THIS account only: the tick reads every enabled schedule in
    // the database, and other suites run against it at the same time.
    expect(state.previewsByAccount[accountId]).toBe(1);
    // Exactly one of the two did the day; the other did nothing at all.
    const ran = [...a, ...b].filter((r) => r.scheduleId === schedule.id);
    expect(ran).toHaveLength(1);
    expect(ran[0].day).toBe(DAY);

    const rows = await ledgerFor(schedule.id);
    expect(rows).toHaveLength(1);
    expect(await bulksFor(schedule.id)).toHaveLength(1);
  });

  it("refuses an account this server holds no key for, and writes no bulk", async () => {
    const { schedule } = await policy({ costPerMinute: 0.01 });
    const { source } = quietSource({
      preview: async () => {
        throw new UnknownVapiAccountError(schedule.accountId);
      },
    });

    const [result] = await runWatchTick({ now: NOW, source });
    expect(result.outcome).toBe("refused:no_key");
    expect(result.bulkId).toBeNull();
    expect(await bulksFor(schedule.id)).toHaveLength(0);

    // The day is still claimed. A missing key is a decision about the day,
    // not a reason to retry it sixty times an hour.
    const rows = await ledgerFor(schedule.id);
    expect(rows).toHaveLength(1);
    expect(rows[0].outcome).toBe("refused:no_key");
  });

  it("refuses above the daily cap, and creates nothing", async () => {
    // 2 calls x 2 min x $10/min = 4000 cents, against a 100 cent cap.
    const { schedule } = await policy({ costPerMinute: 10, dailyCapCents: 100 });

    const [result] = await runWatchTick({ now: NOW, source: quietSource().source });
    expect(result.outcome).toBe("refused:daily_cap");
    expect(await bulksFor(schedule.id)).toHaveLength(0);

    const rows = await ledgerFor(schedule.id);
    // The number it refused on is written down. A refusal that does not say
    // what it priced cannot be argued with later.
    expect(rows[0].detail?.estimatedCents).toBeGreaterThan(100);
    // sampleSize is per AGENT, not per policy: 3 calls across 2 agents at a
    // sample size of 2 draws 2 from one and 1 from the other. A quiet agent
    // is never drowned out by a busy one (W-3), and that is the number the
    // ledger has to report.
    expect(rows[0].detail?.sampled).toBe(3);
  });

  it("counts only its own rows against the monthly cap", async () => {
    const { schedule } = await policy({ costPerMinute: 0.01, monthlyCapCents: 100 });
    // Earlier in the same month, this policy's own spend -- enough that one
    // more day goes over.
    await fx.watchRun(schedule.id, "2026-09-01", { outcome: "launched", detail: { estimatedCents: 99 } });
    // A DIFFERENT policy's expensive month. If this were counted the cap
    // would be a global budget, which is not what the column says.
    const other = await fx.schedule();
    await fx.watchRun(other.id, "2026-09-02", { outcome: "launched", detail: { estimatedCents: 99_000 } });

    const results = await runWatchTick({ now: NOW, source: quietSource().source });
    const mine = results.find((r) => r.scheduleId === schedule.id);
    expect(mine?.outcome).toBe("refused:monthly_cap");
    expect(await bulksFor(schedule.id)).toHaveLength(0);
  });

  it("does not count a refused day against the monthly cap", async () => {
    // The same 99 cents as above, but on a day that REFUSED rather than ran.
    // A refusal writes down the number it refused -- that is what makes it
    // arguable later -- and counting that number as spend would let one
    // expensive refusal eat a month's budget without a cent leaving.
    const { schedule } = await policy({ costPerMinute: 0.01, monthlyCapCents: 100 });
    await fx.watchRun(schedule.id, "2026-09-01", {
      outcome: "refused:daily_cap",
      detail: { estimatedCents: 99 },
    });

    const results = await runWatchTick({ now: NOW, source: quietSource().source });
    const mine = results.find((r) => r.scheduleId === schedule.id);
    expect(mine?.outcome).toBe("launched");
  });

  it("holds at the cost gate instead of launching", async () => {
    // Over the $50 FR-BLK-5 threshold but under this policy's own cap, which
    // is the only window where the gate can fire for a scheduled bulk.
    const { schedule } = await policy({
      costPerMinute: 100,
      dailyCapCents: 10_000_000,
      monthlyCapCents: 10_000_000,
    });

    const [result] = await runWatchTick({ now: NOW, source: quietSource().source });
    expect(result.outcome).toBe("held:cost_gate");

    const bulks = await bulksFor(schedule.id);
    expect(bulks).toHaveLength(1);
    // Parked, not running: the gate is the last thing between an
    // underestimated day and a real bill, and a scheduler has nobody to ask.
    expect(bulks[0].status).toBe("awaiting_confirmation");
    expect(result.bulkId).toBe(bulks[0].id);
  });

  it("launches under the caps, and names the bulk by day and schedule", async () => {
    const { schedule, template } = await policy({ costPerMinute: 0.01 });

    const [result] = await runWatchTick({ now: NOW, source: quietSource().source });
    expect(result.outcome).toBe("launched");

    const bulks = await bulksFor(schedule.id);
    expect(bulks).toHaveLength(1);
    expect(bulks[0].watchDay).toBe(DAY);
    // The name carries the LOCAL day and the schedule, so two policies
    // launching on one day cannot collide on benchmark_bulks_name_unique.
    expect(bulks[0].name).toBe(`${template.name} ${DAY} watch-${schedule.id.slice(0, 8)}`);

    const rows = await ledgerFor(schedule.id);
    expect(rows[0].outcome).toBe("launched");
    expect(rows[0].bulkId).toBe(bulks[0].id);
  });

  it("refuses a day with nothing to sample", async () => {
    // Same policy, but the only calls on file are outside the 24 h window.
    const { schedule, accountLabel } = await policy({ costPerMinute: 0.01, calls: 0 });
    await fx.call({
      durationSeconds: 120,
      sourceAccountLabel: accountLabel,
      sourceStartedAt: new Date(NOW.getTime() - 10 * 24 * 60 * 60 * 1000),
    });

    const [result] = await runWatchTick({ now: NOW, source: quietSource().source });
    expect(result.outcome).toBe("refused:no_calls");
    expect(await bulksFor(schedule.id)).toHaveLength(0);
  });

  it("leaves a disabled policy alone, however long its hour has passed", async () => {
    const { schedule } = await policy({ costPerMinute: 0.01 });
    await db.update(watchSchedulesRef).set({ enabled: false }).where(eq(watchSchedulesRef.id, schedule.id));

    const results = await runWatchTick({ now: NOW, source: quietSource().source });
    expect(results.find((r) => r.scheduleId === schedule.id)).toBeUndefined();
    expect(await ledgerFor(schedule.id)).toHaveLength(0);
  });
});
