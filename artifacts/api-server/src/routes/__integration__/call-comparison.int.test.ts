// T-161: GET /api/benchmark/calls/:callId/comparison against the throwaway
// database. The richest read in the app -- and the exact family T-136 and
// the T-154 mirror drift lived in. The compile check now holds its shape;
// these tests hold its content: the latest-attempt-per-provider pick, the
// "missing" row a run promised but never wrote (T-73), the retryability
// verdict, the judge pick, and the draft-as-reference rule.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import request from "supertest";
import { pool } from "@workspace/db";
import { server } from "./server";
import { Fixtures } from "./fixtures";

const fx = new Fixtures();
let callId: string;
let runId: string;
let okProviderId: string;
let failedProviderId: string;
let missingProviderId: string;
// M-10f: a provider whose cell scored fine but has no end-of-audio number,
// which is what a batch adapter looks like -- the common case, and the one
// that must serialise null rather than 0.
let batchProviderId: string;

beforeAll(async () => {
  const ok = await fx.provider({ name: `fx-ok-${fx.suffix}` });
  const failed = await fx.provider({ name: `fx-failed-${fx.suffix}` });
  const missing = await fx.provider({ name: `fx-missing-${fx.suffix}` });
  const batch = await fx.provider({ name: `fx-batch-${fx.suffix}` });
  okProviderId = ok.id;
  failedProviderId = failed.id;
  missingProviderId = missing.id;
  batchProviderId = batch.id;

  // Draft is the transcript Vapi itself used live -- the reference when no
  // gold exists, and never more than that (standing rule).
  const call = await fx.call({ draftTranscript: "the quick brown fox jumps" });
  callId = call.id;

  // The run promised all three providers; only two ever wrote a row.
  const run = await fx.run({
    providerIds: [okProviderId, failedProviderId, missingProviderId, batchProviderId],
    callIds: [callId],
    callCount: 1,
  });
  runId = run.id;

  const okResult = await fx.result(runId, callId, okProviderId, {
    hypothesisTranscript: "the quick brown fox jumped",
    // M-5a: the channel this cell was actually read from, as the executor
    // recorded it. The comparison must carry it through unchanged.
    audioSource: "customer",
  });
  // M-10f: the streamed cell measures both -- file turnaround AND the wait
  // after the audio stops. They are different numbers, so the fixture makes
  // them obviously different.
  await fx.score(okResult.id, {
    peerFlagCount: 1,
    peerFlagSeverity: "low",
    flagCount: 1,
    flagSeverity: "low",
    latencyFinalMs: 80_754,
    latencyEndOfAudioMs: 812,
  });
  // M-10f: the batch cell measures only turnaround. Scored, ok, and still
  // no end-of-audio number -- there was no moment the audio ended.
  const batchResult = await fx.result(runId, callId, batchProviderId, {
    hypothesisTranscript: "the quick brown fox jumps",
  });
  await fx.score(batchResult.id, { latencyFinalMs: 3_400 });
  await fx.result(runId, callId, failedProviderId, {
    status: "failed",
    failureClass: "provider_timeout",
    errorMessage: "took too long",
  });
  // The judge picked the ok provider's transcript.
  await fx.scan(callId, { runId, status: "flagged", agentPickResultId: okResult.id });
});

afterAll(async () => {
  await fx.cleanup();
  await pool.end();
});

