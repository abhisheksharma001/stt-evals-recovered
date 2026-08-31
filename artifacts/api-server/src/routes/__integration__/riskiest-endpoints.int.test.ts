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
//
// T-139 added three more, each an endpoint that had no route test and had
// already broken (or could break) silently in production:
//   (d) GET /disagreement-spans -- the whole response must satisfy its own
//       schema. It did not between T-47 and T-136 (a dropped `majorityText`
//       made every call answer 500), and nothing caught it.
//   (e) POST /runs/{id}/archive -- ad-hoc runs archive and restore; a bulk
//       shard is refused with 409.
//   (f) POST /calls/cache-audio -- answers with the four counts even when
//       there is nothing it can save.
//
// T-143 added (g): the parameter checks themselves. A malformed id, a missing
// required parameter and a repeated parameter each answer 400 -- before
// T-141/T-142 the first two reached the database and answered 500.
//
// T-150 added (h): the answers themselves. The two routes that read their
// params raw (T-146), the JSON 404 for an unmatched path (T-149), and the
// sentence a rejected request comes back with instead of zod's issue array.
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
// T-139 (d): vendor-prefixed so extractProviderTimedWords reads their word
// timings -- spans need at least two candidates and one full set of timings.
const spanProviderA = `deepgram-t137a-${suffix}`;
const spanProviderB = `deepgram-t137b-${suffix}`;
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

/** A Deepgram-shaped raw response (seconds), the exact shape timed-words.ts
 *  reads. Words are one per second so the spans are easy to assert on. */
function deepgramRaw(words: string[]): string {
  return JSON.stringify({
    results: {
      channels: [{ alternatives: [{ words: words.map((word, i) => ({ word, start: i, end: i + 0.5 })) }] }],
    },
  });
}

