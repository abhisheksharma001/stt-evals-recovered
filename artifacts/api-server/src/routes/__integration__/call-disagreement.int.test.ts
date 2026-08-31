// T-172: GET /api/benchmark/calls/disagreement against the throwaway
// database. The worst-first ordering behind the Corpus table (T-85): one
// number per call, summed from every ok, SCORED cell. Three ways to get it
// wrong are query logic, not arithmetic -- counting a failed cell, counting
// an agent-scan run's cell, or answering 0 for a call that was never
// scored -- so they are held here. Assertions are containment on this
// suite's own calls.
import { afterAll, describe, expect, it } from "vitest";
import request from "supertest";
import { pool } from "@workspace/db";
import app from "../../app";
import { Fixtures } from "./fixtures";

const fx = new Fixtures();

afterAll(async () => {
  await fx.cleanup();
  await pool.end();
});

type Row = { callId: string; disagreements: number; providers: number };
const find = (body: { calls: Row[] }, callId: string): Row | undefined =>
  body.calls.find((c) => c.callId === callId);

describe("GET /api/benchmark/calls/disagreement", () => {
  it("sums peer flags per call, worst first, over ok scored cells only", async () => {
    const bulk = await fx.bulk();
    const inBulk = await fx.run({ bulkId: bulk.id, purpose: "batch" });
    const adHoc = await fx.run({ purpose: "batch" });
    // The transcript-quality agent runs through the same executor and
    // writes real cells; its runs are not the benchmark.
    const agentRun = await fx.run({ purpose: "agent_scan" });
    const p1 = await fx.provider();
    const p2 = await fx.provider();

    const ugly = await fx.call();
    const mild = await fx.call();
    const unscored = await fx.call();
    const partlyFailed = await fx.call();

    const uglyA = await fx.result(inBulk.id, ugly.id, p1.id);
    await fx.score(uglyA.id, { peerFlagCount: 5 });
    const uglyB = await fx.result(inBulk.id, ugly.id, p2.id);
    await fx.score(uglyB.id, { peerFlagCount: 2 });
    // Same call, same provider, an agent-scan run: never counted.
    const uglyAgent = await fx.result(agentRun.id, ugly.id, p2.id);
    await fx.score(uglyAgent.id, { peerFlagCount: 50 });

    const mildCell = await fx.result(adHoc.id, mild.id, p1.id);
    await fx.score(mildCell.id, { peerFlagCount: 1 });

    // Ran, never scored: the call must be ABSENT, not zero -- "no data"
    // read as "no disagreement" would put the least-known call last.
    await fx.result(inBulk.id, unscored.id, p1.id);

    // A failed cell with a score row attached: excluded by status, so the
    // call keeps only its one good provider.
    const okCell = await fx.result(inBulk.id, partlyFailed.id, p1.id);
    await fx.score(okCell.id, { peerFlagCount: 1 });
    const failedCell = await fx.result(inBulk.id, partlyFailed.id, p2.id, {
      status: "failed",
      failureClass: "provider_timeout",
    });
    await fx.score(failedCell.id, { peerFlagCount: 100 });

    const res = await request(app).get("/api/benchmark/calls/disagreement");
    expect(res.status).toBe(200);
    expect(res.body.bulkId).toBeNull();

    expect(find(res.body, ugly.id)).toEqual({ callId: ugly.id, disagreements: 7, providers: 2 });
    expect(find(res.body, mild.id)).toEqual({ callId: mild.id, disagreements: 1, providers: 1 });
    expect(find(res.body, partlyFailed.id)).toEqual({ callId: partlyFailed.id, disagreements: 1, providers: 1 });
    expect(find(res.body, unscored.id)).toBeUndefined();

    // Worst first, among this suite's own calls.
    const mineInOrder = res.body.calls
      .map((c: Row) => c.callId)
      .filter((id: string) => [ugly.id, mild.id, partlyFailed.id].includes(id));
    expect(mineInOrder[0]).toBe(ugly.id);
  });

  it("bulkId scopes to that bulk's runs and echoes back", async () => {
    const bulk = await fx.bulk();
    const inBulk = await fx.run({ bulkId: bulk.id, purpose: "batch" });
    const elsewhere = await fx.run({ purpose: "batch" });
    const provider = await fx.provider();
    const mine = await fx.call();
    const other = await fx.call();

    const mineCell = await fx.result(inBulk.id, mine.id, provider.id);
    await fx.score(mineCell.id, { peerFlagCount: 3 });
    const otherCell = await fx.result(elsewhere.id, other.id, provider.id);
    await fx.score(otherCell.id, { peerFlagCount: 9 });

    const res = await request(app).get("/api/benchmark/calls/disagreement").query({ bulkId: bulk.id });
    expect(res.status).toBe(200);
    expect(res.body.bulkId).toBe(bulk.id);
    expect(res.body.calls).toEqual([{ callId: mine.id, disagreements: 3, providers: 1 }]);
  });

  it("a bulk with no runs answers an empty list; a malformed bulkId answers a sentence", async () => {
    const empty = await request(app)
      .get("/api/benchmark/calls/disagreement")
      .query({ bulkId: "00000000-0000-4000-8000-000000000000" });
    expect(empty.status).toBe(200);
    expect(empty.body.calls).toEqual([]);

    const malformed = await request(app).get("/api/benchmark/calls/disagreement").query({ bulkId: "not-a-uuid" });
    expect(malformed.status).toBe(400);
    expect(malformed.body.error).toMatch(/bulkId/);
  });
});
