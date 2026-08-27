/**
 * UI-test API server: the real Express app + real Postgres, but with
 * in-process stub STT providers and a mock Vapi endpoint (VAPI_BASE_URL
 * seam) so clicking through the Bulks UI exercises the entire bulk machinery
 * without real vendor keys or spend. Same pattern as e2e-bulks.ts /
 * rehearsal-scale.ts.
 *
 *   DATABASE_URL=postgres://... PORT=5050 pnpm --filter @workspace/api-server e2e:ui-server
 */

process.env.RUN_CONCURRENCY = "4";
process.env.PROVIDER_CONCURRENCY = "2";
process.env.E2E_STUB_KEY = "test-key";
process.env.VAPI_API_KEY_E2E = "dummy";
const MOCK_VAPI_PORT = 18998;
process.env.VAPI_BASE_URL = `http://127.0.0.1:${MOCK_VAPI_PORT}`;

import { createServer } from "node:http";

const GOLD = "the quick brown fox jumps over the lazy dog";

// Mock Vapi: any GET returns a call carrying a recording URL (stub adapters
// never actually download it).
const mockVapi = createServer((req, res) => {
  res.setHeader("content-type", "application/json");
  res.end(JSON.stringify({ id: "mock", recordingUrl: "http://127.0.0.1:1/fake.wav", artifact: {} }));
});
await new Promise<void>((resolve) => mockVapi.listen(MOCK_VAPI_PORT, resolve));

const { default: app } = await import("./app");
const { recoverInterruptedRuns } = await import("./lib/run-executor");
const { db, benchmarkCallsTable, benchmarkProvidersTable } = await import("@workspace/db");
const { providerRegistry } = await import("@workspace/stt-providers");
const { like } = await import("drizzle-orm");

// e2e-flaky fails each cell's first attempt with a 429 (the executor's
// in-cell backoff turns it ok); e2e-slow takes 2.5s per cell so a running
// bulk stays cancellable long enough to click Cancel in the UI.
providerRegistry["e2e-ok"] = {
  providerId: "e2e-ok",
  apiKeyEnvVar: "E2E_STUB_KEY",
  async transcribe() {
    await new Promise((r) => setTimeout(r, 120));
    return {
      status: "ok" as const,
      submittedAt: new Date().toISOString(),
      finalAt: new Date(Date.now() + 120).toISOString(),
      firstPartialAt: null,
      httpStatus: 200,
      hypothesisTranscript: GOLD,
      rawOutput: { stub: true },
      errorMessage: null,
      diarizationScore: null,
    };
  },
};
const flakyAttempts = new Map<string, number>();
providerRegistry["e2e-flaky"] = {
  providerId: "e2e-flaky",
  apiKeyEnvVar: "E2E_STUB_KEY",
  async transcribe({ callId }) {
    await new Promise((r) => setTimeout(r, 60));
    const attempt = (flakyAttempts.get(callId) ?? 0) + 1;
    flakyAttempts.set(callId, attempt);
    if (attempt === 1) {
      return {
        status: "failed" as const,
        submittedAt: new Date().toISOString(),
        finalAt: new Date().toISOString(),
        firstPartialAt: null,
        httpStatus: 429,
        hypothesisTranscript: null,
        rawOutput: null,
        errorMessage: "rate limited (simulated)",
        diarizationScore: null,
      };
    }
    return providerRegistry["e2e-ok"].transcribe({ callId, audioBytes: Buffer.alloc(0), diarize: false });
  },
};
providerRegistry["e2e-slow"] = {
  providerId: "e2e-slow",
  apiKeyEnvVar: "E2E_STUB_KEY",
  async transcribe() {
    await new Promise((r) => setTimeout(r, 2500));
    return {
      status: "ok" as const,
      submittedAt: new Date().toISOString(),
      finalAt: new Date(Date.now() + 2500).toISOString(),
      firstPartialAt: null,
      httpStatus: 200,
      hypothesisTranscript: GOLD,
      rawOutput: { stub: true },
      errorMessage: null,
      diarizationScore: null,
    };
  },
};

// --- Seed (idempotent per database) ------------------------------------------
for (const id of ["e2e-ok", "e2e-flaky", "e2e-slow"]) {
  await db
    .insert(benchmarkProvidersTable)
    .values({ id, name: `Stub ${id}`, model: "stub", status: "ready", costPerMinute: 0.01 })
    .onConflictDoNothing();
}

const existing = await db
  .select({ id: benchmarkCallsTable.id })
  .from(benchmarkCallsTable)
  .where(like(benchmarkCallsTable.label, "ui-e2e-%"));
if (existing.length === 0) {
  for (let i = 0; i < 8; i++) {
    const fakeVapiId = crypto.randomUUID();
    const ready = i < 6;
    await db.insert(benchmarkCallsTable).values({
      label: `ui-e2e-${i}`,
      vertical: i === 7 ? "trucking" : "rush",
      durationSeconds: 120,
      status: ready ? "ready_to_run" : "needs_review",
      goldTranscript: ready ? GOLD : null,
      audioObjectPath: `https://fake.invalid/${fakeVapiId}.wav`,
      sourceProvider: "vapi",
      sourceCallId: fakeVapiId,
      sourceAccountLabel: "E2e",
      sourceStartedAt: new Date(Date.now() - (i + 1) * 3600_000),
    });
  }
  console.log("[e2e-ui] seeded 8 calls (6 ready_to_run, 2 needs_review)");
}

const port = Number(process.env.PORT ?? 5050);
app.listen(port, () => {
  console.log(`[e2e-ui] stub API listening on :${port}`);
});
void recoverInterruptedRuns().catch(() => {});
