// W-12a3: a public calibration clip reaches the provider.
//
// The W-12 launch failed all 7,000 cells of bulk "Public: Pipecat 1k" with
// "Call has no audioObjectPath to send to a provider." -- the importer wrote
// each clip into the disk cache but left `audio_object_path` empty, and the
// executor refuses an empty path before it ever reads the cache. The importer
// now writes a marker (`hf://datasets/<dataset>/<sample id>`) that is never
// fetched; this proves the marker plus the cached file is enough for the
// real executor to hand the bytes to a provider.
//
// The provider is a stub registered into the real registry under the
// fixture's own id -- nothing here calls a vendor or spends anything. The
// cache files are written under the fixture's call ids and deleted again;
// the rescued corpus lives in the same directory and is irreplaceable.
import { promises as fs } from "node:fs";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { benchmarkProviderCallResultsTable, db, pool } from "@workspace/db";
import { providerRegistry } from "@workspace/stt-providers";
import { ensureAudioCacheDir } from "../../lib/audio-cache";
import { executeBenchmarkRun } from "../../lib/run-executor";
import { Fixtures } from "./fixtures";

const fx = new Fixtures();
const CACHE_DIR = path.join(process.cwd(), "audio-cache");
const written: string[] = [];
const stubbed: string[] = [];
const AUDIO = Buffer.from("RIFF-public-clip");

/** Same two files the importer writes (scripts/src/import-public-set.ts). */
async function writeClip(callId: string): Promise<void> {
  await ensureAudioCacheDir();
  for (const name of [`${callId}.audio`, `${callId}.customer.audio`]) {
    const file = path.join(CACHE_DIR, name);
    await fs.writeFile(file, AUDIO);
    written.push(file);
  }
}

/** Records the bytes each call's cell was handed. */
const received = new Map<string, Buffer>();
function stubProvider(providerId: string): void {
  providerRegistry[providerId] = {
    providerId,
    apiKeyEnvVar: "W12A3_STUB_UNUSED",
    async transcribe({ callId, audioBytes }) {
      received.set(callId, audioBytes);
      const now = new Date().toISOString();
      return {
        status: "ok" as const,
        submittedAt: now,
        finalAt: now,
        httpStatus: 200,
        hypothesisTranscript: "hello there",
        rawOutput: { stub: true },
        errorMessage: null,
        diarizationScore: null,
        firstPartialAt: null,
      };
    },
  };
  stubbed.push(providerId);
}

afterAll(async () => {
  for (const id of stubbed) delete providerRegistry[id];
  await Promise.all(written.map((f) => fs.rm(f, { force: true })));
  await fx.cleanup();
  await pool.end();
});

async function cellsOf(runId: string) {
  return db
    .select({
      callId: benchmarkProviderCallResultsTable.callId,
      status: benchmarkProviderCallResultsTable.status,
      errorMessage: benchmarkProviderCallResultsTable.errorMessage,
    })
    .from(benchmarkProviderCallResultsTable)
    .where(eq(benchmarkProviderCallResultsTable.runId, runId));
}

describe("W-12a3 public clip audio", () => {
  it("runs a pipecat call whose path is the hf:// marker and whose audio is only in the cache", async () => {
    const provider = await fx.provider();
    stubProvider(provider.id);
    const sampleId = `fx-sample-${fx.suffix}`;
    const call = await fx.call({
      sourceProvider: "pipecat",
      sourceCallId: sampleId,
      audioObjectPath: `hf://datasets/pipecat-ai/stt-benchmark-data/${sampleId}`,
      goldTranscript: "hello there",
    });
    await writeClip(call.id);
    const run = await fx.run({ status: "queued", providerIds: [provider.id], callIds: [call.id], callCount: 1 });

    await executeBenchmarkRun(run.id, fx.actor);

    expect(await cellsOf(run.id)).toEqual([{ callId: call.id, status: "ok", errorMessage: null }]);
    // The bytes came from the cache the import wrote -- the marker was never fetched.
    expect(received.get(call.id)).toEqual(AUDIO);
  });

  it("still refuses a pipecat call with no path, even with its audio cached (the launch failure)", async () => {
    const provider = await fx.provider();
    stubProvider(provider.id);
    const call = await fx.call({ sourceProvider: "pipecat", sourceCallId: `fx-nopath-${fx.suffix}` });
    await writeClip(call.id);
    const run = await fx.run({ status: "queued", providerIds: [provider.id], callIds: [call.id], callCount: 1 });

    await executeBenchmarkRun(run.id, fx.actor);

    expect(await cellsOf(run.id)).toEqual([
      { callId: call.id, status: "failed", errorMessage: "Call has no audioObjectPath to send to a provider." },
    ]);
    expect(received.has(call.id)).toBe(false);
  });
});
