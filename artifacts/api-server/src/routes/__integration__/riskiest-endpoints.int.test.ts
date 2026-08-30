// T-77: route-level tests for the three riskiest endpoints, against a
// throwaway database (see vitest.integration.config.ts). Every row this
// file inserts carries a random suffix and is deleted in afterAll.
//
//   (a) T-27 upsertResult -- a second write to an "ok" cell is discarded,
//       a "failed" cell is replaced (same row id kept).
//   (b) POST /bulks/{id}/launch twice -- the second is refused (409) by the
//       status machine. The launched shard runs offline: the seeded call
//       has no audio, so every cell fails before any provider is called.
//   (c) GET /bulks/{id}/verdicts and verdict.html -- 404 on an unknown id,
//       200 with the expected shape on a seeded bulk.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import request from "supertest";
import { eq, inArray } from "drizzle-orm";
import {
  db,
  pool,
  benchmarkBulksTable,
  benchmarkCallsTable,
  benchmarkProvidersTable,
  benchmarkProviderCallResultsTable,
  benchmarkRunsTable,
} from "@workspace/db";
import app from "../../app";
import { upsertResult } from "../../lib/run-executor";

const suffix = Math.random().toString(36).slice(2, 10);
const providerId = `t77-provider-${suffix}`;
let callId = "";
const bulkIds: string[] = [];
const runIds: string[] = [];

async function seedBulk(name: string, status: string) {
  const [bulk] = await db
    .insert(benchmarkBulksTable)
    .values({
      name: `${name} ${suffix}`,
      status,
      selectionCriteria: { resolvedCallIds: [callId] },
      providerIds: [providerId],
      shardSize: 50,
      minDurationSeconds: 0,
    })
    .returning();
  bulkIds.push(bulk.id);
  return bulk;
}

async function waitForRunsToSettle(bulkId: string): Promise<string[]> {
  for (let i = 0; i < 60; i++) {
    const runs = await db.select({ id: benchmarkRunsTable.id, status: benchmarkRunsTable.status }).from(benchmarkRunsTable).where(eq(benchmarkRunsTable.bulkId, bulkId));
    if (runs.length > 0 && runs.every((r) => r.status !== "queued" && r.status !== "running")) return runs.map((r) => r.status);
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error("shard runs did not settle in 15s");
}

beforeAll(async () => {
  await db.insert(benchmarkProvidersTable).values({ id: providerId, name: `T-77 ${suffix}`, model: "none", status: "not_configured" });
  const [call] = await db
    .insert(benchmarkCallsTable)
    .values({ label: `t77-call-${suffix}`, vertical: "property_management", durationSeconds: 30, status: "ready_to_run" })
    .returning();
  callId = call.id;
});

afterAll(async () => {
  if (runIds.length) await db.delete(benchmarkRunsTable).where(inArray(benchmarkRunsTable.id, runIds));
  if (bulkIds.length) await db.delete(benchmarkBulksTable).where(inArray(benchmarkBulksTable.id, bulkIds));
  if (callId) await db.delete(benchmarkCallsTable).where(eq(benchmarkCallsTable.id, callId));
  await db.delete(benchmarkProvidersTable).where(eq(benchmarkProvidersTable.id, providerId));
  await pool.end();
});

describe("(a) T-27 upsertResult", () => {
  it("keeps an ok cell against a later write and replaces a failed cell in place", async () => {
    const [run] = await db
      .insert(benchmarkRunsTable)
      .values({ status: "complete", purpose: "batch", providerIds: [providerId], callIds: [callId], callCount: 1 })
      .returning();
    runIds.push(run.id);

    const first = await upsertResult(run.id, callId, providerId, { status: "ok", hypothesisTranscript: "hello world" });
    expect(first?.status).toBe("ok");

    // A later "failed" (or duplicate "ok") must not clobber the evidence row.
    const clobber = await upsertResult(run.id, callId, providerId, { status: "failed", errorMessage: "late failure" });
    expect(clobber).toBeUndefined();
    const [kept] = await db.select().from(benchmarkProviderCallResultsTable).where(eq(benchmarkProviderCallResultsTable.id, first!.id));
    expect(kept.status).toBe("ok");
    expect(kept.hypothesisTranscript).toBe("hello world");

    // The one opt-out: the writer replacing its own just-written row.
    const own = await upsertResult(run.id, callId, providerId, { status: "failed", errorMessage: "scoring blew up" }, { replaceOk: true });
    expect(own?.id).toBe(first!.id);
    expect(own?.status).toBe("failed");

    // A failed cell is what a retry replaces -- same row id, new attempt.
    const retried = await upsertResult(run.id, callId, providerId, { status: "ok", hypothesisTranscript: "hello again" });
    expect(retried?.id).toBe(first!.id);
    expect(retried?.status).toBe("ok");
    expect(retried?.errorMessage).toBeNull();
  });
});

describe("(b) POST /api/benchmark/bulks/:id/launch", () => {
  it("accepts the first launch and refuses the second with 409", async () => {
    const bulk = await seedBulk("t77 launch", "draft");
    const first = await request(app).post(`/api/benchmark/bulks/${bulk.id}/launch`).send();
    expect(first.status).toBe(202);
    expect(first.body.status).toBe("running");

    const second = await request(app).post(`/api/benchmark/bulks/${bulk.id}/launch`).send();
    expect(second.status).toBe(409);
    expect(second.body.error).toMatch(/not launchable/);

    // Let the offline shard finish (no audio -> failed cells) before teardown.
    const statuses = await waitForRunsToSettle(bulk.id);
    expect(statuses.length).toBe(1);
    const runs = await db.select({ id: benchmarkRunsTable.id }).from(benchmarkRunsTable).where(eq(benchmarkRunsTable.bulkId, bulk.id));
    runIds.push(...runs.map((r) => r.id));
  });

  it("404s on an unknown bulk", async () => {
    const res = await request(app).post(`/api/benchmark/bulks/00000000-0000-4000-8000-000000000000/launch`).send();
    expect(res.status).toBe(404);
  });
});

describe("(c) GET /api/benchmark/bulks/:id/verdicts and verdict.html", () => {
  it("404s on an unknown bulk", async () => {
    const json = await request(app).get(`/api/benchmark/bulks/00000000-0000-4000-8000-000000000000/verdicts`);
    expect(json.status).toBe(404);
    const html = await request(app).get(`/api/benchmark/bulks/00000000-0000-4000-8000-000000000000/verdict.html`);
    expect(html.status).toBe(404);
  });

  it("returns the verdict shape and a dated HTML page for a seeded bulk", async () => {
    const bulk = await seedBulk("t77 verdicts", "complete");
    const json = await request(app).get(`/api/benchmark/bulks/${bulk.id}/verdicts`);
    expect(json.status).toBe(200);
    expect(json.body).toEqual({ bulkId: bulk.id, providers: [], groups: [] });

    const html = await request(app).get(`/api/benchmark/bulks/${bulk.id}/verdict.html`);
    expect(html.status).toBe(200);
    expect(html.headers["content-type"]).toMatch(/text\/html/);
    expect(html.text).toContain(`STT verdict: ${bulk.name}`);
    expect(html.text).toContain("Winner");
  });
});
