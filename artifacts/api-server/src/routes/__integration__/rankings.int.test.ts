// T-159: GET /api/benchmark/rankings against the throwaway database. The
// snapshot table keeps every past recompute forever, so this route's whole
// job is choosing which rows count: a bulk id scopes strictly to that
// bulk's own snapshot; all-time picks each group's newest batch-purpose,
// non-archived run. That choosing is pure query logic the compile check
// cannot see -- these tests hold it.
//
// No VAPI key is set in the test environment, so the live assistant-name
// lookup degrades and labels fall back to the raw id -- itself asserted
// here, since that fallback is what keeps Rankings up when Vapi is down.
import { afterAll, describe, expect, it } from "vitest";
import request from "supertest";
import { asc, eq } from "drizzle-orm";
import { benchmarkRankingsTable, benchmarkRunsTable, db, pool } from "@workspace/db";
import { server } from "./server";
import { computeRankingsForRun } from "../../lib/run-executor";
import { expectStatus } from "./expect-status";
import { Fixtures } from "./fixtures";

const fx = new Fixtures();
// One assistant per concern: each is its own ranking group, so nothing
// here competes with leftovers or with the other tests in this file.
const asstScoped = `fx-asst-scoped-${fx.suffix}`;
const asstLatest = `fx-asst-latest-${fx.suffix}`;
const asstAgent = `fx-asst-agent-${fx.suffix}`;

async function getRankings(query: Record<string, string> = {}) {
  const res = await request(server).get("/api/benchmark/rankings").query(query);
  expectStatus(res, 200);
  return res.body as { assistantId: string | null; assistantLabel: string; providerId: string; rank: number; runId: string }[];
}

afterAll(async () => {
  await fx.cleanup();
  await pool.end();
});

describe("GET /api/benchmark/rankings", () => {
  it("bulkId scopes strictly to that bulk's snapshot, in rank order", async () => {
    const bulk = await fx.bulk();
    const run = await fx.run({ bulkId: bulk.id });
    await fx.ranking({ bulkId: bulk.id, runId: run.id, assistantId: asstScoped, rank: 2, providerId: `fx-${fx.suffix}-b` });
    await fx.ranking({ bulkId: bulk.id, runId: run.id, assistantId: asstScoped, rank: 1, providerId: `fx-${fx.suffix}-a` });
    // A row from some other snapshot must not leak in.
    const otherRun = await fx.run({});
    await fx.ranking({ runId: otherRun.id, assistantId: asstScoped, rank: 1, providerId: `fx-${fx.suffix}-other` });

    const rows = await getRankings({ bulkId: bulk.id });
    expect(rows.map((r) => r.providerId)).toEqual([`fx-${fx.suffix}-a`, `fx-${fx.suffix}-b`]);
    expect(rows.map((r) => r.rank)).toEqual([1, 2]);
  });

  it("all-time picks each group's newest batch run, skips archived (T-134) and agent-scan runs", async () => {
    const older = await fx.run({ createdAt: new Date(Date.now() - 120_000) });
    const newer = await fx.run({ createdAt: new Date(Date.now() - 60_000) });
    await fx.ranking({ runId: older.id, assistantId: asstLatest, providerId: `fx-${fx.suffix}-old` });
    await fx.ranking({ runId: newer.id, assistantId: asstLatest, providerId: `fx-${fx.suffix}-new` });

    let mine = (await getRankings()).filter((r) => r.assistantId === asstLatest);
    expect(mine.map((r) => r.providerId)).toEqual([`fx-${fx.suffix}-new`]);

    // Archiving the newest run retires its snapshot from Results -- the
    // older run's row is the group's latest again.
    await db.update(benchmarkRunsTable).set({ archivedAt: new Date() }).where(eq(benchmarkRunsTable.id, newer.id));
    mine = (await getRankings()).filter((r) => r.assistantId === asstLatest);
    expect(mine.map((r) => r.providerId)).toEqual([`fx-${fx.suffix}-old`]);

    // A 1-call agent_scan run recomputes rankings too (same executor), but
    // must never decide a group's latest.
    const agentRun = await fx.run({ purpose: "agent_scan" });
    await fx.ranking({ runId: agentRun.id, assistantId: asstAgent, providerId: `fx-${fx.suffix}-agent` });
    const agentRows = (await getRankings()).filter((r) => r.assistantId === asstAgent);
    expect(agentRows).toEqual([]);
  });

  it("labels fall back to the raw assistant id when Vapi cannot answer", async () => {
    const run = await fx.run({});
    await fx.ranking({ runId: run.id, assistantId: asstScoped, providerId: `fx-${fx.suffix}-lbl` });
    const mine = (await getRankings()).filter((r) => r.assistantId === asstScoped);
    expect(mine.length).toBeGreaterThan(0);
    expect(mine[0].assistantLabel).toBe(asstScoped);
  });

  it("rejects a malformed bulkId with a sentence, not a 500", async () => {
    const res = await request(server).get("/api/benchmark/rankings").query({ bulkId: "not-a-uuid" });
    expectStatus(res, 400);
    expect(res.body.error).toMatch(/bulkId/);
  });
});


