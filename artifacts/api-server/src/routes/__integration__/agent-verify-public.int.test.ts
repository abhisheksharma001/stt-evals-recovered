// W-12a1: the automatic judge pass never reaches a public calibration clip.
//
// runAutoAgentVerificationForRun is what the executor calls once a run
// completes, and it sends each flagged call to a paid OpenAI judge. The W-12
// launch is 1,000 pipecat clips whose estimate prices the STT providers only,
// so a judge call per clip would be spend nobody approved.
//
// The judge is stubbed with vi.mock -- this file must never make a real OpenAI
// call. The stub picks the first candidate, so a flagged call still writes a
// complete scan row the same way the real judge would.
import { afterAll, describe, expect, it, vi } from "vitest";
import { eq, inArray } from "drizzle-orm";
import { benchmarkAgentScansTable, db, pool } from "@workspace/db";
import { runAutoAgentVerificationForRun } from "../../lib/agent-verify";
import { Fixtures } from "./fixtures";

const judge = vi.hoisted(() =>
  vi.fn(async (params: { candidates: { providerId: string }[] }) => ({
    pickedProviderId: params.candidates[0]?.providerId ?? null,
    reasoning: "stubbed judge",
    confidence: null,
    keyDifferences: [],
    promptTokens: null,
    completionTokens: null,
    costMicrocents: null,
  })),
);
vi.mock("../../lib/agent", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../lib/agent")>()),
  judgeCandidates: judge,
}));

const fx = new Fixtures();

afterAll(async () => {
  await fx.cleanup();
  await pool.end();
});

// Two transcripts that disagree on every number, so the hybrid flags fire and
// the vapi call takes the judge path rather than the "clean" one.
const HEARD_A = "my unit is four one three and the rent is twelve hundred dollars due on the fifth";
const HEARD_B = "my unit is four three one and the rent is eleven hundred dollars due on the ninth";

describe("runAutoAgentVerificationForRun", () => {
  it("judges the vapi call and skips the pipecat call in the same run", async () => {
    const a = await fx.provider();
    const b = await fx.provider();
    const vapi = await fx.call({ sourceProvider: "vapi", sourceCallId: `fx-vapi-${fx.suffix}` });
    const pub = await fx.call({
      sourceProvider: "pipecat",
      sourceCallId: `fx-pipecat-${fx.suffix}`,
      goldTranscript: HEARD_A,
    });
    const run = await fx.run({ providerIds: [a.id, b.id], callIds: [vapi.id, pub.id], callCount: 2 });
    for (const call of [vapi, pub]) {
      await fx.result(run.id, call.id, a.id, { hypothesisTranscript: HEARD_A });
      await fx.result(run.id, call.id, b.id, { hypothesisTranscript: HEARD_B });
    }

    await runAutoAgentVerificationForRun(run.id, fx.actor);

    const scans = await db
      .select({ callId: benchmarkAgentScansTable.callId, status: benchmarkAgentScansTable.status })
      .from(benchmarkAgentScansTable)
      .where(inArray(benchmarkAgentScansTable.callId, [vapi.id, pub.id]));

    // The public call: no scan row, and the judge never saw its transcripts.
    expect(scans.filter((s) => s.callId === pub.id)).toEqual([]);
    // The vapi call: judged exactly once, as before W-12a1.
    expect(scans.filter((s) => s.callId === vapi.id)).toEqual([{ callId: vapi.id, status: "flagged" }]);
    expect(judge).toHaveBeenCalledTimes(1);

    await db.delete(benchmarkAgentScansTable).where(eq(benchmarkAgentScansTable.runId, run.id));
  });
});
