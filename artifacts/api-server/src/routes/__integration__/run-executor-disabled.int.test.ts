// R-13 (ox-alpha B-34, found 2026-08-25): a provider switched off in Setup
// is never transcribed to, whichever door the run came through. The gate
// this pins lives in executeBenchmarkRun itself, because that is the one
// place every door leads to: POST /benchmark/runs, POST
// /runs/:runId/execute, launchBulk's shard runs, and retryBulkFailedCells.
//
// SAFETY, read before editing. This is the only suite in the repo that calls
// executeBenchmarkRun -- the function that spends provider money -- so what
// keeps it free is written down here instead of assumed:
//
//   1. Every provider here is a Fixtures provider, whose id (`fx-<suffix>-N`)
//      matches no adapter in the registry, so getProviderAdapter returns
//      undefined and adapter.transcribe() is unreachable. That holds whether
//      or not the gate under test is present -- which is what makes it safe
//      to BREAK the gate and re-run, the point of a break test.
//   2. audioResolver is overridden, so no Vapi recording URL is resolved and
//      no audio is fetched or written to the cache.
//   3. No cell can reach status "ok", and runAutoAgentVerificationForRun
//      selects only this run's "ok" cells -- so the OpenAI judge is not
//      reached either, again with or without the gate.
//
// Never put a real provider id in this file, disabled or not.
import { afterAll, describe, expect, it } from "vitest";
import request from "supertest";
import { server } from "./server";
import { eq } from "drizzle-orm";
import {
  benchmarkProviderCallResultsTable,
  benchmarkRunsTable,
  db,
  pool,
} from "@workspace/db";
import { executeBenchmarkRun } from "../../lib/run-executor";
import { Fixtures } from "./fixtures";

const fx = new Fixtures();

/** Bytes the executor never gets to use -- see safety note 2 above. */
const audioResolver = async (): Promise<Buffer> => Buffer.alloc(64);

async function cellsOf(runId: string) {
  return db
    .select()
    .from(benchmarkProviderCallResultsTable)
    .where(eq(benchmarkProviderCallResultsTable.runId, runId));
}

async function runRow(runId: string) {
  const [row] = await db
    .select()
    .from(benchmarkRunsTable)
    .where(eq(benchmarkRunsTable.id, runId));
  return row;
}

afterAll(async () => {
  await fx.cleanup();
  await pool.end();
});

