// T-168: GET /api/benchmark/volume and GET /api/benchmark/vapi/accounts
// against the throwaway database. Volume is the one read backed by a live
// Vapi call, so what is testable offline is exactly what must hold when
// Vapi or its key is absent: the refusals. Every assertion here is written
// to hold whether or not a VAPI key is in the environment -- the unknown
// label can never be a configured account's label.
import { afterAll, describe, expect, it } from "vitest";
import request from "supertest";
import { pool } from "@workspace/db";
import app from "../../app";
import { Fixtures } from "./fixtures";

const fx = new Fixtures();

afterAll(async () => {
  // Nothing seeded; kept for symmetry so a later edit cannot forget it.
  await fx.cleanup();
  await pool.end();
});

describe("GET /api/benchmark/vapi/accounts", () => {
  it("answers the configured accounts as an array of env-derived rows, no network", async () => {
    const res = await request(app).get("/api/benchmark/vapi/accounts");
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body)).toBe(true);
    for (const account of res.body) {
      expect(typeof account.id).toBe("string");
      expect(typeof account.label).toBe("string");
      // The env VAR NAME is announced (healthz precedent: names only);
      // the row has no field that could carry the value.
      expect(typeof account.envVar).toBe("string");
      expect(Object.keys(account).sort()).toEqual(["envVar", "id", "label"]);
    }
  });
});

describe("GET /api/benchmark/volume", () => {
  it("an unknown account label answers 404 naming the label, not a crash", async () => {
    const label = `fx-no-such-account-${fx.suffix}`;
    const res = await request(app).get("/api/benchmark/volume").query({ accountLabel: label });
    expect(res.status).toBe(404);
    expect(res.body.error).toContain(label);
  });

  it("a missing or empty accountLabel answers a sentence, never reaches Vapi", async () => {
    const missing = await request(app).get("/api/benchmark/volume");
    expect(missing.status).toBe(400);
    expect(missing.body.error).toMatch(/accountLabel/);

    const empty = await request(app).get("/api/benchmark/volume").query({ accountLabel: "" });
    expect(empty.status).toBe(400);
    expect(empty.body.error).toMatch(/accountLabel/);
  });
});