describe("GET /api/benchmark/calls/:callId/comparison", () => {
  it("answers the full picture: reference, ok row with diff, failed row with verdict, missing row with its run", async () => {
    const res = await request(server).get(`/api/benchmark/calls/${callId}/comparison`);
    expect(res.status).toBe(200);

    expect(res.body.reference).toEqual({ kind: "draft", text: "the quick brown fox jumps" });

    const byProvider = new Map<string, any>(res.body.rows.map((r: any) => [r.providerId, r]));
    expect(byProvider.size).toBe(4);

    const okRow = byProvider.get(okProviderId);
    expect(okRow.status).toBe("ok");
    expect(okRow.hypothesisTranscript).toBe("the quick brown fox jumped");
    // One word differs against the 5-word draft: jumps -> jumped.
    expect(okRow.diff).not.toBeNull();
    expect(okRow.diff.referenceWords).toBe(5);
    expect(okRow.diff.wordsDiffer).toBe(1);
    expect(okRow.diff.werVsReference).toBeCloseTo(0.2);
    expect(okRow.peerFlagCount).toBe(1);
    expect(okRow.isJudgePick).toBe(true);

    const failedRow = byProvider.get(failedProviderId);
    expect(failedRow.status).toBe("failed");
    expect(failedRow.failureClass).toBe("provider_timeout");
    expect(failedRow.retryable).toBe(true);
    expect(failedRow.errorMessage).toBe("took too long");
    expect(failedRow.isJudgePick).toBe(false);

    // T-73: promised by the run, never written -- rendered as missing with
    // the run id the retry action needs, never silently dropped.
    const missingRow = byProvider.get(missingProviderId);
    expect(missingRow.status).toBe("missing");
    expect(missingRow.resultId).toBeNull();
    expect(missingRow.runId).toBe(runId);
  });

  // M-5a: the row is where a reader compares providers, so each row has to
  // carry the audio it was measured on. Not per call: rows here can come
  // from different runs, and a re-read on the caller-only channel sits next
  // to one that never got re-read.
  it("carries each cell's own channel through, and invents none for cells that have none", async () => {
    const res = await request(server).get(`/api/benchmark/calls/${callId}/comparison`);
    expect(res.status).toBe(200);
    const byProvider = new Map<string, any>(res.body.rows.map((r: any) => [r.providerId, r]));

    expect(byProvider.get(okProviderId).audioSource).toBe("customer");
    // The failed cell read nothing successfully; the missing cell has no row
    // at all. Both stay null -- "mono" here would be a guess dressed as data.
    expect(byProvider.get(failedProviderId).audioSource).toBeNull();
    expect(byProvider.get(missingProviderId).audioSource).toBeNull();
  });

  // M-10f. The second serialisation path for latencyEndOfAudioMs: the
  // rankings block carries the group average, this carries the single cell.
  // Both had to be wired separately, so both have to be proved separately.
  it("carries each cell's end-of-audio wait, and leaves it null where there was no end of audio", async () => {
    const res = await request(server).get(`/api/benchmark/calls/${callId}/comparison`);
    expect(res.status).toBe(200);
    const byProvider = new Map<string, any>(res.body.rows.map((r: any) => [r.providerId, r]));

    // Streamed: both numbers present and NOT the same number. If these ever
    // matched, one measurement would be being served under two names.
    expect(byProvider.get(okProviderId).latencyEndOfAudioMs).toBe(812);
    expect(byProvider.get(okProviderId).latencyFinalMs).toBe(80_754);

    // Batch: scored, ok, turnaround recorded -- and still no end-of-audio
    // number. Null, never 0: 0 ms would claim an instant reply.
    const batchRow = byProvider.get(batchProviderId);
    expect(batchRow.status).toBe("ok");
    expect(batchRow.latencyFinalMs).toBe(3_400);
    expect(batchRow.latencyEndOfAudioMs).toBeNull();

    // No score row at all, and no result row at all: both null for a third
    // reason again -- nothing ran, not "a batch API had no end of audio".
    expect(byProvider.get(failedProviderId).latencyEndOfAudioMs).toBeNull();
    expect(byProvider.get(missingProviderId).latencyEndOfAudioMs).toBeNull();
  });

  it("404s on an unknown call and refuses a malformed id with a sentence", async () => {
    const unknown = await request(server).get("/api/benchmark/calls/00000000-0000-4000-8000-000000000000/comparison");
    expect(unknown.status).toBe(404);

    const malformed = await request(server).get("/api/benchmark/calls/not-a-uuid/comparison");
    expect(malformed.status).toBe(400);
    expect(malformed.body.error).toMatch(/callId/);
  });
});
