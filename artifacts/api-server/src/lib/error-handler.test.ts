import { describe, expect, it, vi } from "vitest";
import { describeUnmatched, errorBody, errorStatus, jsonErrorHandler, jsonNotFoundHandler } from "./error-handler";

// T-76: the handler is exercised with fake req/res objects (no supertest in
// this package) -- what matters is the contract: JSON body, thrown status
// honoured, 500 otherwise, request id carried, nothing internal leaked.
function fakeRes() {
  const res: any = { headersSent: false, statusCode: 0, body: undefined };
  res.status = vi.fn((code: number) => { res.statusCode = code; return res; });
  res.json = vi.fn((body: unknown) => { res.body = body; return res; });
  return res;
}
function fakeReq(id: string | number | undefined = "req-1") {
  return { id, log: { error: vi.fn(), warn: vi.fn() } } as any;
}

describe("errorStatus", () => {
  it("uses a thrown status in the 4xx-5xx range, else 500", () => {
    expect(errorStatus(Object.assign(new Error("nope"), { status: 404 }))).toBe(404);
    expect(errorStatus(Object.assign(new Error("nope"), { statusCode: 429 }))).toBe(429);
    expect(errorStatus(Object.assign(new Error("nope"), { status: 200 }))).toBe(500);
    expect(errorStatus(new Error("plain"))).toBe(500);
    expect(errorStatus("a string")).toBe(500);
  });
});

describe("errorBody", () => {
  it("keeps the message for 4xx and hides it for 5xx", () => {
    expect(errorBody(Object.assign(new Error("bad input"), { status: 400 }), "r1")).toEqual({ error: "bad input", requestId: "r1" });
    expect(errorBody(new Error("DATABASE_URL=postgres://secret"), "r1")).toEqual({ error: "Internal server error", requestId: "r1" });
    expect(errorBody(new Error("x"), undefined)).toEqual({ error: "Internal server error" });
  });
});

describe("jsonErrorHandler", () => {
  it("answers JSON 500 with the request id for a plain throw and logs once at error level", () => {
    const req = fakeReq("abc");
    const res = fakeRes();
    const next = vi.fn();
    jsonErrorHandler(new Error("boom"), req, res, next);
    expect(res.status).toHaveBeenCalledWith(500);
    expect(res.body).toEqual({ error: "Internal server error", requestId: "abc" });
    expect(req.log.error).toHaveBeenCalledTimes(1);
    expect(next).not.toHaveBeenCalled();
  });

  it("answers the thrown status as JSON and logs at warn level", () => {
    const req = fakeReq(7);
    const res = fakeRes();
    jsonErrorHandler(Object.assign(new Error("Call not found"), { status: 404 }), req, res, vi.fn());
    expect(res.statusCode).toBe(404);
    expect(res.body).toEqual({ error: "Call not found", requestId: "7" });
    expect(req.log.warn).toHaveBeenCalledTimes(1);
    expect(req.log.error).not.toHaveBeenCalled();
  });

  it("delegates to Express when headers were already sent", () => {
    const req = fakeReq();
    const res = fakeRes();
    res.headersSent = true;
    const next = vi.fn();
    const err = new Error("late");
    jsonErrorHandler(err, req, res, next);
    expect(next).toHaveBeenCalledWith(err);
    expect(res.json).not.toHaveBeenCalled();
  });
});

// T-149: the same contract for a request that reaches no handler at all.
describe("describeUnmatched", () => {
  it("names the method and path the server did not find", () => {
    expect(describeUnmatched("POST", "/api/benchmark/agent/scans")).toBe(
      "No such endpoint: POST /api/benchmark/agent/scans",
    );
  });

  it("strips angle brackets and control characters, and caps the length", () => {
    expect(describeUnmatched("GET", "/api/<script>alert(1)</script>")).toBe(
      "No such endpoint: GET /api/scriptalert(1)/script",
    );
    expect(describeUnmatched("GET", "/api/a\nbc")).toBe("No such endpoint: GET /api/abc");
    const long = describeUnmatched("GET", "/api/" + "x".repeat(400));
    expect(long.length).toBe("No such endpoint: GET ".length + 200);
  });
});

describe("jsonNotFoundHandler", () => {
  it("answers JSON 404 with the request id, and drops the query string", () => {
    const res = fakeRes();
    jsonNotFoundHandler(
      { ...fakeReq("r9"), method: "POST", originalUrl: "/api/benchmark/agent/scans?callId=x" } as any,
      res,
      vi.fn(),
    );
    expect(res.statusCode).toBe(404);
    expect(res.body).toEqual({
      error: "No such endpoint: POST /api/benchmark/agent/scans",
      requestId: "r9",
    });
  });

  it("omits the request id when there is none", () => {
    const res = fakeRes();
    jsonNotFoundHandler({ ...fakeReq(), id: undefined, method: "GET", originalUrl: "/nope" } as any, res, vi.fn());
    expect(res.body).toEqual({ error: "No such endpoint: GET /nope" });
  });
});
