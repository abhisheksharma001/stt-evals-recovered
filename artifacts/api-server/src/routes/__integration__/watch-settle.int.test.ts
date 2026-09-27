// W-5d: settling, against the throwaway database. The four T-19 numbers move
// off the bulk and onto the ledger row, and are still there once the bulk is
// gone.
//
// `settleLaunchedRuns` reads EVERY launched row in the database -- that is
// what it is for -- and integration files run in parallel against one
// database, so every assertion here is containment on this suite's own ids,
// never a count of the table. For the same reason no fixture here is left
// `launched` with a finished bulk unless the test means it to settle:
// `fx.bulk` defaults to status "complete" and `fx.watchRun` to outcome
// "launched", so the pair is easy to create by accident.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import request from "supertest";
import { db, pool, watchRunsTable, benchmarkBulksTable, type WatchRunTotals, type WatchRunProduction } from "@workspace/db";
import { eq } from "drizzle-orm";
import { server } from "./server";
import { Fixtures } from "./fixtures";
import { settleLaunchedRuns } from "../../lib/watch-settle";

const fx = new Fixtures();

let scheduleId: string;
let assistantId: string;
let scoredProviderId: string;

/** Settled row, running row, and the row whose bulk was evicted first. */
let settledRunId: string;
let settledBulkId: string;
let runningRunId: string;
let orphanRunId: string;
/** W-5e: a customer-channel bulk whose production measurement must settle. */
let customerRunId: string;
let customerBulkId: string;

const readRun = async (id: string) => {
  const [row] = await db.select().from(watchRunsTable).where(eq(watchRunsTable.id, id)).limit(1);
  return row;
};

beforeAll(async () => {
  const schedule = await fx.schedule();
  scheduleId = schedule.id;
  assistantId = `fx-asst-settle-${fx.suffix}`;
  const account = `fx-acct-settle-${fx.suffix}`;

  const flagged = await fx.call({ sourceAccountLabel: account, sourceAssistantId: assistantId });
  const clean = await fx.call({ sourceAccountLabel: account, sourceAssistantId: assistantId });
  const provider = await fx.provider({ name: `fx settle provider ${fx.suffix}` });
  scoredProviderId = provider.id;

  // The day that launched and finished: two scored calls, one flagged.
  const finished = await fx.bulk({ status: "complete", completedAt: new Date("2026-09-16T04:00:00.000Z") });
  settledBulkId = finished.id;
  const run = await fx.run({ bulkId: finished.id, purpose: "batch" });
  const r1 = await fx.result(run.id, flagged.id, provider.id, { hypothesisTranscript: "hello world something" });
  await fx.score(r1.id, { peerFlagCount: 2 });
  const r2 = await fx.result(run.id, clean.id, provider.id, { hypothesisTranscript: "clean words here" });
  await fx.score(r2.id, { peerFlagCount: 0 });
  settledRunId = (await fx.watchRun(scheduleId, "2026-09-16", { bulkId: finished.id })).id;

  // A day still running. Its sums keep moving, so it must be left alone.
  const running = await fx.bulk({ status: "running" });
  const runningRun = await fx.run({ bulkId: running.id, purpose: "batch" });
  const r3 = await fx.result(runningRun.id, flagged.id, provider.id, { hypothesisTranscript: "moving point" });
  await fx.score(r3.id, { peerFlagCount: 0 });
  runningRunId = (await fx.watchRun(scheduleId, "2026-09-17", { bulkId: running.id })).id;

  // A day whose bulk was evicted before anyone copied its numbers.
  orphanRunId = (await fx.watchRun(scheduleId, "2026-09-15", { bulkId: null })).id;

  // W-5e: a finished bulk on the caller track. Two calls whose Vapi draft has
  // caller turns, three candidates each (M-8a needs three voters), one
  // candidate off by a word on every call. Production's draft matches the
  // majority on both, so its disagreement is 0 of the compared words and
  // the leader is one of the two agreeing candidates.
  const customerAssistant = `fx-asst-prod-${fx.suffix}`;
  const draft = "AI: hello there\nUser: alpha beta gamma epsilon";
  const c1 = await fx.call({ sourceAccountLabel: account, sourceAssistantId: customerAssistant, draftTranscript: draft });
  const c2 = await fx.call({ sourceAccountLabel: account, sourceAssistantId: customerAssistant, draftTranscript: draft });
  const cands = [
    await fx.provider({ name: `fx prod cand a ${fx.suffix}` }),
    await fx.provider({ name: `fx prod cand b ${fx.suffix}` }),
    await fx.provider({ name: `fx prod cand c ${fx.suffix}` }),
  ];
  const customerBulk = await fx.bulk({
    status: "complete",
    completedAt: new Date("2026-09-14T04:00:00.000Z"),
    selectionCriteria: { resolvedCallIds: [], requireCustomerAudio: true },
  });
  customerBulkId = customerBulk.id;
  // The run's callIds are what both readers (bulkVerdicts and the settle
  // loader) walk; the fixture default is an empty list.
  const customerRun = await fx.run({
    bulkId: customerBulk.id,
    purpose: "batch",
    callIds: [c1.id, c2.id],
    providerIds: cands.map((c) => c.id),
  });
  for (const call of [c1, c2]) {
    for (const [i, cand] of cands.entries()) {
      const r = await fx.result(customerRun.id, call.id, cand.id, {
        audioSource: "customer",
        hypothesisTranscript: i === 2 ? "alpha beta gamma delta" : "alpha beta gamma epsilon",
      });
      await fx.score(r.id, { peerFlagCount: i === 2 ? 1 : 0 });
    }
  }
  customerRunId = (await fx.watchRun(scheduleId, "2026-09-14", { bulkId: customerBulk.id })).id;

  await settleLaunchedRuns();
});

