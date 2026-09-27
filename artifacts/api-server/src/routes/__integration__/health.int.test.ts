// R-56: /healthz says whether the database answers, and still answers itself.
// The "unreachable" paths (refused, failed, too slow) are unit-tested in
// lib/db-probe.test.ts; this holds the wiring against a real database.
import { afterAll, describe, expect, it } from "vitest";
import request from "supertest";
import { pool } from "@workspace/db";
import { server } from "./server";

afterAll(async () => {
  await pool.end();
});

describe("GET /api/healthz", () => {
  it("reports the database as ok while keeping status as liveness", async () => {
    const res = await request(server).get("/api/healthz");
    expect(res.status).toBe(200);
    expect(res.body.status).toBe("ok");
    expect(res.body.database).toBe("ok");
  });
});
