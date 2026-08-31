import { describe, expect, it, vi } from "vitest";
import {
  CreateBulkBody,
  GetBenchmarkCallParams,
  ListDisagreementSpansQueryParams,
  AttestBenchmarkCallDeidBody,
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
});
