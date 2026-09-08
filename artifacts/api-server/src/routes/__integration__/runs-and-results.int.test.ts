// T-169: GET /api/benchmark/runs and GET /api/benchmark/runs/:runId/results
// against the throwaway database. The Runs page's two reads: the list's
// purpose filter and bulk-name join, and the results rows' score join plus
// the T-41 derived diagnosis -- a known failure class answers its sentence
// with no click and no stored analysis, but an operator's stored analysis
// always wins. List assertions are containment on this suite's own rows.
import { afterAll, describe, expect, it } from "vitest";
import request from "supertest";
import { benchmarkScoresTable, db, pool } from "@workspace/db";
import { eq } from "drizzle-orm";
import { server } from "./server";
import { Fixtures } from "./fixtures";

const fx = new Fixtures();

afterAll(async () => {
  await fx.cleanup();
  await pool.end();
});

describe("GET /api/benchmark/runs", () => {
  it("lists batch runs newest-first with the bulk's name; agent_scan runs stay out", async () => {
    const bulk = await fx.bulk({ status: "running" });
    const shardRun = await fx.run({ bulkId: bulk.id, purpose: "batch", createdAt: new Date(Date.now() - 1_000) });
    const adHocRun = await fx.run({ purpose: "batch" });
    // The transcript-quality agent spawns its own runs through the same
    // executor; they belong to the Agent view, never this list.
    const agentRun = await fx.run({ purpose: "agent_scan" });

    const res = await request(server).get("/api/benchmark/runs");
    expect(res.status).toBe(200);
    const mine = res.body.filter((r: { id: string }) => [shardRun.id, adHocRun.id, agentRun.id].includes(r.id));
    expect(mine.map((r: { id: string }) => r.id)).toEqual([adHocRun.id, shardRun.id]);
    expect(mine[1]).toMatchObject({ bulkId: bulk.id, bulkName: bulk.name, status: "complete" });
    expect(mine[0]).toMatchObject({ bulkId: null, bulkName: null });
  });
});