describe("executeBenchmarkRun and a manually disabled provider (R-13)", () => {
  it("records the refused cell and never reaches the adapter", async () => {
    const call = await fx.call();
    // Deliberately inconsistent, and this is the point of the case: the human
    // switched the row off, and the derived `status` column has not caught up
    // (syncProviderReadiness only runs when a provider route is read). A gate
    // written against `status` instead of `manuallyDisabled` passes every
    // other assertion in this file and lets this row through -- found as a
    // MISS in the break test, which is why the fixture reads this way.
    const provider = await fx.provider({ manuallyDisabled: true, status: "not_configured" });
    const run = await fx.run({
      status: "queued",
      providerIds: [provider.id],
      callIds: [call.id],
      callCount: 1,
    });

    await executeBenchmarkRun(run.id, fx.actor, { audioResolver });

    const cells = await cellsOf(run.id);
    expect(cells).toHaveLength(1);
    expect(cells[0].providerId).toBe(provider.id);
    expect(cells[0].status).toBe("failed");
    expect(cells[0].errorMessage).toContain("switched off in Setup");
    // The distinguishing assertion: without the gate this same cell still
    // fails, but from the missing-adapter branch INSIDE runCell -- which is
    // one step past the point where a provider that does have an adapter
    // would already have been called.
    expect(cells[0].errorMessage).not.toContain("No adapter registered");
    // Nothing was sent, so there is no submission timestamp to record.
    expect(cells[0].submittedAt).toBeNull();

    const after = await runRow(run.id);
    expect(after.notes).toContain("never sent");
    expect(after.notes).toContain("switched off in Setup");
    // Refusing every cell is not "complete": the run produced no evidence.
    // totalCells counts what the run was ASKED for, so 0 ok never equals it.
    expect(after.status).toBe("failed");
  });

  it("refuses only the disabled provider, leaving the rest of the run alone", async () => {
    const call = await fx.call();
    const off = await fx.provider({ manuallyDisabled: true, status: "disabled" });
    const on = await fx.provider();
    const run = await fx.run({
      status: "queued",
      providerIds: [off.id, on.id],
      callIds: [call.id],
      callCount: 1,
    });

    await executeBenchmarkRun(run.id, fx.actor, { audioResolver });

    const byProvider = new Map((await cellsOf(run.id)).map((c) => [c.providerId, c]));
    expect(byProvider.size).toBe(2);
    expect(byProvider.get(off.id)?.errorMessage).toContain("switched off in Setup");
    // The enabled fixture provider still walks the whole normal path and
    // fails where that path fails for a fixture call -- in the audio pre-pass,
    // which is BELOW the refusal above (a fixture call has no
    // audioObjectPath). Proves the filter removed one provider rather than
    // short-circuiting the run, and shows the refusal is not being applied to
    // rows that did not ask for it.
    expect(byProvider.get(on.id)?.errorMessage).toContain("audioObjectPath");
    expect(byProvider.get(on.id)?.errorMessage).not.toContain("switched off in Setup");
  });

  it("leaves a cell that already succeeded alone, and does not count it as refused", async () => {
    const call = await fx.call();
    const provider = await fx.provider({ manuallyDisabled: true, status: "disabled" });
    const run = await fx.run({
      status: "queued",
      providerIds: [provider.id],
      callIds: [call.id],
      callCount: 1,
    });
    // The realistic shape: this provider ran and produced evidence, and was
    // switched off afterwards. Re-executing the run must not rewrite history.
    //
    // R-26: the score row is part of that shape, not decoration. "Already
    // succeeded" means ok AND scored -- an ok row with no score was paid for
    // and never reached a ranking, and the companion test below covers it.
    // This fixture asserted the old, weaker meaning by omission.
    const kept = await fx.result(run.id, call.id, provider.id, {
      status: "ok",
      hypothesisTranscript: `fx kept ${fx.suffix}`,
    });
    await fx.score(kept.id);

    await executeBenchmarkRun(run.id, fx.actor, { audioResolver });

    const cells = await cellsOf(run.id);
    expect(cells).toHaveLength(1);
    expect(cells[0].status).toBe("ok");
    expect(cells[0].hypothesisTranscript).toBe(`fx kept ${fx.suffix}`);
    // And the run must not claim it refused a cell it never had to: dropping
    // the isCellLive check writes nothing (the upsert refuses to replace an
    // "ok" row) but still counts, so the note would name a cell that in fact
    // succeeded. Caught only by this assertion.
    expect(after_notes(await runRow(run.id))).not.toContain("never sent");
  });

  // R-26 (ox-alpha B-6). A hard kill between the result insert and the score
  // insert leaves an "ok" row that owns no score. It was billed and it is in
  // no ranking. Under the old `status === "ok"` condition it was skipped on
  // every retry forever; nothing in the product could reach it again.
  //
  // The provider here is disabled, so the re-attempt costs nothing (R-13) --
  // what is being asserted is that the cell is treated as live at all.
  it("reopens an ok cell that owns no score, instead of skipping it forever", async () => {
    const call = await fx.call();
    const provider = await fx.provider({ manuallyDisabled: true, status: "disabled" });
    const run = await fx.run({
      status: "queued",
      providerIds: [provider.id],
      callIds: [call.id],
      callCount: 1,
    });
    await fx.result(run.id, call.id, provider.id, {
      status: "ok",
      hypothesisTranscript: `fx orphan ${fx.suffix}`,
    });
    // Deliberately no fx.score() -- that is the whole condition.

    await executeBenchmarkRun(run.id, fx.actor, { audioResolver });

    const cells = await cellsOf(run.id);
    expect(cells).toHaveLength(1);
    // Cleared and re-attempted. Leaving the ok row in place would be worse
    // than useless: upsertResult's default setWhere refuses to overwrite an
    // "ok" row, so a live provider would have been paid and its answer
    // dropped on the floor.
    expect(cells[0].status).toBe("failed");
    expect(cells[0].hypothesisTranscript).not.toBe(`fx orphan ${fx.suffix}`);
    expect(cells[0].errorMessage).toContain("switched off in Setup");
  });

  // R-27 (ox-alpha B-7). `pool.connect()` used to sit outside the try, after
  // runningRuns.add(runId). A connect rejection -- pool exhausted, database
  // briefly down -- therefore left the id in the Set for the life of the
  // process: every later execute hit the "already running" branch and did
  // nothing, and only a restart cleared it. A transient failure bricked the
  // run in-process, permanently and silently.
  //
  // Safety note 4, alongside the three at the top of this file: `connect` is
  // overridden only for the failing call, exactly as `audioResolver` is
  // overridden throughout. The second call uses the real pool, and the
  // provider is still a disabled Fixtures provider, so nothing is spent.
  it("does not brick the run when acquiring the lock connection fails", async () => {
    const call = await fx.call();
    const provider = await fx.provider({ manuallyDisabled: true, status: "disabled" });
    const run = await fx.run({
      status: "queued",
      providerIds: [provider.id],
      callIds: [call.id],
      callCount: 1,
    });

    await expect(
      executeBenchmarkRun(run.id, fx.actor, {
        audioResolver,
        connect: () => Promise.reject(new Error("pool exhausted (R-27 probe)")),
      }),
    ).rejects.toThrow(/pool exhausted/);

    // The run must still be executable. Without the fix this call returns
    // early on the runningRuns guard and writes nothing at all.
    await executeBenchmarkRun(run.id, fx.actor, { audioResolver });

    const cells = await cellsOf(run.id);
    expect(cells).toHaveLength(1);
    expect(cells[0].errorMessage).toContain("switched off in Setup");
  });

  // R-44 (ox-alpha B-84). A call archived AFTER the run was created was still
  // transcribed and scored. Archiving is a human withdrawing data from the
  // corpus; paying a vendor to transcribe it afterwards, and letting it into
  // rankings, is the opposite of what that click meant.
  //
  // The provider here is disabled, so this test costs nothing either way --
  // what it pins is that the ARCHIVED call is refused with its own reason,
  // not the provider's.
  it("refuses a call archived after the run was created, and says which reason", async () => {
    const live = await fx.call();
    const withdrawn = await fx.call({ status: "archived" });
    const provider = await fx.provider({ manuallyDisabled: true, status: "disabled" });
    const run = await fx.run({
      status: "queued",
      providerIds: [provider.id],
      callIds: [live.id, withdrawn.id],
      callCount: 2,
    });

    await executeBenchmarkRun(run.id, fx.actor, { audioResolver });

    const cells = await cellsOf(run.id);
    expect(cells).toHaveLength(2);
    const byCall = new Map(cells.map((c) => [c.callId, c]));
    expect(byCall.get(withdrawn.id)?.errorMessage).toContain("archived after this run was created");
    // The live call still gets the provider's reason, not the call's.
    expect(byCall.get(live.id)?.errorMessage).toContain("switched off in Setup");

    const notes = after_notes(await runRow(run.id));
    expect(notes).toContain("archived after this run was created");
  });

  // R-44 (ox-alpha B-97). An id that no longer resolves is dropped by
  // inArray without a word, and the run finalises over a smaller set than it
  // was created for. No cell row can exist for it -- the call is gone and
  // call_id has nothing to point at -- so the notes are the only place it can
  // be said.
  it("says so when a call it names no longer exists, instead of quietly covering less", async () => {
    const live = await fx.call();
    const provider = await fx.provider({ manuallyDisabled: true, status: "disabled" });
    const ghost = "00000000-0000-4000-8000-0000000000ff";
    const run = await fx.run({
      status: "queued",
      providerIds: [provider.id],
      callIds: [live.id, ghost],
      callCount: 2,
    });

    await executeBenchmarkRun(run.id, fx.actor, { audioResolver });

    const notes = after_notes(await runRow(run.id));
    expect(notes).toContain("no longer exist");
    // The claim is the id list, so the denominator must not shrink to hide it.
    const audit = await request(server)
      .get("/api/benchmark/audit-log")
      .query({ entityType: "run", entityId: run.id });
    const after = audit.body[0]?.afterState as { totalCells?: number; missingCallIds?: number };
    expect(after?.totalCells).toBe(2);
    expect(after?.missingCallIds).toBe(1);
  });
});

/** Notes are nullable; `String(null)` would quietly satisfy a `not.toContain`. */
function after_notes(row: { notes: string | null }): string {
  return row.notes ?? "";
}
