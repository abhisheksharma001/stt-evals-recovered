// T-166: GET /api/benchmark/trend against the throwaway database. The
// cross-bulk trend strip's raw material: which bulks join the strip
// (finished only) and what a summed cell is made of (T-19 basis: only ok
// cells whose score carries a peer-flag count). All-database read, so
// assertions are containment on this suite's own bulk/provider ids.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import request from "supertest";
import { pool } from "@workspace/db";
import app from "../../app";
import { Fixtures } from "./fixtures";

const fx = new Fixtures();

type TrendBulk = { id: string; name: string; at: string; status: string };
type TrendCell = {
  bulkId: string;
  accountLabel: string | null;
  assistantId: string | null;
  providerId: string;
  providerName: string;
  peerFlags: number;
  words: number;
  callsScored: number;
  cleanCalls: number;
};

let body: { bulks: TrendBulk[]; cells: TrendCell[] };
let finishedBulkId: string;
let runningBulkId: string;
let scoredProviderId: string;
let unscoredProviderId: string;
const completedAt = new Date("2026-08-30T12:00:00.000Z");

beforeAll(async () => {
  const account = `fx-acct-${fx.suffix}`;
  const assistant = `fx-asst-trend-${fx.suffix}`;
  const flagged = await fx.call({ sourceAccountLabel: account, sourceAssistantId: assistant });
  const clean = await fx.call({ sourceAccountLabel: account, sourceAssistantId: assistant });
  const scored = await fx.provider({ name: `fx trend provider ${fx.suffix}` });
  scoredProviderId = scored.id;
  const unscored = await fx.provider();
  unscoredProviderId = unscored.id;

  const finished = await fx.bulk({ status: "complete", completedAt });
  finishedBulkId = finished.id;
  const run = await fx.run({ bulkId: finished.id, purpose: "batch" });
  // Two scored calls for one provider: one flagged, one clean.
  const r1 = await fx.result(run.id, flagged.id, scored.id, { hypothesisTranscript: "hello world something" });
  await fx.score(r1.id, { peerFlagCount: 1 });
  const r2 = await fx.result(run.id, clean.id, scored.id, { hypothesisTranscript: "clean words" });
  await fx.score(r2.id, { peerFlagCount: 0 });
  // Scored before hybrid flagging existed: a null peer-flag count must not
  // read as a clean call, so this cell takes no part at all.
  const r3 = await fx.result(run.id, flagged.id, unscored.id, { hypothesisTranscript: "ignored words" });
  await fx.score(r3.id, { peerFlagCount: null });

  // A running bulk would draw a point that keeps moving -- kept off the strip.
  const running = await fx.bulk({ status: "running" });
  runningBulkId = running.id;
  const runningRun = await fx.run({ bulkId: running.id, purpose: "batch" });
  const r4 = await fx.result(runningRun.id, flagged.id, scored.id, { hypothesisTranscript: "moving point" });
  await fx.score(r4.id, { peerFlagCount: 0 });

  const res = await request(app).get("/api/benchmark/trend");
  expect(res.status).toBe(200);
  body = res.body;
});

afterAll(async () => {
  await fx.cleanup();
  await pool.end();
});

describe("GET /api/benchmark/trend", () => {
  it("a finished bulk joins the strip dated by its completedAt; a running one stays off it", async () => {
    const mine = body.bulks.find((b) => b.id === finishedBulkId);
    expect(mine).toBeDefined();
    expect(mine!.at).toBe(completedAt.toISOString());
    expect(mine!.status).toBe("complete");
    expect(body.bulks.map((b) => b.id)).not.toContain(runningBulkId);
    expect(body.cells.map((c) => c.bulkId)).not.toContain(runningBulkId);
  });

  it("a cell sums only cells with a recorded peer-flag count, on the call's account and assistant", async () => {
    const mine = body.cells.filter((c) => c.providerId === scoredProviderId);
    expect(mine).toHaveLength(1);
    expect(mine[0]).toEqual({
      bulkId: finishedBulkId,
      accountLabel: `fx-acct-${fx.suffix}`,
      assistantId: `fx-asst-trend-${fx.suffix}`,
      providerId: scoredProviderId,
      providerName: `fx trend provider ${fx.suffix}`,
      peerFlags: 1,
      words: 5, // "hello world something" + "clean words"
      callsScored: 2,
      cleanCalls: 1, // the flagged call is scored but not clean
    });
    // The null-flag-count cell vanishes entirely -- not counted as clean.
    expect(body.cells.map((c) => c.providerId)).not.toContain(unscoredProviderId);
  });
});
