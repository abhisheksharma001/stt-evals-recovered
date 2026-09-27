// R-55: a provider that succeeds with an empty transcript ("heard nothing")
// gets a score row -- every reference word a deletion -- instead of an `ok`
// cell with no score, which no ranking reads and no retry revisits.
//
// SAFETY: this suite calls executeBenchmarkRun, the function that spends
// provider money. What keeps it free:
//   1. The only provider is a Fixtures provider (`fx-<suffix>-N`), and the
//      only adapter it resolves to is the stub registered below -- the same
//      way src/rehearsal-scale.ts stubs adapters. No vendor is ever called.
//   2. audioResolver is overridden, so no recording is fetched.
//   3. The call is a public (`pipecat`) clip, which the automatic judge pass
//      never sends to OpenAI (W-12a1); and the judge is stubbed to throw
//      anyway, so a regression there fails this test instead of spending.
// Never put a real provider id in this file.
import { afterAll, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import { benchmarkProviderCallResultsTable, benchmarkScoresTable, db, pool } from "@workspace/db";
import { providerRegistry } from "@workspace/stt-providers";
import { executeBenchmarkRun } from "../../lib/run-executor";
import { Fixtures } from "./fixtures";

const judge = vi.hoisted(() =>
  vi.fn(async () => {
    throw new Error("R-55 test: the judge must never be reached");
  }),
);
vi.mock("../../lib/agent", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../lib/agent")>()),
  judgeCandidates: judge,
}));

const fx = new Fixtures();
const stubbed: string[] = [];
const audioResolver = async (): Promise<Buffer> => Buffer.alloc(64);

afterAll(async () => {
  for (const id of stubbed) delete providerRegistry[id];
  await fx.cleanup();
  await pool.end();
});

describe("executeBenchmarkRun and an empty transcript (R-55)", () => {
  it("scores an ok cell that heard nothing as all deletions", async () => {
    const provider = await fx.provider();
    stubbed.push(provider.id);
    providerRegistry[provider.id] = {
      providerId: provider.id,
      apiKeyEnvVar: "R55_UNUSED_KEY",
      async transcribe() {
        const now = new Date().toISOString();
        return {
          status: "ok",
          submittedAt: now,
          finalAt: now,
          firstPartialAt: null,
          httpStatus: 200,
          hypothesisTranscript: "",
          rawOutput: { text: "" },
          errorMessage: null,
          diarizationScore: null,
        };
      },
    };
    const call = await fx.call({
      sourceProvider: "pipecat",
      sourceCallId: `fx-r55-${fx.suffix}`,
      goldTranscript: "hello",
      audioObjectPath: `hf://datasets/fx/${fx.suffix}`,
      durationSeconds: 1,
    });
    const run = await fx.run({ status: "queued", providerIds: [provider.id], callIds: [call.id], callCount: 1 });

    await executeBenchmarkRun(run.id, fx.actor, { audioResolver });

    const [cell] = await db
      .select()
      .from(benchmarkProviderCallResultsTable)
      .where(eq(benchmarkProviderCallResultsTable.runId, run.id));
    expect(cell?.status).toBe("ok");
    expect(cell?.hypothesisTranscript).toBe("");
    const scores = await db.select().from(benchmarkScoresTable).where(eq(benchmarkScoresTable.resultId, cell!.id));
    expect(scores).toHaveLength(1);
    expect(scores[0]?.wer).toBe(1);
    expect(judge).not.toHaveBeenCalled();
  });
});
