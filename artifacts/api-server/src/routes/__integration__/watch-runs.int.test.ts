// W-5a: the watch ledger's two constraints, held against the real database.
//
// Nothing writes a ledger row yet -- W-5c's tick does. What can be proved now
// is the shape of the table, and both halves of that shape are load-bearing
// enough that getting either wrong would be found in production instead:
//
// 1. The unique index on (schedule_id, day) IS the idempotency. The tick
//    inserts the row BEFORE it does any work, so a second tick for the same
//    day must bounce off the database rather than off a flag in memory -- a
//    flag dies with the process, and surviving a restart without re-spending
//    the day is the entire reason the ledger exists.
// 2. `bulk_id` is ON DELETE SET NULL, because FR-BLK-10 deletes bulks
//    routinely. This is the M-3c bug class: a plain reference into the
//    eviction path made every launch at the cap answer 500, and it cost a
//    live launch to find. W-13 just raised MAX_LIVE_BULKS to 10, so the
//    eleventh scheduled day is when this would have bitten.
//
// Nothing here spends: POST /benchmark/bulks only creates the bulk row, and
// the fixture provider id matches no adapter.
import { afterAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import request from "supertest";
import { db, pool, benchmarkBulksTable, watchRunsTable } from "@workspace/db";
import { MAX_LIVE_BULKS, isUniqueViolation } from "../../lib/bulks";
import { server } from "./server";
import { Fixtures } from "./fixtures";

const fx = new Fixtures();

afterAll(async () => {
  await fx.cleanup();
  await pool.end();
});

describe("watch_runs, the ledger", () => {
  it("refuses a second row for the same schedule and day, with the violation the tick branches on", async () => {
    const schedule = await fx.schedule();
    const first = await fx.watchRun(schedule.id, "2026-09-14");

    // Not just "it threw": the tick's whole design is "insert first, and if
    // the insert loses, stop" -- so it has to be able to tell THIS failure
    // from a dead connection. isUniqueViolation is the same predicate
    // bulks.ts already branches on for the duplicate bulk name.
    let caught: unknown;
    try {
      await fx.watchRun(schedule.id, "2026-09-14", { outcome: "failed" });
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeDefined();
    expect(isUniqueViolation(caught)).toBe(true);

    // And the loser wrote nothing: the row that survives is the first one,
    // with its own outcome, not the second one's.
    const rows = await db.select().from(watchRunsTable).where(eq(watchRunsTable.scheduleId, schedule.id));
    expect(rows).toHaveLength(1);
    expect(rows[0].id).toBe(first.id);
    expect(rows[0].outcome).toBe("launched");
  });

  it("is keyed on the pair, so another day and another schedule both go in", async () => {
    // Written as three separate rows rather than by trusting the index name:
    // an index on schedule_id alone would pass the case above and fail here,
    // and an index on day alone would do the reverse.
    const a = await fx.schedule();
    const b = await fx.schedule();
    await fx.watchRun(a.id, "2026-09-10");
    await fx.watchRun(a.id, "2026-09-11");
    await fx.watchRun(b.id, "2026-09-10");

    const forA = await db.select().from(watchRunsTable).where(eq(watchRunsTable.scheduleId, a.id));
    expect(forA.map((r) => r.day).sort()).toEqual(["2026-09-10", "2026-09-11"]);
    const forB = await db.select().from(watchRunsTable).where(eq(watchRunsTable.scheduleId, b.id));
    expect(forB.map((r) => r.day)).toEqual(["2026-09-10"]);
  });

  it("survives its bulk being evicted, detached rather than deleted", async () => {
    // This case counts every bulk row, so it starts from a known one. The
    // suite refuses to start unless TEST_DATABASE_URL is set and differs from
    // DATABASE_URL (vitest.integration.config.ts), so the only table this can
    // reach is the throwaway one, and files run one at a time
    // (fileParallelism: false) with each file cleaning up after itself.
    await db.delete(benchmarkBulksTable);

    // Exactly the cap, back-dated a day apart, so the oldest is unambiguous
    // and the very next create must evict it. In terms of the constant, not
    // a literal: this case is about the FK, and W-13 has already shown what
    // happens to a case that quietly encodes the cap it was written under.
    const bulks = [];
    for (let i = 0; i < MAX_LIVE_BULKS; i++) {
      bulks.push(await fx.bulk({ createdAt: new Date(Date.UTC(2020, 0, 1 + i)) }));
    }
    const doomed = bulks[0];

    const schedule = await fx.schedule();
    // A settled row: the day's numbers are already copied off the bulk, which
    // is the state that makes the detach safe to do at all. If the ledger
    // still needed the bulk to answer "how did the 14th go", eviction would
    // be losing history rather than clearing a workbench.
    const ledger = await fx.watchRun(schedule.id, "2026-09-14", {
      bulkId: doomed.id,
      outcome: "settled",
      detail: { imported: 42, matched: 12, sampled: 10 },
      totals: [
        {
          assistantId: "fx-assistant",
          providerId: "fx-provider",
          peerFlags: 3,
          words: 900,
          callsScored: 10,
          cleanCalls: 7,
        },
      ],
    });

    const accountLabel = `fx-ledger-evict-${fx.suffix}`;
    await fx.call({ durationSeconds: 60, sourceAccountLabel: accountLabel });
    const provider = await fx.provider({ costPerMinute: 0.5 });

    const res = await request(server)
      .post("/api/benchmark/bulks")
      .set("x-actor", fx.actor)
      .send({
        name: `evicts under a ledger row ${fx.suffix}`,
        // M-5/M-16: said out loud because this case is about the foreign key,
        // not about the audio channel or how much the caller said -- a
        // fixture call has no draft transcript at all.
        criteria: { accountLabel, requireCustomerAudio: false, minCustomerWords: 0 },
        providerIds: [provider.id],
        minDurationSeconds: 30,
        maxDurationSeconds: 300,
      });

    // With a plain reference instead of ON DELETE SET NULL this is 500, and
    // so is every other launch at the cap from that day on.
    expect(res.status).toBe(201);
    fx.adoptBulk(res.body.id);

    const gone = await db.select().from(benchmarkBulksTable).where(eq(benchmarkBulksTable.id, doomed.id));
    expect(gone).toHaveLength(0);

    const [kept] = await db.select().from(watchRunsTable).where(eq(watchRunsTable.id, ledger.id));
    expect(kept).toBeDefined();
    expect(kept.bulkId).toBeNull();
    // Everything the 30-day line reads is still here. Asserted field by
    // field rather than as "the row exists": a cascade that emptied the row
    // and left the id would pass a weaker check.
    expect(kept.day).toBe("2026-09-14");
    expect(kept.outcome).toBe("settled");
    expect(kept.detail).toEqual({ imported: 42, matched: 12, sampled: 10 });
    expect(kept.totals?.[0].peerFlags).toBe(3);
    expect(kept.totals?.[0].callsScored).toBe(10);
  });
});
