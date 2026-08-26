/**
 * End-to-end verification of the bulk machinery (PRD v2 FR-BLK-1..11):
 * sharding, async bulk job states, retry-failed, cancel, manifests, reusable
 * templates, cost gate, and the 3-bulk eviction cap -- against a REAL Postgres
 * and the REAL Express routes + run executor, with controllable stub provider
 * adapters registered in-process (same pattern as rehearsal-scale.ts) so no
 * real vendor keys or spend are involved. A tiny mock Vapi server satisfies
 * resolveFreshRecordingUrl() via the VAPI_BASE_URL seam.
 *
 *   DATABASE_URL=postgres://... pnpm --filter @workspace/api-server e2e:bulks
 */

// --- Env knobs must be set BEFORE any module that reads them is imported.
process.env.RUN_CONCURRENCY = "4";
process.env.PROVIDER_CONCURRENCY = "2";
process.env.CELL_MAX_ATTEMPTS = "3";
process.env.BULK_COST_THRESHOLD_CENTS = "100"; // $1 -- gates only the big bulk
process.env.E2E_STUB_KEY = "test-key";
process.env.VAPI_API_KEY_E2E = "dummy";
const MOCK_VAPI_PORT = 18999;
process.env.VAPI_BASE_URL = `http://127.0.0.1:${MOCK_VAPI_PORT}`;

import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";

