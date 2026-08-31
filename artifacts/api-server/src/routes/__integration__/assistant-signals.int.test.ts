// T-163: GET /api/benchmark/assistant-signals against the throwaway
// database. The two Results card lines -- how sure the judge was, which
// calls a person flagged hard -- are made of scoping and latest-per-call
// picks the compile check cannot see. Bulk mode scopes to this suite's own
// bulk, so exact counts are safe; a call only enters scope through a result
// cell in the bulk's runs, so every seeded call gets one.
import { afterAll, describe, expect, it } from "vitest";
import request from "supertest";
import { pool } from "@workspace/db";
import app from "../../app";
import { Fixtures } from "./fixtures";

const fx = new Fixtures();

type SignalsBody = {
  bulkId: string | null;
  bulksCovered: number;
  assistantId: string | null;
  callsInScope: number;
  judge: { checked: number; judged: number; high: number; medium: number; low: number; notRecorded: number; clean: number; errored: number };
  hardCases: { calls: number; tags: { tag: string; calls: number }[]; examples: { callId: string; label: string; tags: string[] }[] };
};

async function getSignals(query: Record<string, string>) {
  const res = await request(app).get("/api/benchmark/assistant-signals").query(query);
  expect(res.status).toBe(200);
  return res.body as SignalsBody;
}

afterAll(async () => {
  await fx.cleanup();
  await pool.end();
});

describe("GET /api/benchmark/assistant-signals", () => {
  it("judge counts follow each call's LATEST scan, and 'judged' means the judge answered", async () => {
    const bulk = await fx.bulk({ status: "complete" });
    const run = await fx.run({ bulkId: bulk.id, purpose: "batch" });
    const provider = await fx.provider();

    // Call A: an older flagged/high scan superseded by a clean re-scan.
    // Counting rows would read "2 checked, 1 judged" -- the T-35 bug shape.
    const a = await fx.call();
    await fx.result(run.id, a.id, provider.id);
    await fx.scan(a.id, {
      runId: run.id,
      status: "flagged",
      judgeConfidence: "high",
      agentPickReasoning: "superseded verdict",
      createdAt: new Date(Date.now() - 60_000),
    });
    await fx.scan(a.id, { runId: run.id, status: "clean" });

    // Call B: flagged, judge answered with a typed confidence.
    const b = await fx.call();
    await fx.result(run.id, b.id, provider.id);
    await fx.scan(b.id, { runId: run.id, status: "flagged", judgeConfidence: "high", agentPickReasoning: "b reads best" });

    // Call C: a real verdict from before batch 8 recorded confidence.
    const c = await fx.call();
    await fx.result(run.id, c.id, provider.id);
    await fx.scan(c.id, { runId: run.id, status: "flagged", judgeConfidence: null, agentPickReasoning: "pre-batch-8 verdict" });

    // Call D: the verification crashed -- we know nothing about this call.
    const d = await fx.call();
    await fx.result(run.id, d.id, provider.id);
    await fx.scan(d.id, { runId: run.id, status: "error" });

    // Call E: flagged but the judge call itself failed -- neither judged nor clean.
    const e = await fx.call();
    await fx.result(run.id, e.id, provider.id);
    await fx.scan(e.id, { runId: run.id, status: "flagged", agentPickReasoning: null });

    const body = await getSignals({ bulkId: bulk.id });
    expect(body.bulkId).toBe(bulk.id);
    expect(body.callsInScope).toBe(5);
    expect(body.judge).toEqual({
      checked: 5, // one per call, not one per scan row
      judged: 2, // B and C: the judge answered; A's answer was superseded, E's never came
      high: 1, // B
      medium: 0,
      low: 0,
      notRecorded: 1, // C: real verdict, no recorded level
      clean: 1, // A, by its latest scan
      errored: 1, // D
    });
  });

  it("hard cases come from the calls a person flagged, tags counted once per call", async () => {
    const bulk = await fx.bulk({ status: "complete" });
    const run = await fx.run({ bulkId: bulk.id, purpose: "batch" });
    const provider = await fx.provider();

    const flagged = await fx.call({ hardCases: ["numbers", " numbers ", "accent"] });
    await fx.result(run.id, flagged.id, provider.id);
    const unflagged = await fx.call();
    await fx.result(run.id, unflagged.id, provider.id);

    const body = await getSignals({ bulkId: bulk.id });
    expect(body.hardCases.calls).toBe(1);
    // "numbers" is written twice on the call; a tag counts once per call.
    expect(body.hardCases.tags).toEqual([
      { tag: "accent", calls: 1 },
      { tag: "numbers", calls: 1 },
    ]);
    expect(body.hardCases.examples).toHaveLength(1);
    expect(body.hardCases.examples[0]!.callId).toBe(flagged.id);
    expect(body.hardCases.examples[0]!.label).toBe(flagged.label);
  });

  it("assistantId narrows scope; another assistant's scans and flags vanish", async () => {
    const bulk = await fx.bulk({ status: "complete" });
    const run = await fx.run({ bulkId: bulk.id, purpose: "batch" });
    const provider = await fx.provider();
    const mineId = `fx-asst-signals-${fx.suffix}`;

    const mine = await fx.call({ sourceAssistantId: mineId, hardCases: ["static"] });
    await fx.result(run.id, mine.id, provider.id);
    await fx.scan(mine.id, { runId: run.id, status: "clean" });

    const other = await fx.call({ sourceAssistantId: `fx-asst-else-${fx.suffix}`, hardCases: ["noise"] });
    await fx.result(run.id, other.id, provider.id);
    await fx.scan(other.id, { runId: run.id, status: "flagged", judgeConfidence: "low", agentPickReasoning: "other" });

    const body = await getSignals({ bulkId: bulk.id, assistantId: mineId });
    expect(body.assistantId).toBe(mineId);
    expect(body.callsInScope).toBe(1);
    expect(body.judge.checked).toBe(1);
    expect(body.judge.clean).toBe(1);
    expect(body.judge.low).toBe(0);
    expect(body.hardCases.tags).toEqual([{ tag: "static", calls: 1 }]);
  });

  it("answers 404 for an unknown bulk and a sentence for a malformed bulkId", async () => {
    const missing = await request(app)
      .get("/api/benchmark/assistant-signals")
      .query({ bulkId: "00000000-0000-4000-8000-000000000000" });
    expect(missing.status).toBe(404);

    const malformed = await request(app).get("/api/benchmark/assistant-signals").query({ bulkId: "not-a-uuid" });
    expect(malformed.status).toBe(400);
    expect(malformed.body.error).toMatch(/bulkId/);
  });
});
