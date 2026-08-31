// T-180: POST /api/benchmark/providers, PATCH /api/benchmark/providers/:providerId
// and the offline half of POST /api/benchmark/providers/models/enable
// against the throwaway database. A provider row is a price and a set of
// capability claims that a bulk's cost estimate and the rankings both read,
// so what it accepts and what it re-derives matters. Status is never taken
// from the caller: FR-P3 derives it from adapter + key presence on every
// write as well as every read.
import { afterAll, describe, expect, it } from "vitest";
import request from "supertest";
import { pool } from "@workspace/db";
import app from "../../app";
import { Fixtures } from "./fixtures";

const fx = new Fixtures();

afterAll(async () => {
  await fx.cleanup();
  await pool.end();
});

describe("POST /api/benchmark/providers", () => {
  it("derives a readable id, stores the price, and lands not_configured", async () => {
    const res = await request(app)
      .post("/api/benchmark/providers")
      .set("x-actor", fx.actor)
      .send({
        name: `fx vendor ${fx.suffix}`,
        model: "Model One",
        costPerMinute: 0.42,
        supportsDiarization: true,
        configNote: `note ${fx.suffix}`,
      });
    expect(res.status).toBe(201);
    fx.adoptProvider(res.body.id);
    // The id is slugged from name + model with a short random tail, so two
    // rows for the same vendor cannot collide.
    expect(res.body.id).toMatch(new RegExp(`^fx-vendor-${fx.suffix}-model-one-[0-9a-f]{6}$`));
    expect(res.body).toMatchObject({
      name: `fx vendor ${fx.suffix}`,
      model: "Model One",
      costPerMinute: 0.42,
      supportsDiarization: true,
      supportsStreaming: false,
      // No adapter answers to this id, so it can never be "ready" however
      // it was asked for.
      status: "not_configured",
    });

    const audit = await request(app)
      .get("/api/benchmark/audit-log")
      .query({ entityType: "provider", entityId: res.body.id });
    expect(audit.body).toHaveLength(1);
    expect(audit.body[0]).toMatchObject({ action: "create", actorLabel: fx.actor });
  });

  it("refuses a provider with no name and one with no price", async () => {
    const noName = await request(app).post("/api/benchmark/providers").send({ model: "m", costPerMinute: 1 });
    expect(noName.status).toBe(400);
    expect(noName.body.error).toMatch(/name/);

    const noPrice = await request(app)
      .post("/api/benchmark/providers")
      .send({ name: `fx ${fx.suffix}`, model: "m" });
    expect(noPrice.status).toBe(400);
    expect(noPrice.body.error).toMatch(/costPerMinute/);
  });
});

describe("PATCH /api/benchmark/providers/:providerId", () => {
  it("changes price and disabled flag, keeps the rest, and audits before/after", async () => {
    const provider = await fx.provider({ costPerMinute: 1, configNote: `original ${fx.suffix}` });

    const res = await request(app)
      .patch(`/api/benchmark/providers/${provider.id}`)
      .set("x-actor", fx.actor)
      .send({ costPerMinute: 2.5, disabled: true });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      id: provider.id,
      costPerMinute: 2.5,
      // Fields the body did not name keep their value.
      configNote: `original ${fx.suffix}`,
      // An operator switching a provider off reads as "disabled", not as
      // "not_configured": the manual flag outranks key presence in the
      // FR-P3 derivation, so the reason it will not run stays visible.
      status: "disabled",
    });

    const audit = await request(app)
      .get("/api/benchmark/audit-log")
      .query({ entityType: "provider", entityId: provider.id });
    expect(audit.body).toHaveLength(1);
    expect((audit.body[0].beforeState as { costPerMinute: number }).costPerMinute).toBe(1);
    expect((audit.body[0].afterState as { costPerMinute: number }).costPerMinute).toBe(2.5);
  });

  it("answers 404 for an unknown provider and 400 for a bad price", async () => {
    const unknown = await request(app)
      .patch(`/api/benchmark/providers/fx-no-such-${fx.suffix}`)
      .send({ costPerMinute: 1 });
    expect(unknown.status).toBe(404);

    const provider = await fx.provider();
    const badPrice = await request(app)
      .patch(`/api/benchmark/providers/${provider.id}`)
      .send({ costPerMinute: "free" });
    expect(badPrice.status).toBe(400);
  });
});

describe("POST /api/benchmark/providers/models/enable", () => {
  it("refuses an unknown vendor before asking any vendor for its models", async () => {
    const res = await request(app)
      .post("/api/benchmark/providers/models/enable")
      .send({ vendor: `fx-no-such-vendor-${fx.suffix}`, apiModel: "whatever" });
    expect(res.status).toBe(404);
    expect(res.body.error).toContain(`fx-no-such-vendor-${fx.suffix}`);

    const invalid = await request(app).post("/api/benchmark/providers/models/enable").send({ vendor: "" });
    expect(invalid.status).toBe(400);
    expect(invalid.body.error).toMatch(/apiModel|vendor/);
  });
});
