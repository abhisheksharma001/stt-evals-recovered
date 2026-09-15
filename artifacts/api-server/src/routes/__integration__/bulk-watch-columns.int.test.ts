// W-5c1: `benchmark_bulks.watch_schedule_id` + `watch_day`, held against the
// real database.
//
// These two columns are the second refusal on the money path. W-5a's
// `watch_runs_schedule_day_unique` already stops a second tick for the same
// (schedule, day) before any work happens; this pair stops a second BULK for
// that pair even if the ledger row were bypassed -- a bad merge, a hand-run
// insert, a future backfill script. Two independent refusals, not one, is the
// whole reason the columns exist, so the index is what this file pins.
//
// The trap it also pins: Postgres treats NULLs as DISTINCT in a unique index.
// Every bulk a person creates leaves both columns null, so a unique CONSTRAINT
// (or an index declared NULLS NOT DISTINCT) would let exactly one hand-made
// bulk exist in the entire database and 500 on the second. That case is here
// on purpose -- it is the failure that would reach production first.
//
// SAFETY: nothing here spends. Every provider is a Fixtures provider whose id
// (`fx-<suffix>-N`) matches no adapter in the registry, and the per-minute
// rate is set high enough that every created bulk lands over the FR-BLK-5
// cost gate at `awaiting_confirmation` -- so `createBulkFromCriteria` never
// reaches its own `launchBulk` call and no run is ever created. That is
// deliberate rather than incidental: a test that launched would leave
// fire-and-forget work running past its own cleanup.
import { afterAll, describe, expect, it } from "vitest";
import { and, eq } from "drizzle-orm";
import { db, pool, benchmarkBulksTable } from "@workspace/db";
import { BulkWatchDayConflictError, createBulkFromCriteria } from "../../lib/bulks";
import { Fixtures } from "./fixtures";

const fx = new Fixtures();

afterAll(async () => {
  await fx.cleanup();
  await pool.end();
});

/** One call and one very expensive provider, so the bulk parks at
 *  `awaiting_confirmation` instead of launching -- see the safety note. */
async function scope() {
  const accountLabel = `fx-watch-${fx.suffix}`;
  await fx.call({ durationSeconds: 120, sourceAccountLabel: accountLabel });
  const provider = await fx.provider({ costPerMinute: 1000 });
  return {
    criteria: { accountLabel, requireCustomerAudio: false, minCustomerWords: 0 },
    providerIds: [provider.id],
    minDurationSeconds: 0,
    maxDurationSeconds: null,
    actorLabel: fx.actor,
    requireCustomerAudioDefault: false,
    minCustomerWordsDefault: undefined,
  };
}

describe("benchmark_bulks watch columns (W-5c1)", () => {
  it("writes the pair through, and leaves it null for a bulk a person creates", async () => {
    const base = await scope();
    const schedule = await fx.schedule();

    const scheduled = await createBulkFromCriteria({
      ...base,
      name: `fx-watch-scheduled-${fx.suffix}`,
      watchScheduleId: schedule.id,
      watchDay: "2026-09-15",
    });
    fx.adoptBulk(scheduled.bulk.id);
    // Not launched: the safety note's whole argument rests on this being
    // true, so it is asserted rather than assumed.
    expect(scheduled.launched).toBe(false);
    expect(scheduled.bulk.status).toBe("awaiting_confirmation");
    expect(scheduled.bulk.watchScheduleId).toBe(schedule.id);
    // A string, not a Date: `date(..., { mode: "string" })`, the same mode
    // `watch_runs.day` uses, so the two can be compared without either side
    // going through a timezone.
    expect(scheduled.bulk.watchDay).toBe("2026-09-15");

    const byHand = await createBulkFromCriteria({
      ...base,
      name: `fx-watch-byhand-${fx.suffix}`,
    });
    fx.adoptBulk(byHand.bulk.id);
    expect(byHand.bulk.watchScheduleId).toBeNull();
    expect(byHand.bulk.watchDay).toBeNull();
  });

  it("refuses a second bulk for the same schedule and day, under its own error", async () => {
    const base = await scope();
    const schedule = await fx.schedule();

    const first = await createBulkFromCriteria({
      ...base,
      name: `fx-watch-first-${fx.suffix}`,
      watchScheduleId: schedule.id,
      watchDay: "2026-09-14",
    });
    fx.adoptBulk(first.bulk.id);

    // A DIFFERENT name on purpose. If the pair were not indexed this would
    // simply succeed, and if the two unique indexes were not told apart the
    // error would come back as a name clash -- which the template launch
    // route retries under a suffixed name, turning the one refusal that
    // matters into a second bulk for a day already paid for.
    let caught: unknown;
    try {
      await createBulkFromCriteria({
        ...base,
        name: `fx-watch-second-${fx.suffix}`,
        watchScheduleId: schedule.id,
        watchDay: "2026-09-14",
      });
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(BulkWatchDayConflictError);

    const rows = await db
      .select({ id: benchmarkBulksTable.id })
      .from(benchmarkBulksTable)
      .where(
        and(
          eq(benchmarkBulksTable.watchScheduleId, schedule.id),
          eq(benchmarkBulksTable.watchDay, "2026-09-14"),
        ),
      );
    expect(rows).toHaveLength(1);
    expect(rows[0].id).toBe(first.bulk.id);
  });

  it("is keyed on the pair, so another day and another schedule both go in", async () => {
    // Written as three rows rather than by trusting the index name, same
    // reason as the ledger's own case: an index on schedule alone passes the
    // case above and fails here, and an index on day alone does the reverse.
    const a = await fx.schedule();
    const b = await fx.schedule();
    await fx.bulk({ watchScheduleId: a.id, watchDay: "2026-09-10" });
    await fx.bulk({ watchScheduleId: a.id, watchDay: "2026-09-11" });
    await fx.bulk({ watchScheduleId: b.id, watchDay: "2026-09-10" });

    const forA = await db
      .select({ day: benchmarkBulksTable.watchDay })
      .from(benchmarkBulksTable)
      .where(eq(benchmarkBulksTable.watchScheduleId, a.id));
    expect(forA.map((r) => r.day).sort()).toEqual(["2026-09-10", "2026-09-11"]);
    const forB = await db
      .select({ day: benchmarkBulksTable.watchDay })
      .from(benchmarkBulksTable)
      .where(eq(benchmarkBulksTable.watchScheduleId, b.id));
    expect(forB.map((r) => r.day)).toEqual(["2026-09-10"]);
  });

  it("lets two unscheduled bulks coexist, because NULLs are distinct", async () => {
    // The production-first failure. Every bulk created by hand carries two
    // nulls; under NULLS NOT DISTINCT the second one in the entire database
    // would 500.
    const one = await fx.bulk();
    const two = await fx.bulk();
    expect(one.watchScheduleId).toBeNull();
    expect(two.watchScheduleId).toBeNull();
    expect(one.id).not.toBe(two.id);
  });

  it("refuses a half-filled pair before it touches the database", async () => {
    const base = await scope();
    const schedule = await fx.schedule();
    // A bulk that knows its schedule but not its day cannot be matched to
    // its ledger row, and the index treats a half-filled pair as distinct
    // from every other -- so it would refuse nothing. Cheaper to refuse the
    // argument than to store the ambiguity.
    await expect(
      createBulkFromCriteria({ ...base, name: `fx-watch-half-${fx.suffix}`, watchScheduleId: schedule.id }),
    ).rejects.toThrow("watchScheduleId and watchDay must be set together");
  });
});
