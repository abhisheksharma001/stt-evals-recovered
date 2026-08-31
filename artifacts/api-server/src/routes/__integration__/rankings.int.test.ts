// T-159: GET /api/benchmark/rankings against the throwaway database. The
// snapshot table keeps every past recompute forever, so this route's whole
// job is choosing which rows count: a bulk id scopes strictly to that
// bulk's own snapshot; all-time picks each group's newest batch-purpose,
// non-archived run. That choosing is pure query logic the compile check
// cannot see -- these tests hold it.
//
// No VAPI key is set in the test environment, so the live assistant-name
// lookup degrades and labels fall back to the raw id -- itself asserted
// here, since that fallback is what keeps Rankings up when Vapi is down.
import { afterAll, describe, expect, it } from "vitest";
import request from "supertest";
import { eq } from "drizzle-orm";
import { benchmarkRunsTable, db, pool } from "@workspace/db";
import app from "../../app";
import { Fixtures } from "./fixtures";

const fx = new Fixtures();
// One assistant per concern: each is its own ranking group, so nothing
// here competes with leftovers or with the other tests in this file.
const asstScoped = `fx-asst-scoped-${fx.suffix}`;
const asstLatest = `fx-asst-latest-${fx.suffix}`;
const asstAgent = `fx-asst-agent-${fx.suffix}`;

async function getRankings(query: Record<string, string> = {}) {
  const res = await request(app).get("/api/benchmark/rankings").query(query);
  expect(res.status).toBe(200);
  return res.body as { assistantId: string | null; assistantLabel: string; providerId: string; rank: number; runId: string }[];
}

afterAll(async () => {
  await fx.cleanup();
  await pool.end();
});

describe("GET /api/benchmark/rankings", () => {
  it("bulkId scopes strictly to that bulk's snapshot, in rank order", async () => {
    const bulk = await fx.bulk();
    const run = await fx.run({ bulkId: bulk.id });
    await fx.ranking({ bulkId: bulk.id, runId: run.id, assistantId: asstScoped, rank: 2, providerId: `fx-${fx.suffix}-b` });
    await fx.ranking({ bulkId: bulk.id, runId: run.id, assistantId: asstScoped, rank: 1, providerId: `fx-${fx.suffix}-a` });
    // A row from some other snapshot must not leak in.
    const otherRun = await fx.run({});
    await fx.ranking({ runId: otherRun.id, assistantId: asstScoped, rank: 1, providerId: `fx-${fx.suffix}-other` });

    const rows = await getRankings({ bulkId: bulk.id });
    expect(rows.map((r) => r.providerId)).toEqual([`fx-${fx.suffix}-a`, `fx-${fx.suffix}-b`]);
    expect(rows.map((r) => r.rank)).toEqual([1, 2]);
  });

  it("all-time picks each group's newest batch run, skips archived (T-134) and agent-scan runs", async () => {
    const older = await fx.run({ createdAt: new Date(Date.now() - 120_000) });
    const newer = await fx.run({ createdAt: new Date(Date.now() - 60_000) });
    await fx.ranking({ runId: older.id, assistantId: asstLatest, providerId: `fx-${fx.suffix}-old` });
    await fx.ranking({ runId: newer.id, assistantId: asstLatest, providerId: `fx-${fx.suffix}-new` });

    let mine = (await getRankings()).filter((r) => r.assistantId === asstLatest);
    expect(mine.map((r) => r.providerId)).toEqual([`fx-${fx.suffix}-new`]);

    // Archiving the newest run retires its snapshot from Results -- the
    // older run's row is the group's latest again.
    await db.update(benchmarkRunsTable).set({ archivedAt: new Date() }).where(eq(benchmarkRunsTable.id, newer.id));
    mine = (await getRankings()).filter((r) => r.assistantId === asstLatest);
    expect(mine.map((r) => r.providerId)).toEqual([`fx-${fx.suffix}-old`]);

    // A 1-call agent_scan run recomputes rankings too (same executor), but
    // must never decide a group's latest.
    const agentRun = await fx.run({ purpose: "agent_scan" });
    await fx.ranking({ runId: agentRun.id, assistantId: asstAgent, providerId: `fx-${fx.suffix}-agent` });
    const agentRows = (await getRankings()).filter((r) => r.assistantId === asstAgent);
    expect(agentRows).toEqual([]);
  });

  it("labels fall back to the raw assistant id when Vapi cannot answer", async () => {
    const run = await fx.run({});
    await fx.ranking({ runId: run.id, assistantId: asstScoped, providerId: `fx-${fx.suffix}-lbl` });
    const mine = (await getRankings()).filter((r) => r.assistantId === asstScoped);
    expect(mine.length).toBeGreaterThan(0);
    expect(mine[0].assistantLabel).toBe(asstScoped);
  });

  it("rejects a malformed bulkId with a sentence, not a 500", async () => {
    const res = await request(app).get("/api/benchmark/rankings").query({ bulkId: "not-a-uuid" });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/bulkId/);
  });
});
