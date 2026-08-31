// T-165: GET /api/benchmark/bulks/:bulkId against the throwaway database.
// The detail view is the densest aggregate in the tool -- progress
// counters, the STT/agent cost split, agent coverage, the failure
// breakdown -- all grouped SQL plus in-handler arithmetic the compile
// check cannot see, and all of it scoped to one bulk, so exact numbers are
// safe. Every test gets its own bulk.
import { afterAll, describe, expect, it } from "vitest";
import request from "supertest";
import { pool } from "@workspace/db";
import app from "../../app";
import { Fixtures } from "./fixtures";

const fx = new Fixtures();

async function getBulk(bulkId: string) {
  const res = await request(app).get(`/api/benchmark/bulks/${bulkId}`);
  expect(res.status).toBe(200);
  return res.body;
}

afterAll(async () => {
  await fx.cleanup();
  await pool.end();
});

describe("GET /api/benchmark/bulks/:bulkId", () => {
  it("progress counts a call once even when its cells landed in two statuses", async () => {
    const c1 = await fx.call();
    const c2 = await fx.call();
    const p1 = await fx.provider();
    const p2 = await fx.provider();
    const bulk = await fx.bulk({
      selectionCriteria: { resolvedCallIds: [c1.id, c2.id] },
      providerIds: [p1.id, p2.id],
    });
    const run = await fx.run({ bulkId: bulk.id, purpose: "batch" });
    // c1 ran with both providers, one ok and one cancelled mid-flight; c2
    // never ran. Summing per-status distinct call counts would report
    // callsRun 2 for c1 alone -- the double-count the handler guards.
    await fx.result(run.id, c1.id, p1.id, { status: "ok" });
    await fx.result(run.id, c1.id, p2.id, { status: "cancelled" });

    const body = await getBulk(bulk.id);
    expect(body.progress).toEqual({
      callsTotal: 2,
      callsRun: 1,
      cellsTotal: 4,
      cellsOk: 1,
      cellsFailed: 0,
      cellsPending: 2,
      cellsCancelled: 1,
      cellsSkippedPendingReview: 0,
      agentCallsTotal: 1, // only calls with an ok transcript can be checked
      agentCallsChecked: 0,
      agentCallsInFlight: 0,
    });
    expect(body.runs).toHaveLength(1);
    expect(body.runs[0].id).toBe(run.id);
  });

  it("agent coverage counts each call's latest scan; spend still sums every row", async () => {
    const bulk = await fx.bulk({ providerIds: [] });
    const run = await fx.run({ bulkId: bulk.id, purpose: "batch" });
    const provider = await fx.provider();

    // Call X was re-scanned: the older flagged verdict is superseded by an
    // approved one. Coverage must count X once (T-35: rows read "126
    // checked" on a 72-call bulk); the judge was paid both times, so spend
    // keeps both rows.
    const x = await fx.call();
    const xr = await fx.result(run.id, x.id, provider.id);
    await fx.score(xr.id, { costMicrocents: 12_345 });
    await fx.scan(x.id, {
      runId: run.id,
      status: "flagged",
      agentPickReasoning: "superseded",
      judgeCostMicrocents: 5_000,
      createdAt: new Date(Date.now() - 60_000),
    });
    await fx.scan(x.id, { runId: run.id, status: "approved", agentPickReasoning: "kept", judgeCostMicrocents: 3_000 });

    // Call Y's verification crashed: an errored check, not a finding (T-03).
    const y = await fx.call();
    await fx.result(run.id, y.id, provider.id, { status: "failed", failureClass: "provider_timeout" });
    await fx.scan(y.id, { runId: run.id, status: "error" });

    const body = await getBulk(bulk.id);
    expect(body.actualCost).toEqual({
      sttCostMicrocents: 12_345,
      agentCostMicrocents: 8_000, // 5,000 + 3,000: superseded or not, it was paid
      agentCallsChecked: 2, // X once, Y once
      agentCallsFlagged: 0, // X's flag is resolved now
      agentCallsResolved: 1,
      agentCallsErrored: 1,
      agentCallsJudged: 1, // X: the judge answered; Y crashed before answering
    });
  });

  it("agent cost states: a clean bulk claims a real zero, an unpriced judge call refuses to claim one", async () => {
    // Nothing flagged or errored: no judge call was ever made, so $0.00 is true.
    const cleanBulk = await fx.bulk({ providerIds: [] });
    const cleanRun = await fx.run({ bulkId: cleanBulk.id, purpose: "batch" });
    const provider = await fx.provider();
    const cleanCall = await fx.call();
    await fx.result(cleanRun.id, cleanCall.id, provider.id);
    await fx.scan(cleanCall.id, { runId: cleanRun.id, status: "clean" });
    const clean = await getBulk(cleanBulk.id);
    expect(clean.actualCost.agentCostMicrocents).toBe(0);

    // A judge answered but no cost survived: OpenAI was paid an unknown
    // amount, so the total is "not recorded", never a number.
    const unpricedBulk = await fx.bulk({ providerIds: [] });
    const unpricedRun = await fx.run({ bulkId: unpricedBulk.id, purpose: "batch" });
    const unpricedCall = await fx.call();
    await fx.result(unpricedRun.id, unpricedCall.id, provider.id);
    await fx.scan(unpricedCall.id, {
      runId: unpricedRun.id,
      status: "flagged",
      agentPickReasoning: "verdict with no published rate",
      judgeCostMicrocents: null,
    });
    const unpriced = await getBulk(unpricedBulk.id);
    expect(unpriced.actualCost.agentCostMicrocents).toBeNull();
    expect(unpriced.actualCost.agentCallsJudged).toBe(1);
  });

  it("failure breakdown groups by class, biggest first, unclassified last, retryable decided server-side", async () => {
    const bulk = await fx.bulk({ providerIds: [] });
    const run = await fx.run({ bulkId: bulk.id, purpose: "batch" });
    const provider = await fx.provider();
    const calls = await Promise.all([fx.call(), fx.call(), fx.call(), fx.call()]);
    await fx.result(run.id, calls[0]!.id, provider.id, { status: "failed", failureClass: "provider_timeout" });
    await fx.result(run.id, calls[1]!.id, provider.id, { status: "failed", failureClass: "provider_timeout" });
    await fx.result(run.id, calls[2]!.id, provider.id, { status: "failed", failureClass: "provider_auth" });
    await fx.result(run.id, calls[3]!.id, provider.id, { status: "failed", failureClass: null });

    const body = await getBulk(bulk.id);
    expect(body.failureBreakdown).toEqual([
      { failureClass: "provider_timeout", cells: 2, retryable: true },
      { failureClass: "provider_auth", cells: 1, retryable: false },
      // Unclassified is never retryable: it has not been shown transient,
      // and a re-run spends real provider money on a maybe.
      { failureClass: null, cells: 1, retryable: false },
    ]);
    expect(body.progress.cellsFailed).toBe(4);
  });

  it("answers 404 for an unknown bulk and a sentence for a malformed id", async () => {
    const missing = await request(app).get("/api/benchmark/bulks/00000000-0000-4000-8000-000000000000");
    expect(missing.status).toBe(404);

    const malformed = await request(app).get("/api/benchmark/bulks/not-a-uuid");
    expect(malformed.status).toBe(400);
    expect(malformed.body.error).toMatch(/bulkId/);
  });
});
