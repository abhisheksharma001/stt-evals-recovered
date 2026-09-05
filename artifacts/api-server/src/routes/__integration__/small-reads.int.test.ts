// T-171: the three small reads left over -- GET /api/benchmark/settings,
// GET /api/benchmark/providers, GET /api/benchmark/calls/:callId -- against
// the throwaway database. Small, but each carries one behavior worth
// holding: settings' exact two-field shape, the provider list deriving
// status at read time on its own route (FR-P3 -- the dashboard suite
// proves the dashboard does it; this proves the Setup list does too), and
// the single-call read's decoration + refusals.
import { afterAll, describe, expect, it } from "vitest";
import request from "supertest";
import { pool } from "@workspace/db";
import app from "../../app";
import { expectStatus } from "./expect-status";
import { Fixtures } from "./fixtures";

const fx = new Fixtures();

afterAll(async () => {
  await fx.cleanup();
  await pool.end();
});

describe("GET /api/benchmark/settings", () => {
  it("answers exactly the two settings fields", async () => {
    const res = await request(app).get("/api/benchmark/settings");
    expectStatus(res, 200);
    // Values are shared state (another suite or a person may have set
    // them); the shape is the contract.
    expect(Object.keys(res.body).sort()).toEqual(["activeProviderId", "agentModel"]);
  });
});

describe("GET /api/benchmark/providers", () => {
  it("derives a seeded provider's status at read time instead of trusting the row", async () => {
    const planted = await fx.provider({ status: "ready" });

    const res = await request(app).get("/api/benchmark/providers");
    expectStatus(res, 200);
    const mine = res.body.find((p: { id: string }) => p.id === planted.id);
    expect(mine).toBeDefined();
    // No adapter matches an fx- id, so one GET forces the hand-planted
    // "ready" back to not_configured (FR-P3): status is derived from
    // adapter + key presence on every read, never read back from the row.
    expect(mine.status).toBe("not_configured");
    expect(mine.name).toBe(planted.name);
  });
});

describe("GET /api/benchmark/calls/:callId", () => {
  it("answers the call with its audio decoration", async () => {
    const call = await fx.call({ vertical: "trucking", entityNotes: `fx-note-${fx.suffix}` });
    const res = await request(app).get(`/api/benchmark/calls/${call.id}`);
    expectStatus(res, 200);
    expect(res.body).toMatchObject({
      id: call.id,
      label: call.label,
      vertical: "trucking",
      status: "ready_to_run",
      entityNotes: `fx-note-${fx.suffix}`,
      // No bytes on this disk for a seeded call.
      audioCached: false,
    });
  });

  it("answers 404 for an unknown call and a sentence for a malformed id", async () => {
    const missing = await request(app).get("/api/benchmark/calls/00000000-0000-4000-8000-000000000000");
    expectStatus(missing, 404);

    const malformed = await request(app).get("/api/benchmark/calls/not-a-uuid");
    expectStatus(malformed, 400);
    expect(malformed.body.error).toMatch(/callId/);
  });
});
