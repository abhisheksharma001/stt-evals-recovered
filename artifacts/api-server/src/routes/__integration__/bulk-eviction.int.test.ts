// M-3c: FR-BLK-10 evicts the oldest bulk when a new one would exceed
// MAX_LIVE_BULKS. benchmark_agent_scans.run_id carries no ON DELETE, so once
// the run executor started writing a scan per run (e0399cc, after this
// eviction was written), the scan row blocked the cascade into
// benchmark_runs and EVERY launch at the cap answered 500. Found live
// 2026-09-04 launching a template against the real corpus.
//
// Nothing here spends: POST /benchmark/bulks only creates the bulk row, and
// the fixture provider id matches no adapter.
import { afterAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import request from "supertest";
import { db, pool, benchmarkAgentScansTable, benchmarkBulksTable } from "@workspace/db";
import app from "../../app";
import { Fixtures } from "./fixtures";

const fx = new Fixtures();

afterAll(async () => {
  await fx.cleanup();
  await pool.end();
});

describe("POST /api/benchmark/bulks at the bulk cap", () => {
  it("evicts the oldest bulk even when one of its runs has an agent scan", async () => {
    // Back-dated so this is the globally oldest bulk in the shared test
    // database -- eviction takes the oldest, and every other suite's bulk is
    // newer than this. Three of ours guarantee the cap is reached whatever
    // else is present, so the test does not depend on suite order.
    const doomed = await fx.bulk({ createdAt: new Date("2020-01-01T00:00:00Z") });
    await fx.bulk({ createdAt: new Date("2020-01-02T00:00:00Z") });
    await fx.bulk({ createdAt: new Date("2020-01-03T00:00:00Z") });

    const scannedCall = await fx.call({ durationSeconds: 60 });
    const doomedRun = await fx.run({ bulkId: doomed.id, purpose: "batch" });
    // The row that used to block the whole thing.
    const scan = await fx.scan(scannedCall.id, { runId: doomedRun.id, status: "flagged" });

    const accountLabel = `fx-evict-${fx.suffix}`;
    const fresh = await fx.call({ durationSeconds: 60, sourceAccountLabel: accountLabel });
    const provider = await fx.provider({ costPerMinute: 0.5 });

    const res = await request(app)
      .post("/api/benchmark/bulks")
      .set("x-actor", fx.actor)
      .send({
        name: `evicts the oldest ${fx.suffix}`,
        criteria: { accountLabel },
        providerIds: [provider.id],
        minDurationSeconds: 30,
        maxDurationSeconds: 300,
      });

    // Before M-3c this was 500 with a foreign-key violation.
    expect(res.status).toBe(201);
    // FR-BLK-1: the selection is frozen into the row, so this also says the
    // new bulk got the call it was supposed to.
    expect(res.body.selectionCriteria.resolvedCallIds).toEqual([fresh.id]);
    fx.adoptBulk(res.body.id);

    // The oldest bulk really went.
    const gone = await db.select().from(benchmarkBulksTable).where(eq(benchmarkBulksTable.id, doomed.id));
    expect(gone).toHaveLength(0);

    // ...and the scan survived it, detached rather than destroyed. It is
    // keyed by a call the corpus still holds, and its judge verdict cost
    // real money -- eviction throws away runs and rankings, not that.
    const [kept] = await db.select().from(benchmarkAgentScansTable).where(eq(benchmarkAgentScansTable.id, scan.id));
    expect(kept).toBeDefined();
    expect(kept.runId).toBeNull();
    expect(kept.callId).toBe(scannedCall.id);
    // The call it describes is untouched -- eviction never reaches the corpus.
    const stillThere = await request(app).get(`/api/benchmark/calls/${scannedCall.id}`);
    expect(stillThere.status).toBe(200);
  });
});