describe("GET /api/benchmark/runs/:runId/results", () => {
  it("joins each cell's score and derives the known-failure diagnosis from the class alone", async () => {
    const run = await fx.run({ purpose: "batch" });
    const call = await fx.call();
    const scored = await fx.provider();
    const expired = await fx.provider();
    const timedOut = await fx.provider();

    const okCell = await fx.result(run.id, call.id, scored.id, { hypothesisTranscript: "hello word" });
    await fx.score(okCell.id, {
      wer: 0.25,
      entityAccuracy: 0.9,
      alphanumericAccuracy: 1,
      latencyFinalMs: 1500,
      costPerMinute: 3,
      detail: {
        wordDiff: [
          { op: "ok", ref: "hello", hyp: "hello" },
          { op: "sub", ref: "world", hyp: "word" },
        ],
      },
    });
    await fx.result(run.id, call.id, expired.id, {
      status: "failed",
      failureClass: "retention_expired",
      errorMessage: "Vapi answered 400",
    });
    await fx.result(run.id, call.id, timedOut.id, {
      status: "failed",
      failureClass: "provider_timeout",
      errorMessage: "took too long",
    });

    const res = await request(server).get(`/api/benchmark/runs/${run.id}/results`);
    expect(res.status).toBe(200);
    expect(res.body).toHaveLength(3);
    const byProvider = new Map(res.body.map((r: { providerId: string }) => [r.providerId, r])) as Map<
      string,
      Record<string, unknown>
    >;

    const okRow = byProvider.get(scored.id)!;
    expect(okRow.score).toMatchObject({
      scoringVersion: "v1",
      wer: 0.25,
      entityAccuracy: 0.9,
      alphanumericAccuracy: 1,
      latencyFinalMs: 1500,
      costPerMinute: 3,
    });
    expect((okRow.score as { wordDiff: unknown[] }).wordDiff).toHaveLength(2);
    expect(okRow.retryable).toBeNull();

    // Retention is a KNOWN cause: the sentence arrives with no click and no
    // stored analysis, derived from failureClass only (T-41), and it is
    // permanent -- never retryable.
    const expiredRow = byProvider.get(expired.id)!;
    expect(expiredRow.score).toBeNull();
    expect(expiredRow.failureDiagnosis).toMatch(/older than Vapi's plan retains/);
    expect(expiredRow.failureSuggestedFix).toMatch(/Not retryable/);
    expect(expiredRow.retryable).toBe(false);

    // A timeout has no deterministic story: diagnosis stays null (an LLM
    // analysis is the next step), and a retry could plausibly fix it.
    const timedOutRow = byProvider.get(timedOut.id)!;
    expect(timedOutRow.failureDiagnosis).toBeNull();
    expect(timedOutRow.retryable).toBe(true);
  });

  it("an operator's stored analysis wins over the derived sentence", async () => {
    const run = await fx.run({ purpose: "batch" });
    const call = await fx.call();
    const provider = await fx.provider();
    await fx.result(run.id, call.id, provider.id, {
      status: "failed",
      failureClass: "retention_expired",
      failureDiagnosis: "operator wrote this one",
      failureSuggestedFix: "operator's fix",
    });

    const res = await request(server).get(`/api/benchmark/runs/${run.id}/results`);
    expect(res.status).toBe(200);
    expect(res.body[0].failureDiagnosis).toBe("operator wrote this one");
    expect(res.body[0].failureSuggestedFix).toBe("operator's fix");
  });

  // M-10b. The column is written by run-executor only when a real streaming
  // cell runs, which costs provider money -- so the thing worth proving
  // without spending is that the column exists in the database under the
  // name the drizzle schema claims, and survives a round trip. A schema that
  // has drifted from the running database fails silently here and expensively
  // there.
  it("stores an end-of-audio latency distinctly from latencyFinalMs, and null when unmeasured", async () => {
    const run = await fx.run({ purpose: "batch" });
    const call = await fx.call();
    const streaming = await fx.provider();
    const batch = await fx.provider();

    const streamingResult = await fx.result(run.id, call.id, streaming.id, { status: "ok" });
    await fx.score(streamingResult.id, { latencyFinalMs: 80_754, latencyEndOfAudioMs: 812 });
    const batchResult = await fx.result(run.id, call.id, batch.id, { status: "ok" });
    await fx.score(batchResult.id, { latencyFinalMs: 4_613 });

    const [streamingRow] = await db
      .select({ final: benchmarkScoresTable.latencyFinalMs, endOfAudio: benchmarkScoresTable.latencyEndOfAudioMs })
      .from(benchmarkScoresTable)
      .where(eq(benchmarkScoresTable.resultId, streamingResult.id));
    // The two numbers must not be the same number wearing two names -- that
    // conflation is what M-10a had to take out of the ranking composite.
    expect(streamingRow.endOfAudio).toBe(812);
    expect(streamingRow.final).toBe(80_754);

    const [batchRow] = await db
      .select({ endOfAudio: benchmarkScoresTable.latencyEndOfAudioMs })
      .from(benchmarkScoresTable)
      .where(eq(benchmarkScoresTable.resultId, batchResult.id));
    // A batch adapter measures nothing here. Null, never 0 -- 0 would rank
    // as the fastest possible provider.
    expect(batchRow.endOfAudio).toBeNull();
  });

  it("an unknown run answers an empty list; a malformed id answers a sentence", async () => {
    const unknown = await request(server).get("/api/benchmark/runs/00000000-0000-4000-8000-000000000000/results");
    expect(unknown.status).toBe(200);
    expect(unknown.body).toEqual([]);

    const malformed = await request(server).get("/api/benchmark/runs/not-a-uuid/results");
    expect(malformed.status).toBe(400);
    expect(malformed.body.error).toMatch(/runId/);
  });
});