const failures: string[] = [];
function check(name: string, condition: boolean, detail?: unknown): void {
  if (condition) {
    console.log(`  ok  ${name}`);
  } else {
    failures.push(name);
    console.error(`  FAIL ${name}${detail !== undefined ? ` :: ${JSON.stringify(detail)}` : ""}`);
  }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// --- Mock Vapi: any GET returns a call with a (never actually fetched)
// recording URL. Stub adapters never download audio.
const mockVapi: Server = createServer((req, res) => {
  res.setHeader("content-type", "application/json");
  res.end(
    JSON.stringify({
      id: "mock",
      recordingUrl: "http://127.0.0.1:1/fake.wav",
      artifact: {},
    }),
  );
});
await new Promise<void>((resolve) => mockVapi.listen(MOCK_VAPI_PORT, resolve));

// --- Dynamic imports: only after env is in place.
const { default: app } = await import("./app");
const {
  db,
  pool,
  benchmarkCallsTable,
  benchmarkProvidersTable,
  benchmarkBulksTable,
  benchmarkRunsTable,
  benchmarkProviderCallResultsTable,
} = await import("@workspace/db");
const { providerRegistry } = await import("@workspace/stt-providers");
const { eq, inArray } = await import("drizzle-orm");

// --- Stub providers ----------------------------------------------------------
const GOLD = "the quick brown fox";
const okResult = (latencyMs: number) => ({
  status: "ok" as const,
  submittedAt: new Date().toISOString(),
  finalAt: new Date(Date.now() + latencyMs).toISOString(),
  httpStatus: 200,
  hypothesisTranscript: GOLD,
  rawOutput: { stub: true },
  errorMessage: null,
  diarizationScore: null,
});

const flakyAttempts = new Map<string, number>();
let downProviderHealed = false;
const downAttempts = new Map<string, number>();

providerRegistry["e2e-ok"] = {
  providerId: "e2e-ok",
  apiKeyEnvVar: "E2E_STUB_KEY",
  async transcribe() {
    await sleep(50);
    return { ...okResult(50), firstPartialAt: null };
  },
};
providerRegistry["e2e-flaky"] = {
  providerId: "e2e-flaky",
  apiKeyEnvVar: "E2E_STUB_KEY",
  async transcribe({ callId }) {
    await sleep(20);
    const attempt = (flakyAttempts.get(callId) ?? 0) + 1;
    flakyAttempts.set(callId, attempt);
    if (attempt === 1) {
      return {
        status: "failed" as const,
        submittedAt: new Date().toISOString(),
        finalAt: new Date().toISOString(),
        httpStatus: 429,
        hypothesisTranscript: null,
        rawOutput: null,
        errorMessage: "rate limited (simulated)",
        diarizationScore: null,
        firstPartialAt: null,
      };
    }
    return { ...okResult(20), firstPartialAt: null };
  },
};
providerRegistry["e2e-down"] = {
  providerId: "e2e-down",
  apiKeyEnvVar: "E2E_STUB_KEY",
  async transcribe({ callId }) {
    await sleep(20);
    downAttempts.set(callId, (downAttempts.get(callId) ?? 0) + 1);
    if (downProviderHealed) return { ...okResult(20), firstPartialAt: null };
    return {
      status: "failed" as const,
      submittedAt: new Date().toISOString(),
      finalAt: new Date().toISOString(),
      httpStatus: 429,
      hypothesisTranscript: null,
      rawOutput: null,
      errorMessage: "provider down (simulated)",
      diarizationScore: null,
      firstPartialAt: null,
    };
  },
};
providerRegistry["e2e-slow"] = {
  providerId: "e2e-slow",
  apiKeyEnvVar: "E2E_STUB_KEY",
  async transcribe() {
    await sleep(2500);
    return { ...okResult(2500), firstPartialAt: null };
  },
};

// --- Seed ---------------------------------------------------------------------
const PREFIX = `e2e-${Date.now()}`;
const providerIds = ["e2e-ok", "e2e-flaky", "e2e-down", "e2e-slow"];
for (const id of providerIds) {
  await db
    .insert(benchmarkProvidersTable)
    .values({ id, name: id, model: "stub", status: "ready", costPerMinute: 0.01 })
    .onConflictDoNothing();
}

type SeedSpec = {
  key: string;
  status: string;
  ageHours: number;
  durationSeconds: number;
  vertical?: string;
};
const seedSpecs: SeedSpec[] = [
  { key: "c1", status: "ready_to_run", ageHours: 1, durationSeconds: 120 },
  { key: "c2", status: "ready_to_run", ageHours: 2, durationSeconds: 120 },
  { key: "c3", status: "ready_to_run", ageHours: 3, durationSeconds: 120 },
  { key: "c4", status: "ready_to_run", ageHours: 4, durationSeconds: 120 },
  { key: "c5", status: "ready_to_run", ageHours: 5, durationSeconds: 120 },
  { key: "c6", status: "needs_review", ageHours: 6, durationSeconds: 120 },
  { key: "c7", status: "needs_review", ageHours: 7, durationSeconds: 120 },
  { key: "c8", status: "ready_to_run", ageHours: 24 * 10, durationSeconds: 120 }, // 10d old
  { key: "c9", status: "ready_to_run", ageHours: 2, durationSeconds: 3600, vertical: "trucking" },
];
const callIds: Record<string, string> = {};
for (const spec of seedSpecs) {
  const fakeVapiId = crypto.randomUUID();
  const [row] = await db
    .insert(benchmarkCallsTable)
    .values({
      label: `${PREFIX}-${spec.key}`,
      vertical: spec.vertical ?? "rush",
      durationSeconds: spec.durationSeconds,
      status: spec.status,
      goldTranscript: spec.status === "ready_to_run" ? GOLD : null,
      audioObjectPath: `https://fake.invalid/${fakeVapiId}.wav`,
      sourceProvider: "vapi",
      sourceCallId: fakeVapiId,
      sourceAccountLabel: "E2e",
      sourceStartedAt: new Date(Date.now() - spec.ageHours * 3600_000),
    })
    .returning();
  callIds[spec.key] = row.id;
}
console.log(`seeded: 4 stub providers, ${seedSpecs.length} calls (${PREFIX}-*)`);

// --- Server -------------------------------------------------------------------
const server = createServer(app);
await new Promise<void>((resolve) => server.listen(0, resolve));
const PORT = (server.address() as AddressInfo).port;
const BASE = `http://127.0.0.1:${PORT}/api`;

async function api(
  method: string,
  path: string,
  body?: unknown,
): Promise<{ status: number; json: any }> {
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers: { "content-type": "application/json", "x-actor": "e2e" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  let json: any = null;
  try {
    json = JSON.parse(text);
  } catch {
    json = text;
  }
  return { status: res.status, json };
}

async function waitForBulk(
  id: string,
  terminal: string[],
  timeoutMs = 30_000,
): Promise<any> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const { json } = await api("GET", `/benchmark/bulks/${id}`);
    if (terminal.includes(json.status)) return json;
    if (Date.now() > deadline) {
      throw new Error(`bulk ${id} still ${json.status} after ${timeoutMs}ms`);
    }
    await sleep(250);
  }
}

// === 1. Sharding + async states + skipped_pending_review =======================
console.log("\n[1] bulk create -> shards -> skipped/ok cells");
const createA = await api("POST", "/benchmark/bulks", {
  criteria: { vertical: "rush" },
  providerIds: ["e2e-ok", "e2e-flaky"],
  shardSize: 3,
});
check("create returns 201", createA.status === 201, createA);
const bulkA = createA.json;
check("auto-launched (under cost gate)", bulkA.status === "running", bulkA.status);
check(
  "frozen criteria pins 8 rush calls",
  bulkA.selectionCriteria.resolvedCallIds?.length === 8,
  bulkA.selectionCriteria,
);

