// W-12b: GET /api/benchmark/method-check against the throwaway database.
//
// The arithmetic is unit-tested in method-check-aggregate.test.ts and
// lib/scoring's rank-agreement.test.ts. What can only go wrong here is the
// QUERY -- which bulk counts as run, and which cells count -- so that is what
// this file holds: absent and unfinished bulks send no figure, and a failed
// cell or an agent-scan cell that would flip the order is not read.
import { afterAll, describe, expect, it } from "vitest";
import request from "supertest";
import { eq } from "drizzle-orm";
import { benchmarkBulksTable, db, pool } from "@workspace/db";
import { server } from "./server";
import { Fixtures } from "./fixtures";

const fx = new Fixtures();
const BULK_NAME = "Public: Pipecat 1k";

afterAll(async () => {
  await fx.cleanup();
  await pool.end();
});

const edits = (errors: number) => ({ edits: { substitutions: errors, deletions: 0, insertions: 0, referenceWords: 10 } });

describe("GET /api/benchmark/method-check", () => {
  it("sends not_run and no figure when the public bulk does not exist", async () => {
    const res = await request(server).get("/api/benchmark/method-check");
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ state: "not_run" });
  });

  it("sends not_run while the bulk is still running, then the figure once it has finished", async () => {
    const bulk = await fx.bulk({ name: BULK_NAME, status: "running" });
    const run = await fx.run({ purpose: "batch", bulkId: bulk.id });
    const agentRun = await fx.run({ purpose: "agent_scan", bulkId: bulk.id });
    const [p1, p2, p3] = [await fx.provider(), await fx.provider(), await fx.provider()];
    const call = await fx.call({ sourceProvider: "pipecat", sourceCallId: `fx-mc-${fx.suffix}` });

    // Both orderings p1 < p2 < p3: rho 1.
    for (const [provider, errors, flags] of [
      [p1, 1, 1],
      [p2, 2, 2],
      [p3, 3, 3],
    ] as const) {
      const cell = await fx.result(run.id, call.id, provider.id, { hypothesisTranscript: "one two three four five" });
      await fx.score(cell.id, { wer: errors / 10, peerFlagCount: flags, detail: edits(errors) });
    }
    // Counted, either of these would make p1 the worst on WER.
    const shard2 = await fx.run({ purpose: "batch", bulkId: bulk.id });
    const failed = await fx.result(shard2.id, call.id, p1.id, { status: "failed", failureClass: "provider_timeout" });
    await fx.score(failed.id, { wer: 9, peerFlagCount: 1, detail: edits(90) });
    const scan = await fx.result(agentRun.id, call.id, p1.id, { hypothesisTranscript: "one two three four five" });
    await fx.score(scan.id, { wer: 9, peerFlagCount: 1, detail: edits(90) });

    const running = await request(server).get("/api/benchmark/method-check");
    expect(running.body).toEqual({ state: "not_run" });

    // A cancelled bulk carries a completedAt too, and it did not finish.
    const completedAt = new Date("2026-09-26T19:00:00.000Z");
    await db.update(benchmarkBulksTable).set({ status: "cancelled", completedAt }).where(eq(benchmarkBulksTable.id, bulk.id));
    const cancelled = await request(server).get("/api/benchmark/method-check");
    expect(cancelled.body).toEqual({ state: "not_run" });

    await db.update(benchmarkBulksTable).set({ status: "complete", completedAt }).where(eq(benchmarkBulksTable.id, bulk.id));

    const res = await request(server).get("/api/benchmark/method-check");
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      state: "measured",
      bulkId: bulk.id,
      completedAt: completedAt.toISOString(),
      n: 3,
      rho: 1,
      verdict: "weak",
    });
    // 3 providers: only one of 3! = 6 orderings reaches rho 1. Not below 0.05.
    expect(res.body.pOneSided).toBeCloseTo(1 / 6, 10);
    expect(res.body.providers.map((p: { providerId: string; wer: number }) => [p.providerId, p.wer])).toEqual(
      [
        [p1.id, 0.1],
        [p2.id, 0.2],
        [p3.id, 0.3],
      ].sort(([a], [b]) => String(a).localeCompare(String(b))),
    );
  });
});