beforeAll(async () => {
  await db.insert(benchmarkProvidersTable).values([
    { id: providerId, name: `T-77 ${suffix}`, model: "none", status: "not_configured" },
    { id: spanProviderA, name: `T-137 A ${suffix}`, model: "none", status: "not_configured" },
    { id: spanProviderB, name: `T-137 B ${suffix}`, model: "none", status: "not_configured" },
  ]);
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
  await db.delete(benchmarkProvidersTable).where(inArray(benchmarkProvidersTable.id, [providerId, spanProviderA, spanProviderB]));
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

describe("(d) GET /api/benchmark/disagreement-spans", () => {
  it("404s on an unknown call", async () => {
    const res = await request(app).get("/api/benchmark/disagreement-spans").query({ callId: "00000000-0000-4000-8000-000000000000" });
    expect(res.status).toBe(404);
  });

  it("answers the full schema, majorityText included, for two disagreeing providers", async () => {
    const [run] = await db
      .insert(benchmarkRunsTable)
      .values({ status: "complete", purpose: "batch", providerIds: [spanProviderA, spanProviderB], callIds: [callId], callCount: 1 })
      .returning();
    runIds.push(run.id);

    // Same three words, one heard differently -> exactly one span.
    await upsertResult(run.id, callId, spanProviderA, {
      status: "ok",
      hypothesisTranscript: "book the load",
      rawOutput: deepgramRaw(["book", "the", "load"]),
    });
    await upsertResult(run.id, callId, spanProviderB, {
      status: "ok",
      hypothesisTranscript: "book the road",
      rawOutput: deepgramRaw(["book", "the", "road"]),
    });

    const res = await request(app).get("/api/benchmark/disagreement-spans").query({ callId, runId: run.id });
    // A 500 here is the T-136 regression: the response did not satisfy its
    // own schema, which no typecheck can catch.
    expect(res.status).toBe(200);
    expect(res.body.unavailableReason).toBeNull();
    expect(res.body.referenceWords).toEqual(["book", "the", "load"]);
    // T-137: one start per reference word, in order, milliseconds.
    expect(res.body.referenceWordStartMs).toEqual([0, 1000, 2000]);
    expect(res.body.spans).toHaveLength(1);
    const span = res.body.spans[0];
    expect(span.referencePositions).toEqual([2, 2]);
    expect(span.startMs).toBe(2000);
    // Two providers, one vote each: a tie, which is reported as null rather
    // than a made-up winner.
    expect(span).toHaveProperty("majorityText", null);
    expect(span.readings.map((r: { providerId: string; text: string }) => r.text).sort()).toEqual(["load", "road"]);
  });
});

describe("(e) POST /api/benchmark/runs/:runId/archive", () => {
  it("archives and restores an ad-hoc run, and refuses a bulk shard with 409", async () => {
    const [adhoc] = await db
      .insert(benchmarkRunsTable)
      .values({ status: "complete", purpose: "batch", providerIds: [providerId], callIds: [callId], callCount: 1 })
      .returning();
    runIds.push(adhoc.id);

    const archived = await request(app).post(`/api/benchmark/runs/${adhoc.id}/archive`).send({ archived: true });
    expect(archived.status).toBe(200);
    expect(archived.body.archivedAt).not.toBeNull();

    const restored = await request(app).post(`/api/benchmark/runs/${adhoc.id}/archive`).send({ archived: false });
    expect(restored.status).toBe(200);
    expect(restored.body.archivedAt).toBeNull();

    // A shard belongs to its bulk; hiding one would silently change what the
    // bulk's verdict was computed from (FR-BLK-10).
    const bulk = await seedBulk("t137 archive", "complete");
    const [shard] = await db
      .insert(benchmarkRunsTable)
      .values({ status: "complete", purpose: "batch", bulkId: bulk.id, providerIds: [providerId], callIds: [callId], callCount: 1 })
      .returning();
    runIds.push(shard.id);
    const refused = await request(app).post(`/api/benchmark/runs/${shard.id}/archive`).send({ archived: true });
    expect(refused.status).toBe(409);
  });

  it("404s on an unknown run", async () => {
    const res = await request(app).post("/api/benchmark/runs/00000000-0000-4000-8000-000000000000/archive").send({ archived: true });
    expect(res.status).toBe(404);
  });
});

describe("(f) POST /api/benchmark/calls/cache-audio", () => {
  it("answers with counts, and never throws when there is nothing to save", async () => {
    const res = await request(app).post("/api/benchmark/calls/cache-audio").send();
    expect(res.status).toBe(200);
    // The endpoint takes no body: it sweeps every uncached call. The seeded
    // call has no recording anywhere, so it can only be a failure -- what
    // matters here is that one bad call does not throw, and that every call
    // lands in exactly one bucket.
    const { alreadyCachedCount, savedCount, failedCount, expiredCount, results } = res.body;
    expect(savedCount).toBe(0);
    expect(alreadyCachedCount + savedCount + failedCount + expiredCount).toBeGreaterThanOrEqual(1);
    expect(results.length).toBe(savedCount + failedCount + expiredCount);
    expect(results.every((r: { outcome: string }) => ["saved", "failed", "expired"].includes(r.outcome))).toBe(true);
  });
});

// T-143: the parameter checks T-141/T-142 put in. Before them a malformed id
// went straight into a `where id = $1` against a uuid column, Postgres threw,
// and the caller got 500 "Internal server error" for their own typo; a missing
// required parameter became the literal string "undefined" and was looked up
// as if it were an id. Both are client mistakes and both must answer 400.
describe("(g) parameter validation", () => {
  const junk = "not-a-uuid";

  it("answers 400, not 500, for a malformed id in the path", async () => {
    const paths = [
      `/api/benchmark/calls/${junk}`,
      `/api/benchmark/calls/${junk}/comparison`,
      `/api/benchmark/bulks/${junk}`,
      `/api/benchmark/bulks/${junk}/verdicts`,
      `/api/benchmark/bulks/${junk}/manifest`,
      `/api/benchmark/runs/${junk}/results`,
      `/api/benchmark/runs/${junk}/manifest`,
    ];
    for (const path of paths) {
      const res = await request(app).get(path);
      expect(`${path} -> ${res.status}`).toBe(`${path} -> 400`);
    }
  });

  it("answers 400 for a malformed id in the query string", async () => {
    for (const path of [
      `/api/benchmark/disagreement-spans?callId=${junk}`,
      `/api/benchmark/rankings?bulkId=${junk}`,
      `/api/benchmark/words-to-watch?bulkId=${junk}`,
      `/api/benchmark/assistant-signals?bulkId=${junk}`,
    ]) {
      const res = await request(app).get(path);
      expect(`${path} -> ${res.status}`).toBe(`${path} -> 400`);
    }
  });

  it("names the parameter a caller left out instead of inventing one", async () => {
    // T-142: with string coercion this was `String(undefined)` -- the id
    // "undefined" -- so /volume answered 404 "no account labelled undefined"
    // and /disagreement-spans looked up a call that cannot exist.
    // T-150: the answer names the parameter in a sentence. It used to be
    // zod's stringified issue array, with "Required" buried inside it.
    const expected: Record<string, string> = {
      "/api/benchmark/disagreement-spans": "callId is required",
      "/api/benchmark/volume": "accountLabel is required",
    };
    for (const [path, sentence] of Object.entries(expected)) {
      const res = await request(app).get(path);
      expect(`${path} -> ${res.status}`).toBe(`${path} -> 400`);
      expect(`${path} -> ${res.body.error}`).toBe(`${path} -> ${sentence}`);
    }
  });

  it("refuses a repeated parameter instead of joining it with a comma", async () => {
    const res = await request(app).get(`/api/benchmark/disagreement-spans?callId=${callId}&callId=${callId}`);
    expect(res.status).toBe(400);
    expect(res.body.error).toBe("callId must be a string, not an array");
  });

  it("still accepts the ids and text parameters that are genuinely valid", async () => {
    const ok = [
      `/api/benchmark/calls/${callId}`,
      `/api/benchmark/disagreement-spans?callId=${callId}`,
      "/api/benchmark/rankings",
      // assistantId is Vapi's own id in a text column, not a uuid: a value
      // that is not uuid-shaped must still be answered, not refused.
      `/api/benchmark/words-to-watch?assistantId=${junk}`,
    ];
    for (const path of ok) {
      const res = await request(app).get(path);
      expect(`${path} -> ${res.status}`).toBe(`${path} -> 200`);
    }
  });
});

describe("(h) the two routes that read their params raw, and what a refusal says", () => {
  const junk = "not-a-uuid";

  it("T-146: the audio and archive routes answer 400 for a malformed id, not 500", async () => {
    const audio = await request(app).get(`/api/benchmark/calls/${junk}/audio`);
    expect(`audio -> ${audio.status}`).toBe("audio -> 400");
    expect(audio.body.error).toBe("callId must be a valid uuid");

    const archive = await request(app).post(`/api/benchmark/runs/${junk}/archive`).send({ archived: true });
    expect(`archive -> ${archive.status}`).toBe("archive -> 400");
    expect(archive.body.error).toBe("runId must be a valid uuid");
  });

  it("T-146: a real call's audio still answers, and the archive route still validates its body", async () => {
    // The seeded call has no cached bytes and no source recording, so the
    // honest answer is 404 (or a Vapi error) -- never 500, and never the
    // uuid refusal above.
    const audio = await request(app).get(`/api/benchmark/calls/${callId}/audio`);
    expect([200, 206, 302, 404, 502, 503]).toContain(audio.status);
    expect(audio.status).not.toBe(400);

    const [run] = await db
      .insert(benchmarkRunsTable)
      .values({ status: "complete", purpose: "batch", providerIds: [], callIds: [callId], callCount: 1 })
      .returning();
    runIds.push(run.id);
    const noBody = await request(app).post(`/api/benchmark/runs/${run.id}/archive`).send({});
    expect(`no body -> ${noBody.status}`).toBe("no body -> 400");
    expect(noBody.body.error).toBe("archived is required");
  });

  it("T-149: an unmatched path answers JSON 404, not Express's HTML page", async () => {
    for (const [method, path] of [
      ["post", "/api/benchmark/agent/scans"],
      ["get", "/api/benchmark/nope"],
    ] as const) {
      const res = await request(app)[method](path);
      expect(`${path} -> ${res.status}`).toBe(`${path} -> 404`);
      expect(res.headers["content-type"]).toContain("application/json");
      expect(res.body.error).toBe(`No such endpoint: ${method.toUpperCase()} ${path}`);
    }
  });

  it("T-151: a settings PATCH that would change nothing is refused, not crashed", async () => {
    // Both bodies leave nothing to set -- zod strips the unknown key -- and
    // both used to reach drizzle's `.set({})` and answer 500.
    for (const body of [{}, { judgeModel: 123 }]) {
      const res = await request(app).patch("/api/benchmark/settings").send(body);
      expect(`${JSON.stringify(body)} -> ${res.status}`).toBe(`${JSON.stringify(body)} -> 400`);
      expect(res.body.error).toContain("Name at least one setting to change");
    }
  });

  it("T-150: a rejected body says what is wrong in a sentence", async () => {
    const res = await request(app).post("/api/benchmark/bulks").send({ label: "x" });
    expect(res.status).toBe(400);
    expect(res.body.error).toContain("criteria is required");
    // The old answer opened with zod's serialised issue array.
    expect(res.body.error.startsWith("[")).toBe(false);
  });
});
