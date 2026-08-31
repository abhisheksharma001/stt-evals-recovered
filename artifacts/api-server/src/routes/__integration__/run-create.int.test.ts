// T-179: POST /api/benchmark/runs against the throwaway database.
//
// SAFETY, read before editing: this route EXECUTES the run it creates,
// fire-and-forget, the moment nothing blocks it -- that is real provider
// money. Every run created here is blocked by construction: fixture
// provider ids match no adapter, so syncProviderReadiness derives them to
// not_configured and the handler refuses to start. Never seed a "ready"
// provider in this suite.
//
// What is held: the blockers are named rather than guessed at, a blocked
// run still freezes its manifest (it records what it WOULD have run
// against), and a blocked run stays blocked with no cells.
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

describe("POST /api/benchmark/runs", () => {
  it("blocks on unconfigured providers, freezes the manifest anyway, and executes nothing", async () => {
    const call = await fx.call({ goldTranscript: `fx gold ${fx.suffix}` });
    const provider = await fx.provider();

    const res = await request(app)
      .post("/api/benchmark/runs")
      .set("x-actor", fx.actor)
      .send({ callIds: [call.id], providerIds: [provider.id], notes: `fx note ${fx.suffix}` });
    expect(res.status).toBe(201);
    fx.adoptRun(res.body.id);
    expect(res.body).toMatchObject({ status: "blocked", callCount: 1 });
    // The operator's note is kept and the reason is appended to it, so the
    // run says on its face why it did not start.
    expect(res.body.notes).toContain(`fx note ${fx.suffix}`);
    expect(res.body.notes).toContain("Blocked: provider credentials and models must be configured");

    // RUN-01: the manifest is frozen even for a run that never ran -- it
    // records what the run WOULD have executed against.
    const manifest = await request(app).get(`/api/benchmark/runs/${res.body.id}/manifest`);
    expect(manifest.status).toBe(200);
    expect(manifest.body.calls).toHaveLength(1);
    expect(manifest.body.providers[0].id).toBe(provider.id);

    // Nothing was started: no cells, and the status has not moved.
    const results = await request(app).get(`/api/benchmark/runs/${res.body.id}/results`);
    expect(results.body).toEqual([]);
    const list = await request(app).get("/api/benchmark/runs");
    expect(list.body.find((r: { id: string }) => r.id === res.body.id).status).toBe("blocked");

    const audit = await request(app)
      .get("/api/benchmark/audit-log")
      .query({ entityType: "run", entityId: res.body.id });
    expect(audit.body).toHaveLength(1);
    expect(audit.body[0]).toMatchObject({ action: "create", actorLabel: fx.actor });
  });

  it("names a missing call and a missing provider separately", async () => {
    const call = await fx.call();
    const provider = await fx.provider();

    const missingCall = await request(app)
      .post("/api/benchmark/runs")
      .set("x-actor", fx.actor)
      .send({ callIds: ["00000000-0000-4000-8000-000000000000"], providerIds: [provider.id] });
    expect(missingCall.status).toBe(201);
    fx.adoptRun(missingCall.body.id);
    expect(missingCall.body.status).toBe("blocked");
    expect(missingCall.body.notes).toContain("Blocked: one or more calls do not exist");

    const missingProvider = await request(app)
      .post("/api/benchmark/runs")
      .set("x-actor", fx.actor)
      .send({ callIds: [call.id], providerIds: [`fx-no-such-${fx.suffix}`] });
    expect(missingProvider.status).toBe(201);
    fx.adoptRun(missingProvider.body.id);
    expect(missingProvider.body.notes).toContain("Blocked: one or more providers do not exist");
  });

  it("refuses a run with no calls or no providers", async () => {
    const noCalls = await request(app).post("/api/benchmark/runs").send({ callIds: [], providerIds: ["x"] });
    expect(noCalls.status).toBe(400);
    expect(noCalls.body.error).toMatch(/callIds/);

    const noProviders = await request(app).post("/api/benchmark/runs").send({ callIds: ["x"], providerIds: [] });
    expect(noProviders.status).toBe(400);
    expect(noProviders.body.error).toMatch(/providerIds/);
  });
});