const doneA = await waitForBulk(bulkA.id, ["complete", "partial", "failed"]);
check("bulk A completes (flaky retried itself well)", doneA.status === "complete", doneA.status);
check("3 shard runs for 8 calls @ shardSize 3", doneA.runs.length === 3, doneA.runs.length);
check("cellsTotal = 8 calls x 2 providers", doneA.progress.cellsTotal === 16, doneA.progress);
check(
  "12 ok cells (6 ready calls x 2 providers)",
  doneA.progress.cellsOk === 12,
  doneA.progress,
);
check(
  "4 skipped_pending_review (2 unreviewed calls x 2 providers)",
  doneA.progress.cellsSkippedPendingReview === 4,
  doneA.progress,
);
check("0 failed cells (429 retried in-cell)", doneA.progress.cellsFailed === 0, doneA.progress);

const runsList = await api("GET", "/benchmark/runs");
const shardRow = runsList.json.find((r: any) => r.bulkId === bulkA.id);
check("runs list carries bulk name on shard runs (FR-BLK-13)", shardRow?.bulkName === bulkA.name, shardRow);

// === 2. Manifests ==============================================================
console.log("\n[2] manifests");
const manA = await api("GET", `/benchmark/bulks/${bulkA.id}/manifest`);
check("bulk manifest 200", manA.status === 200, manA);
check(
  "bulk manifest composes 3 shard manifests",
  manA.json?.runs?.length === 3 &&
    manA.json.runs.every((r: any) => r.calls?.length > 0 && r.providers?.length === 2),
);
const firstRunManifest = await api(
  "GET",
  `/benchmark/runs/${manA.json.runs[0].runId}/manifest`,
);
check(
  "run manifest pins gold hashes + scoring version",
  firstRunManifest.status === 200 &&
    firstRunManifest.json.calls.every((c: any) => typeof c.goldTranscriptSha256 === "string" || c.goldTranscriptSha256 === null) &&
    typeof firstRunManifest.json.scoringVersion === "string",
  firstRunManifest.json,
);

// === 3. Cancel =================================================================
console.log("\n[3] cancel stops un-started cells");
const createB = await api("POST", "/benchmark/bulks", {
  name: `${PREFIX}-cancel`,
  criteria: { callIds: [callIds.c1, callIds.c2, callIds.c3, callIds.c4, callIds.c5] },
  providerIds: ["e2e-slow"],
  shardSize: 50,
});
check("cancel-test bulk created", createB.status === 201, createB);
// Cancel deterministically mid-flight: with PROVIDER_CONCURRENCY=2 and 2.5s
// cells, wait until the first batch has landed (cellsOk >= 1) -- the second
// batch is then provably in flight and the rest provably un-started.
for (let i = 0; i < 60; i++) {
  const probe = await api("GET", `/benchmark/bulks/${createB.json.id}`);
  if (probe.json?.progress?.cellsOk >= 1) break;
  await sleep(100);
}
const cancelB = await api("POST", `/benchmark/bulks/${createB.json.id}/cancel`);
check("cancel returns 200 cancelled", cancelB.status === 200 && cancelB.json.status === "cancelled", cancelB);
await sleep(4000); // let in-flight cells finish
const detailB = await api("GET", `/benchmark/bulks/${createB.json.id}`);
check("bulk stays cancelled after in-flight cells land", detailB.json.status === "cancelled", detailB.json.status);
check(
  "some cells cancelled before starting, some in-flight completed",
  detailB.json.progress.cellsCancelled >= 1 && detailB.json.progress.cellsOk >= 1,
  detailB.json.progress,
);
const cancelAgain = await api("POST", `/benchmark/bulks/${createB.json.id}/cancel`);
check("re-cancel is a 409", cancelAgain.status === 409, cancelAgain);

// === 4. Retry-failed ===========================================================
console.log("\n[4] retry-failed re-bills only failed cells");
const createC = await api("POST", "/benchmark/bulks", {
  name: `${PREFIX}-retry`,
  criteria: { callIds: [callIds.c1, callIds.c2] },
  providerIds: ["e2e-down"],
  shardSize: 50,
});
const doneC = await waitForBulk(createC.json.id, ["failed", "partial", "complete"]);
check("down provider -> bulk failed (no ok cells)", doneC.status === "failed", doneC.status);
check("2 failed cells", doneC.progress.cellsFailed === 2, doneC.progress);
check(
  "each failed cell attempted 3x (CELL_MAX_ATTEMPTS)",
  [callIds.c1, callIds.c2].every((id) => downAttempts.get(id) === 3),
  Object.fromEntries(downAttempts),
);
downProviderHealed = true;
const retryC = await api("POST", `/benchmark/bulks/${createC.json.id}/retry-failed`);
check("retry-failed accepted", retryC.status === 202 && retryC.json.status === "running", retryC);
const doneC2 = await waitForBulk(createC.json.id, ["complete", "partial", "failed"]);
check("bulk completes after heal + retry", doneC2.status === "complete", doneC2.status);
check("cells now ok", doneC2.progress.cellsOk === 2 && doneC2.progress.cellsFailed === 0, doneC2.progress);

