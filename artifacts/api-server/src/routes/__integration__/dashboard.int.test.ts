// T-158: GET /api/benchmark/dashboard against the throwaway database. The
// Overview is the most-loaded read in the app and the compile check (T-152)
// can only hold its payload shape -- a query that throws, a wrong filter or
// a wrong aggregate still answers 200 with wrong numbers. These tests hold
// the numbers.
//
// The dashboard aggregates over the WHOLE database, so every assertion is a
// delta between a GET taken before seeding and one taken after -- exact
// global counts would break on any leftover row from a crashed earlier run.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import request from "supertest";
import { eq } from "drizzle-orm";
import { benchmarkProvidersTable, benchmarkRunsTable, db, pool } from "@workspace/db";
import app from "../../app";
import { Fixtures } from "./fixtures";

const fx = new Fixtures();

async function getDashboard() {
  const res = await request(app).get("/api/benchmark/dashboard");
  expect(res.status).toBe(200);
  return res.body;
}

afterAll(async () => {
  await fx.cleanup();
  await pool.end();
});

describe("GET /api/benchmark/dashboard", () => {
  it("moves the corpus, ready and provider counts by exactly what was seeded", async () => {
    const before = await getDashboard();

    await fx.call({ status: "ready_to_run" });
    await fx.call({ status: "archived" });
    await fx.provider();

    const after = await getDashboard();
    expect(after.corpusCount).toBe(before.corpusCount + 2);
    expect(after.readyToRunCount).toBe(before.readyToRunCount + 1);
    expect(after.totalProviderCount).toBe(before.totalProviderCount + 1);
  });

  it("derives provider status truthfully: a seeded 'ready' with no adapter is forced back to not_configured", async () => {
    // FR-P3: "ready" is derived from adapter + env key on every dashboard
    // read, never trusted from the row. A fixture id matches no adapter,
    // so a hand-planted "ready" must not survive one GET.
    const provider = await fx.provider({ status: "ready" });
    const before = await getDashboard();

    const [row] = await db
      .select({ status: benchmarkProvidersTable.status })
      .from(benchmarkProvidersTable)
      .where(eq(benchmarkProvidersTable.id, provider.id));
    expect(row.status).toBe("not_configured");
    // And it was never counted as configured.
    const after = await getDashboard();
    expect(after.configuredProviderCount).toBe(before.configuredProviderCount);
  });

  it("latestRunStatus follows the newest run and skips an archived one (T-134)", async () => {
    const newest = await fx.run({ status: "complete" });
    let body = await getDashboard();
    expect(body.latestRunStatus).toBe("complete");

    // Archive the newest; the next-newest (seeded 1s older, failed) must
    // win. 1s, not more: latestRunStatus is a GLOBAL latest, so the seeded
    // pair must be the two newest rows -- suite files run serially and
    // nothing else writes runs inside that second (a wider gap let a
    // stranded row from a crashed earlier cleanup slip between them, found
    // the hard way).
    await fx.run({
      status: "failed",
      createdAt: new Date(newest.createdAt.getTime() - 1_000),
    });
    await db
      .update(benchmarkRunsTable)
      .set({ archivedAt: new Date() })
      .where(eq(benchmarkRunsTable.id, newest.id));
    body = await getDashboard();
    expect(body.latestRunStatus).toBe("failed");
  });

  it("thisMonth folds a priced score into the sum and a costless one into the unpriced count", async () => {
    const before = await getDashboard();

    const provider = await fx.provider();
    const call = await fx.call();
    // One cell per (run, call, provider) -- the T-27 cell key -- so the
    // costless cell sits on a second provider.
    const providerB = await fx.provider();
    const run = await fx.run({ providerIds: [provider.id, providerB.id], callIds: [call.id], callCount: 1 });
    const priced = await fx.result(run.id, call.id, provider.id);
    await fx.score(priced.id, { costMicrocents: 12_345 });
    const unpriced = await fx.result(run.id, call.id, providerB.id);
    await fx.score(unpriced.id, { costMicrocents: null });

    const after = await getDashboard();
    expect(after.thisMonth.sttMicrocents).toBe(before.thisMonth.sttMicrocents + 12_345);
    expect(after.thisMonth.sttCellsPriced).toBe(before.thisMonth.sttCellsPriced + 1);
    expect(after.thisMonth.sttCellsUnpriced).toBe(before.thisMonth.sttCellsUnpriced + 1);
    // Never folded into the sum as zero (the T-154 field rule).
    expect(after.thisMonth.monthStart).toBe(before.thisMonth.monthStart);
  });
});
