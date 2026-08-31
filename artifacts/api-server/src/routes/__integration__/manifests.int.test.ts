// T-173: GET /api/benchmark/runs/:runId/manifest and
// GET /api/benchmark/bulks/:bulkId/manifest against the throwaway database.
// The manifest is the reproducibility promise (FR-REP1): a frozen record of
// exactly what a run executed against, written once at run creation. Its
// whole point is that later edits cannot change it, so that is what is
// held here -- through the route, not by reading the column back.
import { createHash } from "node:crypto";
import { afterAll, describe, expect, it } from "vitest";
import request from "supertest";
import { eq } from "drizzle-orm";
import { benchmarkCallsTable, db, pool } from "@workspace/db";
import { SCORING_VERSION } from "@workspace/scoring";
import app from "../../app";
import { buildRunManifest } from "../../lib/manifest";
import { Fixtures } from "./fixtures";

const fx = new Fixtures();
const sha = (s: string) => createHash("sha256").update(s).digest("hex");

afterAll(async () => {
  await fx.cleanup();
  await pool.end();
});

describe("GET /api/benchmark/runs/:runId/manifest", () => {
  it("answers the frozen record, and later edits to the call do not change it", async () => {
    const gold = `fx gold ${fx.suffix}`;
    const call = await fx.call({ label: `fx-manifest-${fx.suffix}`, goldTranscript: gold });
    const provider = await fx.provider({ model: "fx-model-1" });
    const manifest = await buildRunManifest([call.id], [provider.id]);
    const run = await fx.run({ manifest, callIds: [call.id], providerIds: [provider.id], callCount: 1 });

    const res = await request(app).get(`/api/benchmark/runs/${run.id}/manifest`);
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ manifestVersion: 1, scoringVersion: SCORING_VERSION, runId: run.id });
    expect(new Date(res.body.createdAt).toISOString()).toBe(manifest.createdAt);
    expect(res.body.calls).toEqual([{ id: call.id, label: call.label, goldTranscriptSha256: sha(gold) }]);
    expect(res.body.providers).toEqual([
      { id: provider.id, name: provider.name, model: "fx-model-1", configSha256: expect.stringMatching(/^[0-9a-f]{64}$/) },
    ]);

    // FR-REP1: correct the gold transcript and rename the call afterwards.
    // What the run claims it ran against must not move -- otherwise a past
    // run's numbers could never be explained again.
    await db
      .update(benchmarkCallsTable)
      .set({ goldTranscript: `${gold} corrected`, label: `fx-renamed-${fx.suffix}` })
      .where(eq(benchmarkCallsTable.id, call.id));

    const after = await request(app).get(`/api/benchmark/runs/${run.id}/manifest`);
    expect(after.status).toBe(200);
    expect(after.body.calls).toEqual([{ id: call.id, label: call.label, goldTranscriptSha256: sha(gold) }]);
  });

  it("a run that predates manifests is refused as such; unknown 404, malformed 400", async () => {
    const legacy = await fx.run();
    const predates = await request(app).get(`/api/benchmark/runs/${legacy.id}/manifest`);
    expect(predates.status).toBe(404);
    expect(predates.body.error).toMatch(/predates manifests/);

    const unknown = await request(app).get("/api/benchmark/runs/00000000-0000-4000-8000-000000000000/manifest");
    expect(unknown.status).toBe(404);

    const malformed = await request(app).get("/api/benchmark/runs/not-a-uuid/manifest");
    expect(malformed.status).toBe(400);
    expect(malformed.body.error).toMatch(/runId/);
  });
});

describe("GET /api/benchmark/bulks/:bulkId/manifest", () => {
  it("composes its shard runs in shard order and stubs the ones that predate manifests", async () => {
    const call = await fx.call({ goldTranscript: `fx bulk gold ${fx.suffix}` });
    const provider = await fx.provider();
    const bulk = await fx.bulk({
      providerIds: [provider.id],
      shardSize: 25,
      selectionCriteria: { resolvedCallIds: [call.id] },
    });
    const manifest = await buildRunManifest([call.id], [provider.id]);
    // Seeded out of order on purpose: the route sorts by shardIndex.
    const shard1 = await fx.run({ bulkId: bulk.id, shardIndex: 1, status: "failed" });
    const shard0 = await fx.run({ bulkId: bulk.id, shardIndex: 0, manifest, callIds: [call.id], providerIds: [provider.id], callCount: 1 });

    const res = await request(app).get(`/api/benchmark/bulks/${bulk.id}/manifest`);
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      manifestVersion: 1,
      bulkId: bulk.id,
      name: bulk.name,
      status: bulk.status,
      providerIds: [provider.id],
      shardSize: 25,
      selectionCriteria: { resolvedCallIds: [call.id] },
    });
    expect(res.body.runs.map((r: { runId: string }) => r.runId)).toEqual([shard0.id, shard1.id]);
    expect(res.body.runs[0]).toMatchObject({
      runId: shard0.id,
      shardIndex: 0,
      runStatus: "complete",
      scoringVersion: SCORING_VERSION,
      calls: [{ id: call.id, goldTranscriptSha256: sha(`fx bulk gold ${fx.suffix}`) }],
    });
    // A run written before manifests existed keeps a truthful stub rather
    // than a fabricated one: it says so, and lists nothing.
    expect(res.body.runs[1]).toMatchObject({
      runId: shard1.id,
      shardIndex: 1,
      runStatus: "failed",
      scoringVersion: "unknown (predates manifests)",
      calls: [],
      providers: [],
    });
  });

  it("answers 404 for an unknown bulk and a sentence for a malformed id", async () => {
    const unknown = await request(app).get("/api/benchmark/bulks/00000000-0000-4000-8000-000000000000/manifest");
    expect(unknown.status).toBe(404);

    const malformed = await request(app).get("/api/benchmark/bulks/not-a-uuid/manifest");
    expect(malformed.status).toBe(400);
    expect(malformed.body.error).toMatch(/bulkId/);
  });
});
