// R-31 (ox-alpha B-4). The helper being right is not the fix -- the fix is
// that app.ts uses it, so these assert the response headers the browser
// actually sees, through the real app.
//
// What this protects: the API has no auth (B-1 is still open), listens on
// localhost, and /benchmark/calls serves goldTranscript and draftTranscript.
// Under `Access-Control-Allow-Origin: *`, any page the operator visited could
// read the whole corpus off their own machine with one fetch.
import { afterAll, describe, expect, it } from "vitest";
import request from "supertest";
import { pool } from "@workspace/db";
import { server } from "./server";

afterAll(async () => {
  await pool.end().catch(() => {});
});

describe("CORS on /api", () => {
  it("does not echo an arbitrary origin", async () => {
    const res = await request(server)
      .get("/api/healthz")
      .set("Origin", "https://evil.example.com");
    expect(res.headers["access-control-allow-origin"]).toBeUndefined();
  });

  // The regression that matters: a wildcard is never correct on this API.
  it("never answers with a wildcard", async () => {
    const res = await request(server)
      .get("/api/healthz")
      .set("Origin", "https://evil.example.com");
    expect(res.headers["access-control-allow-origin"]).not.toBe("*");

    const allowed = await request(server)
      .get("/api/healthz")
      .set("Origin", "http://localhost:5173");
    expect(allowed.headers["access-control-allow-origin"]).not.toBe("*");
  });

  it("allows the vite dev origin the UI actually runs on", async () => {
    const res = await request(server)
      .get("/api/healthz")
      .set("Origin", "http://localhost:5173");
    expect(res.headers["access-control-allow-origin"]).toBe("http://localhost:5173");
  });

  it("refuses a lookalike origin", async () => {
    const res = await request(server)
      .get("/api/healthz")
      .set("Origin", "http://localhost:5173.evil.test");
    expect(res.headers["access-control-allow-origin"]).toBeUndefined();
  });

  // curl and the deploy script's healthz check send no Origin.
  it("still answers a request with no Origin at all", async () => {
    const res = await request(server).get("/api/healthz");
    expect(res.status).toBe(200);
  });

  // The refusal must not look like a broken server.
  it("refuses by omitting the header, not with a 500", async () => {
    const res = await request(server)
      .get("/api/healthz")
      .set("Origin", "https://evil.example.com");
    expect(res.status).toBe(200);
  });
});
