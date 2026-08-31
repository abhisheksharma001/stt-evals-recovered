// T-167: GET /api/benchmark/bulks/:bulkId/provider-correlation against the
// throwaway database. Q-2's read: do two providers agree with each other
// more than with the field (a shared model base showing through)? The
// arithmetic is unit-tested in scoring; what the route adds -- which cells
// feed it, name resolution, the no-third-provider null -- is query logic.
// Scoped to one bulk, so exact numbers are safe.
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

describe("GET /api/benchmark/bulks/:bulkId/provider-correlation", () => {
  it("an identical pair shows its excess agreement against the odd provider out", async () => {
    const bulk = await fx.bulk({ providerIds: [] });
    const run = await fx.run({ bulkId: bulk.id, purpose: "batch" });
    const call = await fx.call();
    // Ids sort a < b < c, so pair order in the response is deterministic.
    const a = await fx.provider({ id: `fx-${fx.suffix}-corr-a`, name: `corr A ${fx.suffix}` });
    const b = await fx.provider({ id: `fx-${fx.suffix}-corr-b` });
    const c = await fx.provider({ id: `fx-${fx.suffix}-corr-c` });
    // A and B agree word for word; C heard something else entirely.
    await fx.result(run.id, call.id, a.id, { hypothesisTranscript: "alpha beta gamma" });
    await fx.result(run.id, call.id, b.id, { hypothesisTranscript: "alpha beta gamma" });
    await fx.result(run.id, call.id, c.id, { hypothesisTranscript: "delta epsilon zeta" });
    // A provider whose only cell failed never enters the correlation.
    const d = await fx.provider({ id: `fx-${fx.suffix}-corr-d` });
    await fx.result(run.id, call.id, d.id, { status: "failed", hypothesisTranscript: "noise noise noise" });

    const res = await request(app).get(`/api/benchmark/bulks/${bulk.id}/provider-correlation`);
    expect(res.status).toBe(200);
    expect(res.body.bulkId).toBe(bulk.id);
    expect(res.body.callCount).toBe(1);
    // d's only cell failed: ok cells alone feed the correlation.
    expect(res.body.providers.map((p: { id: string }) => p.id)).toEqual([a.id, b.id, c.id]);
    // The route resolves names where it has them and answers the id where
    // it must, never dropping the row.
    expect(res.body.providers[0].name).toBe(`corr A ${fx.suffix}`);

    const pair = (x: string, y: string) =>
      res.body.pairs.find((p: { providerAId: string; providerBId: string }) => p.providerAId === x && p.providerBId === y);
    // A-B agree on every aligned word; each agrees with C on none. The
    // pair's excess is measured against baselines that leave the pair
    // itself out, so A-B's excess is a full 1.0 -- and A-C sits below the
    // field at -0.5 (A's baseline without C is its perfect run with B).
    expect(pair(a.id, b.id)).toMatchObject({ sharedCalls: 1, agreement: 1, excessAgreement: 1 });
    expect(pair(a.id, c.id)).toMatchObject({ sharedCalls: 1, agreement: 0, excessAgreement: -0.5 });
    expect(pair(b.id, c.id)).toMatchObject({ sharedCalls: 1, agreement: 0, excessAgreement: -0.5 });
  });

  it("with no third provider there is no baseline, so excess is null, not a number", async () => {
    const bulk = await fx.bulk({ providerIds: [] });
    const run = await fx.run({ bulkId: bulk.id, purpose: "batch" });
    const call = await fx.call();
    const a = await fx.provider({ id: `fx-${fx.suffix}-duo-a` });
    const b = await fx.provider({ id: `fx-${fx.suffix}-duo-b` });
    await fx.result(run.id, call.id, a.id, { hypothesisTranscript: "same words here" });
    await fx.result(run.id, call.id, b.id, { hypothesisTranscript: "same words here" });

    const res = await request(app).get(`/api/benchmark/bulks/${bulk.id}/provider-correlation`);
    expect(res.status).toBe(200);
    expect(res.body.pairs).toHaveLength(1);
    expect(res.body.pairs[0]).toMatchObject({ agreement: 1, excessAgreement: null });
  });

  it("answers 404 for an unknown bulk and a sentence for a malformed id", async () => {
    const missing = await request(app).get(
      "/api/benchmark/bulks/00000000-0000-4000-8000-000000000000/provider-correlation",
    );
    expect(missing.status).toBe(404);

    const malformed = await request(app).get("/api/benchmark/bulks/not-a-uuid/provider-correlation");
    expect(malformed.status).toBe(400);
    expect(malformed.body.error).toMatch(/bulkId/);
  });
});