afterAll(async () => {
  await fx.cleanup();
  await pool.end();
});

describe("W-5d settle", () => {
  it("settles a launched row whose bulk finished, with the numbers GET /benchmark/trend reports for that bulk", async () => {
    const row = await readRun(settledRunId);
    expect(row.outcome).toBe("settled");

    const totals = row.totals as WatchRunTotals[];
    expect(totals).toEqual([
      {
        assistantId,
        providerId: scoredProviderId,
        peerFlags: 2,
        // Three words in each of the two scored calls: the T-19 basis is one
        // number per CALL shared by every provider on it, summed over the day.
        words: 6,
        callsScored: 2,
        cleanCalls: 1,
      },
    ]);

    // Not "looks right" -- the same numbers the strip draws. The endpoint is
    // all-database, so the comparison is on this bulk's cells only.
    const res = await request(server).get("/api/benchmark/trend");
    expect(res.status).toBe(200);
    const cells = (res.body.cells as { bulkId: string; assistantId: string | null; providerId: string }[]).filter(
      (c) => c.bulkId === settledBulkId,
    );
    expect(cells).toHaveLength(1);
    expect(totals[0]).toEqual({
      assistantId: cells[0].assistantId,
      providerId: cells[0].providerId,
      peerFlags: (cells[0] as unknown as WatchRunTotals).peerFlags,
      words: (cells[0] as unknown as WatchRunTotals).words,
      callsScored: (cells[0] as unknown as WatchRunTotals).callsScored,
      cleanCalls: (cells[0] as unknown as WatchRunTotals).cleanCalls,
    });
  });

  it("leaves a row whose bulk is still running alone, with totals null rather than zero", async () => {
    const row = await readRun(runningRunId);
    expect(row.outcome).toBe("launched");
    expect(row.totals).toBeNull();
  });

  it("leaves a row whose bulk was evicted before settling as launched, so its spend keeps counting", async () => {
    const row = await readRun(orphanRunId);
    expect(row.outcome).toBe("launched");
    expect(row.totals).toBeNull();
  });

  it("does not read a settled row's bulk again on the next pass", async () => {
    const again = await settleLaunchedRuns();
    expect(again.map((s) => s.watchRunId)).not.toContain(settledRunId);
  });

  it("keeps the totals once the bulk is evicted, detached", async () => {
    await db.delete(benchmarkBulksTable).where(eq(benchmarkBulksTable.id, settledBulkId));
    const row = await readRun(settledRunId);
    expect(row.bulkId).toBeNull();
    expect((row.totals as WatchRunTotals[])[0].peerFlags).toBe(2);
    expect((row.totals as WatchRunTotals[])[0].callsScored).toBe(2);
  });
});

describe("W-5e settle production", () => {
  it("settles production's measurement per agent as sums whose ratio is the rate GET /benchmark/bulks/{bulkId}/verdicts reports", async () => {
    const row = await readRun(customerRunId);
    expect(row.outcome).toBe("settled");
    const production = row.production as WatchRunProduction[];
    expect(production).toHaveLength(1);
    const p = production[0]!;
    expect(p.assistantId).toBe(`fx-asst-prod-${fx.suffix}`);
    expect(p.calls).toBe(2);
    expect(p.totalCalls).toBe(2);
    expect(p.comparedWords).toBeGreaterThan(0);
    expect(p.mismatchWords).toBe(0);
    expect(p.leaderProviderId).not.toBeNull();
    expect(p.leaderComparedWords).toBeGreaterThan(0);

    const res = await request(server).get(`/api/benchmark/bulks/${customerBulkId}/verdicts`);
    expect(res.status).toBe(200);
    const group = res.body.groups.find((g: { assistantIds: string[] }) => g.assistantIds.includes(p.assistantId as string));
    expect(group).toBeDefined();
    expect(group.productionDisagreement).not.toBeNull();
    expect(group.productionDisagreement.rate).toBe(p.mismatchWords / p.comparedWords);
    expect(group.productionDisagreement.leaderProviderId).toBe(p.leaderProviderId);
    expect(group.productionDisagreement.leaderRate).toBe(p.leaderMismatchWords / p.leaderComparedWords);
    expect(group.productionDisagreement.calls).toBe(p.calls);
  });

  it("settles [] on a mono bulk, never a zero rate", async () => {
    const row = await readRun(settledRunId);
    expect(row.outcome).toBe("settled");
    expect(row.production).toEqual([]);
  });

  it("leaves production null on a row whose bulk is still running", async () => {
    const row = await readRun(runningRunId);
    expect(row.production).toBeNull();
  });
});

