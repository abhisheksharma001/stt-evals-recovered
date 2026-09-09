import { afterEach, describe, expect, it, vi } from "vitest";
import { submitLegThrewResult } from "./types";
import { assemblyAiAdapter } from "./adapters/assemblyai";
import { speechmaticsAdapter } from "./adapters/speechmatics";
import { openAiAdapter } from "./adapters/openai";

// R-36 (ox-alpha B-86). A transport-level throw on the request that SUBMITS
// billable work used to escape transcribe(). run-executor's isRetryableError
// treats a generic Error as retryable, so the cell immediately submitted a
// second job while the first may already have been accepted and started
// billing.
describe("submitLegThrewResult", () => {
  const base = { vendorLabel: "AssemblyAI", submittedAt: new Date().toISOString() };

  it("is a failed result, not a throw", () => {
    expect(submitLegThrewResult({ ...base, err: new Error("socket hang up") }).status).toBe("failed");
  });

  // The contract run-executor reads. isRetryableOutcome(null, message) returns
  // true only when the message contains this exact phrase -- so its ABSENCE is
  // load-bearing, and a well-meaning reword would silently restore the bug.
  it("never says 'safe to retry', which is what would resubmit it", () => {
    const r = submitLegThrewResult({ ...base, err: new Error("safe to retry, honest") });
    expect(r.errorMessage).not.toContain("safe to retry");
  });

  it("carries no httpStatus, so nothing reads a status-based retry from it", () => {
    expect(submitLegThrewResult({ ...base, err: new Error("x") }).httpStatus).toBeNull();
  });

  // Retryable at the RUN level by a human, not by the attempt loop. That is
  // the difference between resumable and retryable-by-luck.
  it("stays classified unknown, so a deliberate retry is still possible", () => {
    expect(submitLegThrewResult({ ...base, err: new Error("x") }).failureClass).toBe("unknown");
  });

  it("says the work may already have been billed", () => {
    const r = submitLegThrewResult({ ...base, err: new Error("socket hang up") });
    expect(r.errorMessage).toContain("billed");
    expect(r.errorMessage).toContain("NOT resubmitted");
    expect(r.errorMessage).toContain("socket hang up");
  });

  it("does not explode on a non-Error throw", () => {
    expect(submitLegThrewResult({ ...base, err: "just a string" }).errorMessage).toContain("just a string");
  });
});

// The helper being right is not the fix -- the fix is that each adapter uses it
// on its billing request.
describe("adapters return rather than throw when the submit fetch dies", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    delete process.env.ASSEMBLYAI_API_KEY;
    delete process.env.SPEECHMATICS_API_KEY;
    delete process.env.OPENAI_API_KEY;
  });

  const audio = { audioBytes: Buffer.alloc(8), callId: "c1", providerId: "p1" } as never;

  it("assemblyai: upload succeeds, submit throws", async () => {
    process.env.ASSEMBLYAI_API_KEY = "test-key-not-real";
    let call = 0;
    vi.stubGlobal("fetch", vi.fn(async () => {
      call += 1;
      if (call === 1) return new Response(JSON.stringify({ upload_url: "https://x/y" }), { status: 200 });
      throw new Error("socket hang up");
    }));
    const r = await assemblyAiAdapter.transcribe(audio);
    expect(r.status).toBe("failed");
    expect(r.errorMessage).toContain("NOT resubmitted");
    expect(r.errorMessage).not.toContain("safe to retry");
  });

  it("speechmatics: submit throws", async () => {
    process.env.SPEECHMATICS_API_KEY = "test-key-not-real";
    vi.stubGlobal("fetch", vi.fn(async () => { throw new Error("ECONNRESET"); }));
    const r = await speechmaticsAdapter.transcribe(audio);
    expect(r.status).toBe("failed");
    expect(r.errorMessage).toContain("NOT resubmitted");
  });

  // OpenAI's endpoint is synchronous: the throw means the transcription may
  // have been done and charged already.
  it("openai: the billable call itself throws", async () => {
    process.env.OPENAI_API_KEY = "test-key-not-real";
    vi.stubGlobal("fetch", vi.fn(async () => { throw new Error("socket hang up"); }));
    const r = await openAiAdapter.transcribe(audio);
    expect(r.status).toBe("failed");
    expect(r.errorMessage).toContain("NOT resubmitted");
  });
});
