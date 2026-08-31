import { describe, expect, it, vi } from "vitest";
import { HealthCheckResponse, ListDisagreementSpansResponse } from "@workspace/api-zod";
import { respondJson } from "./respond";

// T-152: same fake-res pattern as error-handler.test.ts -- the contract under
// test is "status honoured, body is the schema's parse of the payload".
function fakeRes() {
  const res: any = { statusCode: 0, body: undefined };
  res.status = vi.fn((code: number) => { res.statusCode = code; return res; });
  res.json = vi.fn((body: unknown) => { res.body = body; return res; });
  return res;
}

const healthPayload = {
  status: "ok",
  commitSha: "abc123",
  builtAt: "2026-08-31T00:00:00.000Z",
  startedAt: "2026-08-31T00:00:01.000Z",
  providersConfigured: ["deepgram-nova-3"],
};

describe("respondJson", () => {
  it("answers 200 with the parsed payload by default", () => {
    const res = fakeRes();
    respondJson(res, HealthCheckResponse, healthPayload);
    expect(res.statusCode).toBe(200);
    expect(res.body).toEqual(healthPayload);
  });

  it("honours an explicit status", () => {
    const res = fakeRes();
    respondJson(res, HealthCheckResponse, healthPayload, 201);
    expect(res.statusCode).toBe(201);
  });

  it("still refuses a payload whose values break the contract at runtime", () => {
    // The compiler holds the shape; the parse still holds the values. A cast
    // (or an enum read out of an unconstrained text column) can satisfy tsc
    // with a value the contract forbids -- that must stay a loud throw, never
    // a response.
    const res = fakeRes();
    const emptySpans = {
      callId: "not-even-a-uuid-shaped-string",
      runId: null,
      referenceProviderId: null,
      referenceWords: [],
      referenceWordStartMs: [],
      unavailableReason: "sideways" as "no_run",
      spans: [],
    };
    expect(() => respondJson(res, ListDisagreementSpansResponse, emptySpans)).toThrow(/unavailableReason/);
    expect(res.json).not.toHaveBeenCalled();
  });

  it("holds the T-136 omission as a compile error", () => {
    // The exact production bug this helper exists for: the spans mapping lost
    // required `majorityText` and the endpoint answered 500 for every call
    // for a day (batch 14). With respondJson that omission no longer
    // typechecks. @ts-expect-error is bidirectional: if the compile guarantee
    // ever weakens (a schema edit, a looser helper signature), this line
    // itself becomes the tsc failure.
    const res = fakeRes();
    const spanMissingMajorityText = {
      startMs: 0,
      endMs: 100,
      contextBefore: "",
      contextAfter: "",
      referencePositions: [0, 1],
      readings: [],
    };
    expect(() =>
      respondJson(res, ListDisagreementSpansResponse, {
        callId: "b7e486x0-0000-0000-0000-000000000000",
        runId: null,
        referenceProviderId: null,
        referenceWords: [],
        referenceWordStartMs: [],
        unavailableReason: "no_run",
        // @ts-expect-error -- majorityText is required by the contract
        spans: [spanMissingMajorityText],
      }),
    ).toThrow();
  });
});
