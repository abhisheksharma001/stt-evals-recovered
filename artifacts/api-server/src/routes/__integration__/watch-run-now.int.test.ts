// W-9: POST /api/benchmark/watch-schedules/:scheduleId/run-now -- one
// schedule's day by hand, through the tick's own loop body (`runScheduleDay`).
//
// SAFETY. This route runs the money step's body, so what keeps this file free
// is written down:
//
//   1. Every schedule here carries an `accountId` that no env var backs
//      (`fx-account-<suffix>`, the fixture default). `runOneSchedule` asks
//      `listVapiAccounts()` -- env-var NAMES -- before any network call, and
//      an account it has never heard of is `refused:no_key`. Vapi is never
//      reached, with or without a real key in the environment (T-168).
//   2. No provider is seeded at all, so nothing here can reach a
//      transcription API even if a bulk were created. None is.
//
// Never put a real account id in this file.
import { afterAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import request from "supertest";
import { db, pool, benchmarkBulksTable, watchRunsTable } from "@workspace/db";
import { localDay } from "../../lib/watch-scheduler";
import { server } from "./server";
import { Fixtures } from "./fixtures";

const fx = new Fixtures();
// Ledger rows the ROUTE writes are not tracked by the fixture (it only tracks
// the ones it inserts itself), and a schedule cannot be deleted under a row
// that references it -- so they are removed here, by schedule, first.
const scheduleIds: string[] = [];

afterAll(async () => {
  for (const id of scheduleIds) {
    await db.delete(watchRunsTable).where(eq(watchRunsTable.scheduleId, id));
  }
  await fx.cleanup();
  await pool.end();
});

const runNow = (scheduleId: string) =>
  request(server).post(`/api/benchmark/watch-schedules/${scheduleId}/run-now`).set("x-actor", fx.actor);

const ledgerFor = (scheduleId: string) =>
  db.select().from(watchRunsTable).where(eq(watchRunsTable.scheduleId, scheduleId));

describe("POST /api/benchmark/watch-schedules/:scheduleId/run-now", () => {
  it("answers 404 for a schedule that does not exist, and writes nothing", async () => {
    const res = await runNow("00000000-0000-4000-8000-000000000000");
    expect(res.status).toBe(404);
    expect(res.body.error).toMatch(/not found/);
  });

  it("refuses a disabled schedule with 409 and no ledger row -- the off switch stays off", async () => {
    const schedule = await fx.schedule({ enabled: false });
    scheduleIds.push(schedule.id);

    const res = await runNow(schedule.id);
    expect(res.status).toBe(409);
    expect(res.body.error).toMatch(/disabled/);
    expect(await ledgerFor(schedule.id)).toHaveLength(0);
  });

  it("runs an enabled schedule through the ledger and answers the row verbatim, refusal included", async () => {
    // Enabled is opted into here only, and it is safe because the suite runs
    // one file at a time (`fileParallelism: false`): no tick in another file
    // can claim this schedule's day while this file owns it.
    const schedule = await fx.schedule({ enabled: true });
    scheduleIds.push(schedule.id);

    const res = await runNow(schedule.id);
    expect(res.status).toBe(200);
    const rows = await ledgerFor(schedule.id);
    expect(rows).toHaveLength(1);
    expect(rows[0].day).toBe(localDay(new Date()));
    expect(res.body).toEqual({
      scheduleId: schedule.id,
      day: rows[0].day,
      outcome: "refused:no_key",
      bulkId: null,
      detail: {},
    });

    // No bulk exists for a refusal.
    const bulks = await db
      .select({ id: benchmarkBulksTable.id })
      .from(benchmarkBulksTable)
      .where(eq(benchmarkBulksTable.watchScheduleId, schedule.id));
    expect(bulks).toHaveLength(0);

    // A second hand run of the same day is not a second run.
    const again = await runNow(schedule.id);
    expect(again.status).toBe(409);
    expect(again.body.error).toMatch(/already in the ledger .*refused:no_key/);
    expect(await ledgerFor(schedule.id)).toHaveLength(1);
  });

  it("writes an audit row naming who ran it", async () => {
    const schedule = await fx.schedule({ enabled: true });
    scheduleIds.push(schedule.id);
    expect((await runNow(schedule.id)).status).toBe(200);

    const audit = await request(server)
      .get("/api/benchmark/audit-log")
      .query({ entityType: "watch_schedule", entityId: schedule.id });
    expect(audit.status).toBe(200);
    const runs = (audit.body as { action: string; actorLabel: string }[]).filter((a) => a.action === "run_now");
    expect(runs).toHaveLength(1);
    expect(runs[0].actorLabel).toBe(fx.actor);
  });
});