// M-10c: the aggregation that WRITES a ranking row had no integration
// coverage -- rankings.int.test.ts above inserts its rows directly, so
// nothing here ever proved run-executor's stored `recommendation` sentence.
// That is how it stayed false on 61 of the live corpus's 62 assistant
// groups for as long as it did. computeRankingsForRun only reads rows and
// writes rankings; it calls no provider and spends nothing.
describe("computeRankingsForRun -- the stored recommendation sentence", () => {
  it("does not claim rank 1 had the fewest flags when the group tied on flags", async () => {
    const asst = `fx-asst-tie-${fx.suffix}`;
    const run = await fx.run({ purpose: "batch" });
    const call = await fx.call({ sourceAssistantId: asst, durationSeconds: 60 });
    const cheap = await fx.provider();
    const dear = await fx.provider();

    // Same flag badness on both sides, different price: the only thing left
    // in the composite after M-10a is cost, so price is what decided this.
    for (const [provider, microcents] of [
      [cheap, 220_000],
      [dear, 430_000],
    ] as const) {
      const result = await fx.result(run.id, call.id, provider.id, {
        hypothesisTranscript: "the tenant asked about the lease",
      });
      await fx.score(result.id, {
        peerFlagCount: 0,
        peerFlagSeverity: "none",
        costMicrocents: microcents,
      });
    }

    await computeRankingsForRun(run.id, [call.id], [cheap.id, dear.id]);
    const rows = await db
      .select()
      .from(benchmarkRankingsTable)
      .where(eq(benchmarkRankingsTable.runId, run.id))
      .orderBy(asc(benchmarkRankingsTable.rank));
    // Untracked by Fixtures (benchmark_rankings has no FK to runs), so drop
    // them before asserting -- a failed expect must not leave rows behind.
    await db.delete(benchmarkRankingsTable).where(eq(benchmarkRankingsTable.runId, run.id));

    expect(rows.map((r) => r.providerId)).toEqual([cheap.id, dear.id]);
    expect(rows[0].recommendation).not.toContain("fewest");
    expect(rows[0].recommendation).toContain("tied on hybrid flags with 1 other provider");
    expect(rows[0].recommendation).toContain("Price decided this order, not accuracy");
    // The runner-up carried the same false claim, and carried it on the
    // cheapest, equally-clean provider in 33 live groups.
    expect(rows[1].recommendation).not.toContain("more or more-severe");
    expect(rows[1].recommendation).toContain("Tied with rank 1 on hybrid flags");
  });

  it("keeps the fewest-flags sentence when rank 1 really is the cleanest", async () => {
    const asst = `fx-asst-clean-${fx.suffix}`;
    const run = await fx.run({ purpose: "batch" });
    const call = await fx.call({ sourceAssistantId: asst, durationSeconds: 60 });
    const clean = await fx.provider();
    const flaggy = await fx.provider();

    for (const [provider, flags] of [
      [clean, 0],
      [flaggy, 3],
    ] as const) {
      const result = await fx.result(run.id, call.id, provider.id, {
        hypothesisTranscript: "the tenant asked about the lease",
      });
      await fx.score(result.id, {
        peerFlagCount: flags,
        peerFlagSeverity: flags === 0 ? "none" : "high",
        costMicrocents: 400_000,
      });
    }

    await computeRankingsForRun(run.id, [call.id], [clean.id, flaggy.id]);
    const rows = await db
      .select()
      .from(benchmarkRankingsTable)
      .where(eq(benchmarkRankingsTable.runId, run.id))
      .orderBy(asc(benchmarkRankingsTable.rank));
    await db.delete(benchmarkRankingsTable).where(eq(benchmarkRankingsTable.runId, run.id));

    expect(rows[0].providerId).toBe(clean.id);
    expect(rows[0].recommendation).toContain("fewest/least-severe hybrid flags");
    expect(rows[1].recommendation).toContain("Behind rank 1 on hybrid flags");
  });
});

