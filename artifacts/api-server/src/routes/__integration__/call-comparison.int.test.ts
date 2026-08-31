// T-161: GET /api/benchmark/calls/:callId/comparison against the throwaway
// database. The richest read in the app -- and the exact family T-136 and
// the T-154 mirror drift lived in. The compile check now holds its shape;
// these tests hold its content: the latest-attempt-per-provider pick, the
// "missing" row a run promised but never wrote (T-73), the retryability
// verdict, the judge pick, and the draft-as-reference rule.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import request from "supertest";
import { pool } from "@workspace/db";
import app from "../../app";
import { Fixtures } from "./fixtures";

const fx = new Fixtures();
let callId: string;
let runId: string;
let okProviderId: string;
let failedProviderId: string;
let missingProviderId: string;

beforeAll(async () => {
  const ok = await fx.provider({ name: `fx-ok-${fx.suffix}` });
  const failed = await fx.provider({ name: `fx-failed-${fx.suffix}` });
  const missing = await fx.provider({ name: `fx-missing-${fx.suffix}` });
  okProviderId = ok.id;
  failedProviderId = failed.id;
  missingProviderId = missing.id;

  // Draft is the transcript Vapi itself used live -- the reference when no
  // gold exists, and never more than that (standing rule).
  const call = await fx.call({ draftTranscript: "the quick brown fox jumps" });
  callId = call.id;

  // The run promised all three providers; only two ever wrote a row.
  const run = await fx.run({
    providerIds: [okProviderId, failedProviderId, missingProviderId],
    callIds: [callId],
    callCount: 1,
  });
  runId = run.id;

  const okResult = await fx.result(runId, callId, okProviderId, {
    hypothesisTranscript: "the quick brown fox jumped",
  });
  await fx.score(okResult.id, { peerFlagCount: 1, peerFlagSeverity: "low", flagCount: 1, flagSeverity: "low" });
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
    const res = await request(app).get(`/api/benchmark/calls/${callId}/comparison`);
    expect(res.status).toBe(200);

    expect(res.body.reference).toEqual({ kind: "draft", text: "the quick brown fox jumps" });

    const byProvider = new Map<string, any>(res.body.rows.map((r: any) => [r.providerId, r]));
    expect(byProvider.size).toBe(3);

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

  it("404s on an unknown call and refuses a malformed id with a sentence", async () => {
    const unknown = await request(app).get("/api/benchmark/calls/00000000-0000-4000-8000-000000000000/comparison");
    expect(unknown.status).toBe(404);

    const malformed = await request(app).get("/api/benchmark/calls/not-a-uuid/comparison");
    expect(malformed.status).toBe(400);
    expect(malformed.body.error).toMatch(/callId/);
  });
});
