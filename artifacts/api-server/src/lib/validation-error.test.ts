import { describe, expect, it, vi } from "vitest";
import {
  CreateBulkBody,
  GetBenchmarkCallParams,
  ListDisagreementSpansQueryParams,
  AttestBenchmarkCallDeidBody,
  AttestBenchmarkCallDeidParams,
  SetRunArchivedBody,
} from "@workspace/api-zod";
import { describeInvalidInput, respondInvalid } from "./validation-error";

// T-150: every case below is a real generated schema rejecting a real input,
// so these read what the routes actually answer -- not a hand-built ZodError
// that could drift from the one zod produces.
function failure(schema: { safeParse: (v: unknown) => { success: boolean; error?: unknown } }, value: unknown) {
  const parsed = schema.safeParse(value);
  if (parsed.success) throw new Error("expected this input to be rejected");
  return describeInvalidInput(parsed.error as never);
}

describe("describeInvalidInput", () => {
  it("names a malformed id instead of dumping zod's issue array", () => {
    expect(failure(GetBenchmarkCallParams, { callId: "not-a-uuid" })).toBe("callId must be a valid uuid");
  });

  it("says a left-out parameter is required, and names it", () => {
    expect(failure(ListDisagreementSpansQueryParams, {})).toBe("callId is required");
  });

  it("says an array where a string belongs is an array", () => {
    expect(failure(ListDisagreementSpansQueryParams, { callId: ["a", "b"] })).toBe(
      "callId must be a string, not an array",
    );
  });

  it("names a missing nested field by its path", () => {
    expect(failure(CreateBulkBody, { label: "x" })).toContain("criteria is required");
  });

  it("names the wrong type on a body field", () => {
    expect(failure(SetRunArchivedBody, { archived: "yes" })).toBe("archived must be a boolean, not a string");
  });

  it("says how short a value was, in the unit that field is measured in", () => {
    // approverLabel's real minimum in the spec is 2 characters.
    expect(failure(AttestBenchmarkCallDeidBody, { approverLabel: "" })).toBe(
      "approverLabel must be at least 2 characters",
    );
  });

  // O-122: the five handlers that parse the URL and the body separately have
  // two errors and one answer. These are the real pair those routes produce.
  it("describes both halves when the id and the body are each wrong", () => {
    const params = AttestBenchmarkCallDeidParams.safeParse({ callId: "not-a-uuid" });
    const body = AttestBenchmarkCallDeidBody.safeParse({});
    if (params.success || body.success) throw new Error("expected both to be rejected");
    expect(describeInvalidInput(params.error, body.error)).toBe(
      "callId must be a valid uuid; approverLabel is required",
    );
  });

  it("keeps the order it was given, so the URL is named before the body", () => {
    const params = AttestBenchmarkCallDeidParams.safeParse({ callId: "nope" });
    const body = AttestBenchmarkCallDeidBody.safeParse({});
    if (params.success || body.success) throw new Error("expected both to be rejected");
    expect(describeInvalidInput(body.error, params.error)).toBe(
      "approverLabel is required; callId must be a valid uuid",
    );
  });

  it("skips the half that parsed, without a gap or a stray separator", () => {
    const body = AttestBenchmarkCallDeidBody.safeParse({});
    if (body.success) throw new Error("expected this input to be rejected");
    expect(describeInvalidInput(undefined, body.error)).toBe("approverLabel is required");
    expect(describeInvalidInput(body.error, undefined)).toBe("approverLabel is required");
  });

  it("still says something when handed nothing at all", () => {
    // Unreachable from the routes -- the guard only fires when one half
    // failed -- but the sentence must never come out empty or `undefined`.
    expect(describeInvalidInput()).toBe("The request is not valid.");
    expect(describeInvalidInput(undefined)).toBe("The request is not valid.");
  });

  it("joins several problems and caps the list", () => {
    const parsed = CreateBulkBody.safeParse({});
    if (parsed.success) throw new Error("expected this input to be rejected");
    const text = describeInvalidInput(parsed.error);
    expect(text).toContain("; ");
    expect(text.split("; ").length).toBeLessThanOrEqual(5);
  });
});

describe("respondInvalid", () => {
  it("answers 400 with the sentence in the error field", () => {
    const res: { statusCode?: number; body?: unknown; status: unknown; json: unknown } = {
      status: vi.fn(function (this: void, code: number) { res.statusCode = code; return res; }),
      json: vi.fn(function (this: void, body: unknown) { res.body = body; return res; }),
    };
    const parsed = GetBenchmarkCallParams.safeParse({ callId: "nope" });
    if (parsed.success) throw new Error("expected this input to be rejected");
    respondInvalid(res as never, parsed.error);
    expect(res.statusCode).toBe(400);
    expect(res.body).toEqual({ error: "callId must be a valid uuid" });
  });

  it("passes every error it is handed through to the sentence", () => {
    const res: { statusCode?: number; body?: unknown; status: unknown; json: unknown } = {
      status: vi.fn(function (this: void, code: number) { res.statusCode = code; return res; }),
      json: vi.fn(function (this: void, body: unknown) { res.body = body; return res; }),
    };
    const params = AttestBenchmarkCallDeidParams.safeParse({ callId: "nope" });
    const body = AttestBenchmarkCallDeidBody.safeParse({});
    if (params.success || body.success) throw new Error("expected both to be rejected");
    respondInvalid(res as never, params.error, body.error);
    expect(res.statusCode).toBe(400);
    expect(res.body).toEqual({ error: "callId must be a valid uuid; approverLabel is required" });
  });
});
