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
import { providerIdForModel } from "@workspace/stt-providers";
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

// S-4: the models route names a provider row for every model it reports as
// enabled. It used to always report the id it WOULD synthesise
// (`<vendor>-<apiModel>`), while "is this enabled" could match the vendor's
// older row instead -- so three ids in the live response pointed at rows
// that do not exist. Nothing followed the id at the time; S-5 does.
//
// Written to hold with or without vendor API keys (the T-168 rule): the
// vendors whose catalogues are static lists carry the assertion, and the
// ones that ask the network can come back empty without failing anything.
describe("GET /api/benchmark/providers/models", () => {
  it("reports a providerId that exists for every model it calls enabled", async () => {
    const providers = await request(app).get("/api/benchmark/providers");
    expect(providers.status).toBe(200);
    const rowIds = new Set<string>(providers.body.map((p: { id: string }) => p.id));

    const res = await request(app).get("/api/benchmark/providers/models");
    expect(res.status).toBe(200);

    const enabled = (res.body.vendors as { models: { providerId: string; enabled: boolean }[] }[])
      .flatMap((v) => v.models)
      .filter((m) => m.enabled);
    // Asserted before the `every` below: on an empty list `every` is true,
    // and a test that passes because nothing was enabled proves nothing.
    expect(enabled.length).toBeGreaterThan(0);
    const dangling = enabled.map((m) => m.providerId).filter((id) => !rowIds.has(id));
    expect(dangling).toEqual([]);

    // The specific shape that was wrong, named rather than left to the
    // invariant: AssemblyAI's catalogue is a static list (no network), its
    // newest model is `universal-3-5-pro`, and the row that makes it enabled
    // is the adapter's own `assemblyai-universal`. Before S-4 this reported
    // `assemblyai-universal-3-5-pro`, which is not a row.
    const assembly = (res.body.vendors as { vendor: string; models: { apiModel: string; providerId: string; enabled: boolean }[] }[])
      .find((v) => v.vendor === "assemblyai");
    const pro = assembly?.models.find((m) => m.apiModel === "universal-3-5-pro");
    expect(pro).toBeDefined();
    if (pro?.enabled) expect(pro.providerId).toBe("assemblyai-universal");
  });

  // Found by the break test: the case above only proves the reported id is
  // SOME real row. Reporting the adapter's own row for every enabled model
  // passed it -- a model would then name a sibling row, which still exists,
  // so nothing complained. S-5 reads this id to decide whether a row is in
  // its vendor's catalogue, so naming the wrong row is the same lie S-4 was
  // written to stop, just aimed at a different vendor.
  it("names the row that made THIS model enabled, not just some row of the same vendor", async () => {
    // Seeded, and this is the whole point of the case. Every row already in
    // the database is either the adapter's own id or a model with no row, so
    // `adapter.providerId` and the synthesised id are the same string and a
    // mutation that swaps them is invisible. Gladia's adapter row is
    // `gladia-solaria`; the synthesised id for its OTHER catalogued model,
    // solaria-3, is `gladia-solaria-3`. With that row present the two ids
    // finally differ, and reporting the wrong one is visible.
    await fx.provider({ id: "gladia-solaria-3", name: "Gladia", model: "Solaria-3" });

    const providers = await request(app).get("/api/benchmark/providers");
    const rowIds = new Set<string>(providers.body.map((p: { id: string }) => p.id));
    const res = await request(app).get("/api/benchmark/providers/models");

    const models = (res.body.vendors as { vendor: string; models: { apiModel: string; providerId: string; enabled: boolean }[] }[])
      .flatMap((v) => v.models.map((m) => ({ ...m, vendor: v.vendor })));

    // A model whose OWN row exists must report that row. The legacy path is
    // a fallback for models with no row of their own, never an override.
    const ownRow = models.filter((m) => m.enabled && rowIds.has(providerIdForModel(m.vendor, m.apiModel)));
    expect(ownRow.length).toBeGreaterThan(0);
    for (const m of ownRow) expect(m.providerId).toBe(providerIdForModel(m.vendor, m.apiModel));
  });

  it("keeps the synthesised id for a model that is not enabled, because that is what enabling would create", async () => {
    const res = await request(app).get("/api/benchmark/providers/models");
    expect(res.status).toBe(200);
    // Only the vendors whose catalogue is a static list. Deepgram's and
    // OpenAI's come from their APIs, so asserting on their model names here
    // would make this test depend on a key and on whatever those vendors
    // shipped this morning.
    const STATIC_CATALOGUES = ["assemblyai", "elevenlabs", "gladia", "cartesia"];
    const off = (res.body.vendors as { vendor: string; models: { apiModel: string; providerId: string; enabled: boolean }[] }[])
      .filter((v) => STATIC_CATALOGUES.includes(v.vendor))
      .flatMap((v) => v.models.map((m) => ({ ...m, vendor: v.vendor })))
      .filter((m) => !m.enabled);
    expect(off.length).toBeGreaterThan(0);
    // The real function, not a copy of its rule: a second slugger here would
    // be one more thing to keep in step with the route.
    for (const m of off) expect(m.providerId).toBe(providerIdForModel(m.vendor, m.apiModel));
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