// M-10e. The end-of-audio average is the first ranking metric that is null
// for six of seven providers BY CONSTRUCTION rather than by accident: a
// batch adapter is handed a finished file, so there is no moment the audio
// ended to measure from. That makes two mistakes cheap to write and
// expensive to spot -- averaging the nulls in as zeros (which would make a
// half-measured streaming provider look twice as fast as it is), and
// letting the number leak into the composite (which would rank six
// providers below one for a race they were never in). Both are guarded
// here, against stored rows, not against the helper in isolation.
//
// Reads rows and writes rankings; calls no provider and spends nothing.
describe("computeRankingsForRun -- the stored end-of-audio latency", () => {
  it("averages only the cells that measured it, and leaves a batch provider null", async () => {
    const asst = `fx-asst-eoa-${fx.suffix}`;
    const run = await fx.run({ purpose: "batch" });
    const callA = await fx.call({ sourceAssistantId: asst, durationSeconds: 60 });
    const callB = await fx.call({ sourceAssistantId: asst, durationSeconds: 60 });
    const streamer = await fx.provider();
    const batcher = await fx.provider();

    // The streaming provider measured one of its two calls. The honest
    // average is 800, not 400 -- the unmeasured cell is absent, not zero.
    for (const [call, endOfAudio] of [
      [callA, 800],
      [callB, null],
    ] as const) {
      const r = await fx.result(run.id, call.id, streamer.id, { hypothesisTranscript: "the tenant asked about the lease" });
      await fx.score(r.id, { peerFlagCount: 1, peerFlagSeverity: "low", costMicrocents: 300_000, latencyEndOfAudioMs: endOfAudio });
    }
    for (const call of [callA, callB]) {
      const r = await fx.result(run.id, call.id, batcher.id, { hypothesisTranscript: "the tenant asked about the lease" });
      await fx.score(r.id, { peerFlagCount: 1, peerFlagSeverity: "low", costMicrocents: 300_000 });
    }

    await computeRankingsForRun(run.id, [callA.id, callB.id], [streamer.id, batcher.id]);
    const rows = await db
      .select()
      .from(benchmarkRankingsTable)
      .where(eq(benchmarkRankingsTable.runId, run.id))
      .orderBy(asc(benchmarkRankingsTable.rank));
    await db.delete(benchmarkRankingsTable).where(eq(benchmarkRankingsTable.runId, run.id));

    const streamerRow = rows.find((r) => r.providerId === streamer.id);
    const batcherRow = rows.find((r) => r.providerId === batcher.id);
    expect(streamerRow!.latencyEndOfAudioMs).toBe(800);
    // Null, never 0. A batch provider showing 0 ms would read as instant.
    expect(batcherRow!.latencyEndOfAudioMs).toBeNull();
  });

  it("does not let the end-of-audio number change the order", async () => {
    const asst = `fx-asst-eoa-rank-${fx.suffix}`;
    const run = await fx.run({ purpose: "batch" });
    const call = await fx.call({ sourceAssistantId: asst, durationSeconds: 60 });
    const quick = await fx.provider();
    const slowButClean = await fx.provider();

    // Identical price, so flags are the only thing left in the composite
    // (M-10a). `quick` is 25x better on end-of-audio and 3 peer flags worse;
    // if the number ranked anything at all, it would rank first.
    for (const [provider, flags, endOfAudio] of [
      [quick, 3, 200],
      [slowButClean, 0, 5_000],
    ] as const) {
      const r = await fx.result(run.id, call.id, provider.id, { hypothesisTranscript: "the tenant asked about the lease" });
      await fx.score(r.id, {
        peerFlagCount: flags,
        peerFlagSeverity: flags === 0 ? "none" : "high",
        costMicrocents: 400_000,
        latencyEndOfAudioMs: endOfAudio,
      });
    }

    await computeRankingsForRun(run.id, [call.id], [quick.id, slowButClean.id]);
    const rows = await db
      .select()
      .from(benchmarkRankingsTable)
      .where(eq(benchmarkRankingsTable.runId, run.id))
      .orderBy(asc(benchmarkRankingsTable.rank));
    await db.delete(benchmarkRankingsTable).where(eq(benchmarkRankingsTable.runId, run.id));

    expect(rows[0].providerId).toBe(slowButClean.id);
    expect(rows[0].latencyEndOfAudioMs).toBe(5_000);
    expect(rows[1].latencyEndOfAudioMs).toBe(200);
    // And it stays out of the sentence: the recommendation explains the
    // order from flags and price, never from this number.
    expect(rows[0].recommendation).not.toMatch(/audio|latenc|speed/i);
  });
});