// === 5. Cost gate ==============================================================
console.log("\n[5] cost gate parks big bulks");
const createD = await api("POST", "/benchmark/bulks", {
  name: `${PREFIX}-gate`,
  criteria: { vertical: "trucking" },
  providerIds: ["e2e-ok", "e2e-flaky"],
});
check(
  "over-threshold bulk parks at awaiting_confirmation",
  createD.status === 201 && createD.json.status === "awaiting_confirmation",
  createD.json,
);
const gateDetail = await api("GET", `/benchmark/bulks/${createD.json.id}`);
check("no runs while gated", gateDetail.json.runs.length === 0, gateDetail.json.runs);
const launchD = await api("POST", `/benchmark/bulks/${createD.json.id}/launch`);
check("explicit launch ungates", launchD.status === 202, launchD);
const doneD = await waitForBulk(createD.json.id, ["complete", "partial", "failed"]);
check("gated bulk completes after launch", doneD.status === "complete", doneD.status);

// === 6. Templates (FR-BLK-9, AC-2.7) ===========================================
console.log("\n[6] reusable templates re-resolve rolling windows");
const createT = await api("POST", "/benchmark/bulk-templates", {
  name: `${PREFIX}-weekly`,
  criteria: { lastNDays: 7, vertical: "rush" },
  providerIds: ["e2e-ok"],
});
check("template created", createT.status === 201, createT.status);
const launchT = await api("POST", `/benchmark/bulk-templates/${createT.json.id}/launch`, {});
check("template launch -> 201 bulk", launchT.status === 201, launchT);
check(
  "rolling window froze to concrete dates, 10-day-old call excluded",
  launchT.json.selectionCriteria.lastNDays === undefined &&
    typeof launchT.json.selectionCriteria.startedAtFrom === "string" &&
    launchT.json.selectionCriteria.resolvedCallIds?.length === 7 &&
    !launchT.json.selectionCriteria.resolvedCallIds.includes(callIds.c8),
  launchT.json.selectionCriteria,
);
const launchT2 = await api("POST", `/benchmark/bulk-templates/${createT.json.id}/launch`, {});
check(
  "second same-day launch gets a distinct auto name",
  launchT2.status === 201 && launchT2.json.name !== launchT.json.name,
  { status: launchT2.status, body: launchT2.json },
);
await waitForBulk(launchT.json.id, ["complete", "partial", "failed"]);
await waitForBulk(launchT2.json.id, ["complete", "partial", "failed"]);

// === 7. Eviction cap (FR-BLK-10) ===============================================
console.log("\n[7] max 3 live bulks, oldest evicted with its runs");
const listBulks = await api("GET", "/benchmark/bulks");
const e2eBulks = listBulks.json.filter(
  (b: any) => b.name.includes(PREFIX) || b.id === bulkA.id,
);
check("exactly 3 live bulks after 7 creates", e2eBulks.length === 3, e2eBulks.map((b: any) => b.name));
const evictedManifest = await api("GET", `/benchmark/bulks/${bulkA.id}/manifest`);
check("evicted bulk A is gone (404)", evictedManifest.status === 404, evictedManifest);
const orphanedRuns = await db
  .select({ id: benchmarkRunsTable.id })
  .from(benchmarkRunsTable)
  .where(eq(benchmarkRunsTable.bulkId, bulkA.id));
check("evicted bulk's runs cascade-deleted", orphanedRuns.length === 0, orphanedRuns);
const corpusIntact = await db
  .select({ id: benchmarkCallsTable.id })
  .from(benchmarkCallsTable)
  .where(inArray(benchmarkCallsTable.id, Object.values(callIds)));
check("corpus calls never touched by eviction", corpusIntact.length === seedSpecs.length, corpusIntact.length);

// === 8. Audit trail ============================================================
console.log("\n[8] audit log");
const audit = await api("GET", "/benchmark/audit-log?entityType=bulk");
const actions = new Set(audit.json.map((row: any) => row.action));
check(
  "bulk create/launch/cancel/retry_failed all audited",
  ["create", "launch", "cancel", "retry_failed"].every((a) => actions.has(a)),
  [...actions],
);

// --- Teardown ------------------------------------------------------------------
await new Promise<void>((resolve) => server.close(() => resolve()));
await new Promise<void>((resolve) => mockVapi.close(() => resolve()));
await pool.end();

console.log(failures.length === 0 ? "\nE2E PASS" : `\nE2E ${failures.length} assertion(s) FAILED`);
process.exit(failures.length === 0 ? 0 : 1);
