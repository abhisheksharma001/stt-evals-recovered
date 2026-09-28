// R-2e: a cell the provider failed counts against it only on the channel its
// bulk ranks, so the failure row has to say which channel it was sent. It
// used to write audio_source null for every failure, which a customer-channel
// bulk reads as "mono" and drops -- the provider's failure would never count.
//
// SAFETY: this suite calls executeBenchmarkRun, the function that spends
// provider money. What keeps it free (same as run-executor-empty-transcript):
//   1. The only provider is a Fixtures provider (`fx-<suffix>-N`), and the
//      only adapter it resolves to is the stub registered below. No vendor is
//      ever called.
//   2. audioResolver is overridden, so no recording is fetched.
//   3. The call is a public (`pipecat`) clip and the judge is stubbed to
//      throw, so a regression there fails this test instead of spending.
// Never put a real provider id in this file.
import { afterAll, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import { benchmarkProviderCallResultsTable, db, pool } from "@workspace/db";
import { ClassifiedError, providerRegistry } from "@workspace/stt-providers";
import { executeBenchmarkRun } from "../../lib/run-executor";
import { Fixtures } from "./fixtures";

// One attempt, so a retryable timeout is recorded without the backoff sleeps.
// Read once when run-executor loads, which is why it is set before imports.
const priorAttempts = vi.hoisted(() => {
  const prior = process.env.CELL_MAX_ATTEMPTS;
  process.env.CELL_MAX_ATTEMPTS = "1";
  return prior;
});

const judge = vi.hoisted(() =>
  vi.fn(async () => {
    throw new Error("R-2e test: the judge must never be reached");
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
  if (priorAttempts === undefined) delete process.env.CELL_MAX_ATTEMPTS;
  else process.env.CELL_MAX_ATTEMPTS = priorAttempts;
  for (const id of stubbed) delete providerRegistry[id];
  await fx.cleanup();
  await pool.end();
});

describe("executeBenchmarkRun and a provider failure (R-2e)", () => {
  it("records the channel the audio was sent on a provider_timeout row", async () => {
    const provider = await fx.provider();
    stubbed.push(provider.id);
    providerRegistry[provider.id] = {
      providerId: provider.id,
      apiKeyEnvVar: "R2E_UNUSED_KEY",
      async transcribe() {
        throw new ClassifiedError("fx: no final transcript inside the deadline", "provider_timeout");
      },
    };
    const call = await fx.call({
      sourceProvider: "pipecat",
      sourceCallId: `fx-r2e-${fx.suffix}`,
      audioObjectPath: `hf://datasets/fx/${fx.suffix}`,
      durationSeconds: 1,
    });
    const run = await fx.run({ status: "queued", providerIds: [provider.id], callIds: [call.id], callCount: 1 });

    await executeBenchmarkRun(run.id, fx.actor, { audioResolver });

    const [cell] = await db
      .select()
      .from(benchmarkProviderCallResultsTable)
      .where(eq(benchmarkProviderCallResultsTable.runId, run.id));
    expect(cell?.status).toBe("failed");
    expect(cell?.failureClass).toBe("provider_timeout");
    expect(cell?.audioSource).toBe("mono");
    expect(judge).not.toHaveBeenCalled();
  });
});
