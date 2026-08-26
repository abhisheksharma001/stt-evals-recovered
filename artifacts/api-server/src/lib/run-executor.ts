import { createHash, randomUUID } from "node:crypto";
import { and, eq, inArray } from "drizzle-orm";
import {
  benchmarkBulksTable,
  benchmarkCallsTable,
  benchmarkProviderCallResultsTable,
  benchmarkProvidersTable,
  benchmarkRankingsTable,
  benchmarkRunsTable,
  benchmarkScoresTable,
  db,
  pool,
  type BenchmarkCallRow,
  type BenchmarkProviderRow,
} from "@workspace/db";
import { RANKING_WEIGHTS, compositeScore, score, SCORING_VERSION } from "@workspace/scoring";
import {
  ProviderConfigError,
  getProviderAdapter,
  type ProviderTranscribeResult,
} from "@workspace/stt-providers";
import { logger } from "./logger";
import { writeAudit } from "./audit";
import { refreshBulkStatus } from "./bulk-status";
import { resolveFreshRecordingUrl } from "./vapi";

// In-process re-entrancy guard: found live 2026-08-25 by reproducing the
// documented race (see the comment on the run.status check below) --
// POST /benchmark/runs auto-fires execution, and calling POST .../execute
// right after (before the first pass has written anything) makes both
// invocations load the same empty `existingResults`, so every cell gets
// submitted to its provider TWICE (real double-billing, not just duplicate
// rows). This doesn't replace a durable job queue (Phase 2, still not
// built), but it closes the one-process case for free.
const runningRuns = new Set<string>();

// FR-BLK-7: cooperative cancellation. POST /bulks/:id/cancel registers the
// in-flight shard run here; the cell worker loop checks this set BEFORE
// starting each cell -- cells already inside a provider HTTP call finish and
// are recorded normally, everything not yet started is written as a
// "cancelled" result row instead of being submitted.
const cancelRequestedRuns = new Set<string>();
export function requestRunCancellation(runId: string): void {
  cancelRequestedRuns.add(runId);
}

// ---------------------------------------------------------------------------
// Scale knobs (env-tunable, safe defaults). The serial executor this replaces
// spent wall time ≈ Σ(cells × provider latency); at 500-1000 cells that is
// hours. Vendor rate limits -- not our CPU -- are the real ceiling, hence the
// two-level gate: RUN_CONCURRENCY caps cells in flight overall,
// PROVIDER_CONCURRENCY caps cells in flight per vendor (a 429 storm helps
// nobody's latency ranking). See ox-alpha/scalability-design.md.
function envInt(name: string, fallback: number, max: number): number {
  const raw = process.env[name];
  const parsed = raw ? Number.parseInt(raw, 10) : NaN;
  if (!Number.isFinite(parsed) || parsed <= 0) return fallback;
  // Upper clamp (UX/threshold review 2026-08-25): a typo like
  // PROVIDER_CONCURRENCY=400 would guarantee vendor 429 storms and poison
  // latency rankings. Sane ceilings, applied silently but logged once below.
  const clamped = Math.min(parsed, max);
  if (clamped !== parsed) {
    logger.warn({ name, requested: parsed, applied: clamped }, "concurrency env clamped to ceiling");
  }
  return clamped;
}

const RUN_CONCURRENCY = envInt("RUN_CONCURRENCY", 16, 64);
const PROVIDER_CONCURRENCY = envInt("PROVIDER_CONCURRENCY", 4, 16);
// Attempts per cell = 1 initial + (CELL_MAX_ATTEMPTS - 1) retries.
// Retries apply ONLY to transient outcomes (HTTP 408/429/5xx, network errors,
// Cartesia's explicit "safe to retry" premature close) -- a 401 config error
// is terminal on the first attempt.
const CELL_MAX_ATTEMPTS = envInt("CELL_MAX_ATTEMPTS", 3, 5);

class Semaphore {
  private slots: number;
  private readonly waiters: Array<() => void> = [];
  constructor(slots: number) {
    this.slots = slots;
  }
  async acquire(): Promise<void> {
    if (this.slots > 0) {
      this.slots -= 1;
      return;
    }
    await new Promise<void>((resolve) => this.waiters.push(resolve));
    // Slot ownership was transferred by release(); nothing to decrement.
    // (Found in review 2026-08-25: decrementing here too let a synchronous
    // acquire() steal the freed slot between release()'s increment and this
    // waiter's resume, driving `slots` permanently negative -- the per-
    // provider cap silently eroded under load, which is 429 storms.)
  }
  release(): void {
    const next = this.waiters.shift();
    if (next) {
      next(); // hand the freed slot directly to the waiter
    } else {
      this.slots += 1;
    }
  }
}

// Fixed-size worker pool over a materialized item list: exactly `limit`
// workers pull from a shared cursor until exhausted. No dependencies, no
// unbounded Promise.all blowups. Exported for reuse by the Vapi import
// route's bounded-parallel fetch loop.
export async function drainWithConcurrency<T>(
  items: T[],
  limit: number,
  worker: (item: T) => Promise<void>,
): Promise<void> {
  let cursor = 0;
  const runners = Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, async () => {
    while (cursor < items.length) {
      const item = items[cursor];
      cursor += 1;
      await worker(item);
    }
  });
  await Promise.all(runners);
}

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

// Exponential backoff with full jitter, capped at 30 s: 500ms -> ~1s -> ~2s...
const backoffMs = (attempt: number) =>
  Math.min(30_000, 500 * 2 ** attempt) * (0.5 + Math.random());

const RETRYABLE_HTTP_STATUSES = new Set([408, 429]);

function isRetryableOutcome(
  httpStatus: number | null | undefined,
  errorMessage: string | null | undefined,
): boolean {
  if (httpStatus !== null && httpStatus !== undefined && (RETRYABLE_HTTP_STATUSES.has(httpStatus) || httpStatus >= 500)) {
    return true;
  }
  // Cartesia labels its premature WebSocket close "safe to retry" in the
  // error message (adapters/cartesia.ts) -- honor that contract here too.
  return !!errorMessage?.includes("safe to retry");
}

function isRetryableError(err: unknown): boolean {
  if (err instanceof ProviderConfigError) return false;
  const status = (err as { httpStatus?: unknown }).httpStatus;
  if (typeof status === "number") {
    return isRetryableOutcome(status, err instanceof Error ? err.message : undefined);
  }
  // Timeouts / socket resets surface as generic Errors from fetch and the
  // pollers -- bounded retries are cheap next to re-running an entire run.
  return true;
}

// RUN-01/FR-E4: a run can be (re)executed and only the cells that don't yet
// have a successful result are attempted -- so a partial provider outage
// doesn't force re-running (and re-billing) cells that already succeeded.
//
// `opts.audioResolver` exists purely so tests/rehearsals (the scale
// rehearsal script in this package, src/rehearsal-scale.ts) can substitute a
// deterministic resolver instead of the Vapi signed-URL refresh --
// production callers omit it entirely.
export async function executeBenchmarkRun(
  runId: string,
  actorLabel: string,
  opts: { audioResolver?: (call: BenchmarkCallRow) => Promise<string> } = {},
): Promise<void> {
  if (runningRuns.has(runId)) {
    logger.warn({ runId }, "executeBenchmarkRun called while already running for this runId -- ignored");
    return;
  }
  runningRuns.add(runId);

  const lockClient = await pool.connect();
  let acquired = false;
  try {
    const res = await lockClient.query<{ locked: boolean }>(
      "SELECT pg_try_advisory_lock(hashtext($1)) AS locked",
      [runId],
    );
    acquired = res.rows[0]?.locked === true;
    if (!acquired) {
      logger.warn({ runId }, "run is locked by another executor instance -- ignored");
      return;
    }
    await executeBenchmarkRunInner(runId, actorLabel, opts.audioResolver);
  } finally {
    if (acquired) {
      await lockClient.query("SELECT pg_advisory_unlock(hashtext($1))", [runId]);
    }
    lockClient.release();
    runningRuns.delete(runId);
  }
}

async function executeBenchmarkRunInner(
  runId: string,
  actorLabel: string,
  audioResolver: (call: BenchmarkCallRow) => Promise<string> = resolveFreshRecordingUrl,
): Promise<void> {
  const [run] = await db
    .select()
    .from(benchmarkRunsTable)
    .where(eq(benchmarkRunsTable.id, runId))
    .limit(1);

  // "running" is included so a run left stuck by a process crash (no durable
  // job queue -- see the fire-and-forget note in routes/benchmark.ts) can
  // still be recovered via POST /benchmark/runs/:runId/execute. Concurrent
  // entry is prevented by the advisory lock in executeBenchmarkRun above
  // (cross-instance) and the runningRuns Set (same process).
  //
  // "complete" is included too -- found live 2026-08-24: finalStatus below
  // is "complete" as soon as ANY cell succeeds, which is the common case for
  // a partial provider/audio-URL outage. Without this, the exact runs whose
  // own `notes` field says "N cell(s) failed transiently and can be retried
  // by re-executing this run" were the ones retrying could never actually
  // touch -- the old guard silently no-opped on them. Safe to allow: the
  // alreadyOk resumability check below is what makes a retry idempotent, not
  // this status gate, so re-entering a "complete" run only touches cells
  // that never succeeded.
  if (
    !run ||
    (run.status !== "queued" &&
      run.status !== "failed" &&
      run.status !== "running" &&
      run.status !== "complete")
  )
    return;

  await db
    .update(benchmarkRunsTable)
    // B-89 (verified wave-2): clearing completedAt matters — Runs.tsx
    // renders duration from completedAt−createdAt, so a re-executed run
    // used to show its OLD duration while retrying, then a number inflated
    // by the entire idle gap between attempts.
    .set({ status: "running", completedAt: null })
    .where(eq(benchmarkRunsTable.id, runId));

  const [calls, providers, existingResults] = await Promise.all([
    db
      .select()
      .from(benchmarkCallsTable)
      .where(inArray(benchmarkCallsTable.id, run.callIds)),
    db
      .select()
      .from(benchmarkProvidersTable)
      .where(inArray(benchmarkProvidersTable.id, run.providerIds)),
    db
      .select()
      .from(benchmarkProviderCallResultsTable)
      .where(eq(benchmarkProviderCallResultsTable.runId, runId)),
  ]);

  const alreadyOk = new Set(
    existingResults
      .filter((r) => r.status === "ok")
      .map((r) => `${r.providerId}::${r.callId}`),
  );

  // Found live 2026-08-25: every retry re-inserted a brand-new row for any
  // cell that was NOT "ok" (e.g. the permanently-broken bucket-403 cells --
  // see docs/backlog/good-to-have.md), instead of replacing the stale
  // attempt. A run retried twice left 3 rows for the same (provider, call)
  // pair -- /results ballooned with duplicate "failed" rows, and nothing
  // ever cleaned them up. Every non-"ok" row here is guaranteed to be
  // re-attempted below (alreadyOk is the only skip condition), so it's safe
  // to clear them first -- ON DELETE CASCADE on benchmark_scores.result_id
  // means this can never orphan a real score (only "ok" rows have scores,
  // and "ok" rows are never in this set).
  const staleResultIds = existingResults
    .filter((r) => r.status !== "ok")
    .map((r) => r.id);
  if (staleResultIds.length > 0) {
    await db
      .delete(benchmarkProviderCallResultsTable)
      .where(inArray(benchmarkProviderCallResultsTable.id, staleResultIds));
  }

  // FR-BLK-11 (bulk runs only): the all-or-nothing ready_to_run gate on
  // POST /benchmark/runs deliberately does NOT apply to bulk shard runs --
  // at 50-1000 calls, waiting for 100% human review defeats the point. The
  // not-ready subset is recorded as skipped_pending_review (a new outcome
  // class, not a failure: nothing was attempted, no cost spent) and the
  // ready subset executes. Ad-hoc Runs-page runs keep the strict gate.
  const isBulkShard = run.bulkId !== null;
  const skippedCalls = isBulkShard
    ? calls.filter((call) => call.status !== "ready_to_run")
    : [];
  const runnableCalls = isBulkShard
    ? calls.filter((call) => call.status === "ready_to_run")
    : calls;

  let skippedCells = 0;
  for (const call of skippedCalls) {
    for (const provider of providers.filter(
      (p) => !alreadyOk.has(`${p.id}::${call.id}`),
    )) {
      await insertResult(runId, call.id, provider.id, {
        status: "skipped_pending_review",
        submittedAt: null,
        finalAt: null,
        httpStatus: null,
        hypothesisTranscript: null,
        rawOutput: null,
        errorMessage: `Call status is "${call.status}" -- bulk runs only execute ready_to_run calls (FR-BLK-11). Re-review, then retry-failed picks it up.`,
      });
      skippedCells += 1;
    }
  }

  let failedCells = 0;
  let configBlockedCells = 0;
  let okCells = alreadyOk.size;

  // Resolve fresh recording URLs concurrently, but with a small cap -- this
  // is a Vapi API round trip per call and politeness matters more than
  // parallelism here. Resolved once per CALL, not once per (call, provider):
  // every provider for a call gets the same live URL, and a stale/broken
  // recording link only costs one Vapi trip, not one per provider.
  const audioByCallId = new Map<string, { url: string | null; error: string | null }>();
  await drainWithConcurrency(runnableCalls, Math.min(RUN_CONCURRENCY, 8), async (call) => {
    if (!call.audioObjectPath) {
      audioByCallId.set(call.id, { url: null, error: "Call has no audioObjectPath to send to a provider." });
      return;
    }
    try {
      audioByCallId.set(call.id, { url: await audioResolver(call), error: null });
    } catch (err) {
      audioByCallId.set(call.id, {
        url: null,
        error: `Could not get a live recording URL: ${err instanceof Error ? err.message : String(err)}`,
      });
    }
  });

  // Materialize the full cell list up front so progress logging has a real
  // denominator and the worker pool drains a flat queue instead of a nested
  // loop. Cells whose audio never resolved are failed immediately without
  // occupying a provider slot.
  const cells: Array<{ call: BenchmarkCallRow; provider: BenchmarkProviderRow; audioUrl: string }> = [];
  for (const call of runnableCalls) {
    const audio = audioByCallId.get(call.id) ?? { url: null, error: "Audio resolution skipped." };
    for (const provider of providers.filter((p) => !alreadyOk.has(`${p.id}::${call.id}`))) {
      if (!audio.url) {
        await insertResult(runId, call.id, provider.id, {
          status: "failed",
          submittedAt: new Date(),
          finalAt: new Date(),
          httpStatus: null,
          hypothesisTranscript: null,
          rawOutput: null,
          errorMessage: audio.error,
        });
        failedCells += 1;
        continue;
      }
      cells.push({ call, provider, audioUrl: audio.url });
    }
  }

  // Drain cells through the global worker pool; each vendor additionally gets
  // its own semaphore so one slow/polling provider can't crowd out the rest.
  const providerSlots = new Map<string, Semaphore>();
  const slotsFor = (providerId: string) => {
    let s = providerSlots.get(providerId);
    if (!s) {
      s = new Semaphore(PROVIDER_CONCURRENCY);
      providerSlots.set(providerId, s);
    }
    return s;
  };

  let completedCells = 0;
  let cancelledCells = 0;
  await drainWithConcurrency(cells, RUN_CONCURRENCY, async ({ call, provider, audioUrl }) => {
    // FR-BLK-7: never START a cell after cancellation. Cells already inside
    // adapter.transcribe() are not interrupted -- they complete and persist.
    if (cancelRequestedRuns.has(runId)) {
      try {
        await insertResult(runId, call.id, provider.id, {
          status: "cancelled",
          submittedAt: null,
          finalAt: null,
          httpStatus: null,
          hypothesisTranscript: null,
          rawOutput: null,
          errorMessage: "Bulk cancelled before this cell started (FR-BLK-7).",
        });
      } catch (insertErr) {
        logger.error({ insertErr, runId, providerId: provider.id, callId: call.id }, "failed to persist cell cancellation");
      }
      cancelledCells += 1;
      completedCells += 1;
      return;
    }
    const slot = slotsFor(provider.id);
    await slot.acquire();
    try {
      const outcome = await runCell(runId, call, provider, audioUrl);
      if (outcome === "ok") okCells += 1;
      else if (outcome === "config_blocked") configBlockedCells += 1;
      else failedCells += 1;
    } finally {
      slot.release();
      completedCells += 1;
      if (completedCells % 25 === 0 || completedCells === cells.length) {
        logger.info(
          { runId, completedCells, totalCells: cells.length },
          "benchmark run progress",
        );
      }
    }
  });

  try {
    await computeRankingsForRun(runId, run.callIds, run.providerIds);
  } catch (err) {
    // Ranking is a derived aggregate -- if it fails, the run must still be
    // finalized so it doesn't get stuck in "running" forever (the raw
    // results/scores that did land are still queryable via /results either
    // way, so nothing is lost).
    logger.error({ err, runId }, "Failed to compute rankings for run");
  }

  const totalCells = calls.length * providers.length;
  const wasCancelled = cancelRequestedRuns.has(runId);
  cancelRequestedRuns.delete(runId);
  const notes: string[] = [];
  if (configBlockedCells > 0) {
    notes.push(
      `${configBlockedCells} cell(s) blocked: provider API key not configured. See docs/provider-matrix.md / PRO-01.`,
    );
  }
  if (failedCells > 0) {
    notes.push(`${failedCells} cell(s) failed transiently and can be retried by re-executing this run.`);
  }
  if (skippedCells > 0) {
    notes.push(
      `${skippedCells} cell(s) skipped pending review (FR-BLK-11): call not ready_to_run; no provider call was attempted or billed.`,
    );
  }
  if (cancelledCells > 0) {
    notes.push(`${cancelledCells} cell(s) cancelled before starting (FR-BLK-7).`);
  }

  // Bug found live 2026-08-27 (Abhishek noticed a run reading "failed" with
  // nothing actually wrong): a shard whose calls are ALL not-yet-reviewed
  // has okCells=0 and failedCells=0 -- every cell landed in skippedCells
  // instead. The old formula fell through to "failed" for that case, which
  // is exactly backwards: nothing was attempted, so nothing failed. Contrast
  // with refreshBulkStatus() in bulk-status.ts, which already gets this
  // right at the bulk level (failed only when failedCells > 0) -- this run-
  // level formula just hadn't matched it. "failed" is now reserved for
  // "something was actually attempted and none of it succeeded".
  const attemptedCells = okCells + failedCells + configBlockedCells;
  const finalStatus = wasCancelled
    ? "cancelled"
    : attemptedCells === 0
      ? "complete"
      : okCells === totalCells
        ? "complete"
        : okCells > 0
          ? "complete"
          : "failed";

  await db
    .update(benchmarkRunsTable)
    .set({
      status: finalStatus,
      completedAt: new Date(),
      // Found live 2026-08-25 alongside the duplicate-rows bug above: this
      // used to prepend `run.notes` (every past attempt's notes), so a run
      // retried N times accumulated N near-identical "X cell(s) failed..."
      // lines. `notes` describes the current attempt's outcome, not a
      // history of every retry -- that history already lives in audit_log
      // (writeAudit below), so it isn't lost by not also piling up here.
      notes: notes.join("\n") || null,
    })
    .where(eq(benchmarkRunsTable.id, runId));

  await writeAudit({
    entityType: "run",
    entityId: runId,
    actorLabel,
    action: "execute",
    beforeState: { status: run.status },
    afterState: { status: finalStatus, okCells, failedCells, configBlockedCells, skippedCells, cancelledCells, totalCells },
  });

  // A shard run finishing can finish its bulk (FR-BLK-4) -- recompute the
  // bulk's stored status from its runs/cells now that this run is terminal.
  if (run.bulkId) {
    try {
      await refreshBulkStatus(run.bulkId);
    } catch (err) {
      logger.error({ err, bulkId: run.bulkId, runId }, "failed to refresh bulk status");
    }
  }
}

// One cell = one (call, provider) pair. The provider call is retried with
// backoff for transient outcomes; persistence is NOT -- the first row written
// to benchmark_provider_call_results makes the attempt committed history, and
// replacement semantics belong to the stale-row cleanup at run start.
async function runCell(
  runId: string,
  call: BenchmarkCallRow,
  provider: BenchmarkProviderRow,
  audioUrl: string,
): Promise<"ok" | "failed" | "config_blocked"> {
  const adapter = getProviderAdapter(provider.id);
  if (!adapter) {
    await insertResult(runId, call.id, provider.id, {
      status: "failed",
      submittedAt: new Date(),
      finalAt: new Date(),
      httpStatus: null,
      hypothesisTranscript: null,
      rawOutput: null,
      errorMessage: `No adapter registered for provider "${provider.id}" (PRO-03 gap).`,
    });
    return "failed";
  }

  // --- Phase 1: provider transcription, with bounded retries. --------------
  let result: ProviderTranscribeResult | null = null;
  let lastTransient: { result?: ProviderTranscribeResult; error?: unknown } = {};

  for (let attempt = 1; attempt <= CELL_MAX_ATTEMPTS; attempt++) {
    try {
      const candidate = await adapter.transcribe({
        callId: call.id,
        audioUrl,
        diarize: true,
      });
      if (candidate.status === "ok" || !isRetryableOutcome(candidate.httpStatus, candidate.errorMessage)) {
        result = candidate;
        break;
      }
      // Terminal-shaped body but a retryable status (429/5xx): remember and
      // back off.
      lastTransient = { result: candidate };
    } catch (err) {
      if (!isRetryableError(err)) {
        lastTransient = { error: err };
        break;
      }
      lastTransient = { error: err };
    }
    if (attempt < CELL_MAX_ATTEMPTS) {
      const waitMs = backoffMs(attempt - 1);
      logger.warn(
        { runId, providerId: provider.id, callId: call.id, attempt, nextRetryInMs: Math.round(waitMs) },
        "transient provider failure -- will retry cell",
      );
      await sleep(waitMs);
    }
  }

  if (!result) {
    // Retries exhausted (or terminal error): record the last known failure.
    const err = lastTransient.error;
    const isConfigError = err instanceof ProviderConfigError;
    const message =
      err instanceof Error
        ? err.message
        : err
          ? String(err)
          : (lastTransient.result?.errorMessage ?? "provider failed after all retry attempts");
    try {
      await insertResult(runId, call.id, provider.id, {
        status: "failed",
        submittedAt: new Date(),
        finalAt: new Date(),
        httpStatus: lastTransient.result?.httpStatus ?? null,
        hypothesisTranscript: null,
        rawOutput: lastTransient.result?.rawOutput ?? null,
        errorMessage:
          CELL_MAX_ATTEMPTS > 1 && (lastTransient.result || lastTransient.error)
            ? `${message} (after ${CELL_MAX_ATTEMPTS} attempt(s))`
            : message,
      });
    } catch (insertErr) {
      // A failed bookkeeping insert must never take the whole run down --
      // log it and move on; the run notes will still count this cell failed.
      logger.error({ insertErr, runId, providerId: provider.id, callId: call.id }, "failed to persist cell failure");
    }
    if (isConfigError) {
      logger.warn({ providerId: provider.id, callId: call.id }, "Provider cell blocked by missing config");
      return "config_blocked";
    }
    return "failed";
  }

  // --- Phase 2: persistence + scoring (never retried here). ----------------
  try {
    const rawOutputString = JSON.stringify(result.rawOutput ?? null);
    const rawOutputHash = createHash("sha256").update(rawOutputString).digest("hex");
    const submittedAt = new Date(result.submittedAt);
    const finalAt = result.finalAt ? new Date(result.finalAt) : null;
    // Only Cartesia (WebSocket streaming) populates this today -- every
    // other adapter is batch/URL and has no first-partial notion, so it
    // stays null there rather than being defaulted to "instant" (RUN-02).
    const firstPartialAt = result.firstPartialAt ? new Date(result.firstPartialAt) : null;

    const [resultRow] = await db
      .insert(benchmarkProviderCallResultsTable)
      .values({
        runId,
        callId: call.id,
        providerId: provider.id,
        status: result.status,
        submittedAt,
        firstPartialAt,
        finalAt,
        httpStatus: result.httpStatus,
        hypothesisTranscript: result.hypothesisTranscript,
        rawOutput: rawOutputString,
        rawOutputHash,
        errorMessage: result.errorMessage,
      })
      .returning();

    if (result.status !== "ok" || !result.hypothesisTranscript) {
      return "failed";
    }

    const latencyFinalMs =
      finalAt && submittedAt ? finalAt.getTime() - submittedAt.getTime() : null;
    const latencyFirstPartialMs =
      firstPartialAt && submittedAt ? firstPartialAt.getTime() - submittedAt.getTime() : null;

    const scored = score({
      callId: call.id,
      vertical: call.vertical as "rush" | "property_management" | "trucking",
      providerId: provider.id,
      goldTranscript: call.goldTranscript ?? "",
      hypothesisTranscript: result.hypothesisTranscript,
      entities: call.entityReferences,
      latencyFinalMs,
      latencyFirstPartialMs,
      costPerMinute: (provider.costPerMinute * call.durationSeconds) / 60,
      diarizationScore: result.diarizationScore,
    });

    await db.insert(benchmarkScoresTable).values({
      resultId: resultRow.id,
      scoringVersion: SCORING_VERSION,
      wer: scored.wer,
      entityAccuracy: scored.entityAccuracy,
      alphanumericAccuracy: scored.alphanumericAccuracy,
      latencyFirstPartialMs: scored.latencyFirstPartialMs,
      latencyFinalMs: scored.latencyFinalMs,
      costPerMinute: scored.costPerMinute,
      diarizationScore: scored.diarizationScore,
      detail: { edits: scored.edits, entityResults: scored.entityResults, wordDiff: scored.wordDiff },
    });

    return "ok";
  } catch (err) {
    // Persistence/scoring errors are not retried (see phase comment), but a
    // crash here must still leave a visible failed row instead of silently
    // dropping the cell.
    try {
      await insertResult(runId, call.id, provider.id, {
        status: "failed",
        submittedAt: new Date(),
        finalAt: new Date(),
        httpStatus: null,
        hypothesisTranscript: null,
        rawOutput: null,
        errorMessage: `Persisted transcription but failed to store/score it: ${err instanceof Error ? err.message : String(err)}`,
      });
    } catch (insertErr) {
      logger.error({ insertErr, runId, providerId: provider.id, callId: call.id }, "failed to persist cell failure");
    }
    logger.warn({ err, providerId: provider.id, callId: call.id }, "Provider cell failed during persistence");
    return "failed";
  }
}

async function insertResult(
  runId: string,
  callId: string,
  providerId: string,
  fields: {
    status: "ok" | "failed" | "skipped_pending_review" | "cancelled";
    submittedAt: Date | null;
    finalAt: Date | null;
    httpStatus: number | null;
    hypothesisTranscript: string | null;
    rawOutput: unknown;
    errorMessage: string | null;
  },
): Promise<void> {
  const rawOutputString = fields.rawOutput === null ? null : JSON.stringify(fields.rawOutput);
  await db.insert(benchmarkProviderCallResultsTable).values({
    runId,
    callId,
    providerId,
    status: fields.status,
    submittedAt: fields.submittedAt,
    finalAt: fields.finalAt,
    httpStatus: fields.httpStatus,
    hypothesisTranscript: fields.hypothesisTranscript,
    rawOutput: rawOutputString,
    rawOutputHash: rawOutputString
      ? createHash("sha256").update(rawOutputString).digest("hex")
      : null,
    errorMessage: fields.errorMessage,
  });
}

// RANK-01/FR-S8: aggregate this run's scores into per-vertical rankings.
// Weights are documented and unverified-by-design (PRD OD-1) -- raw metrics
// stay attached via `detail` on the score row so the composite never hides
// a tradeoff.
export async function computeRankingsForRun(
  runId: string,
  callIds: string[],
  providerIds: string[],
): Promise<void> {
  const [calls, providers] = await Promise.all([
    db.select().from(benchmarkCallsTable).where(inArray(benchmarkCallsTable.id, callIds)),
    db
      .select()
      .from(benchmarkProvidersTable)
      .where(inArray(benchmarkProvidersTable.id, providerIds)),
  ]);

  const results = await db
    .select({
      result: benchmarkProviderCallResultsTable,
      score: benchmarkScoresTable,
    })
    .from(benchmarkProviderCallResultsTable)
    .innerJoin(
      benchmarkScoresTable,
      eq(benchmarkScoresTable.resultId, benchmarkProviderCallResultsTable.id),
    )
    .where(
      and(
        eq(benchmarkProviderCallResultsTable.runId, runId),
        eq(benchmarkProviderCallResultsTable.status, "ok"),
      ),
    );

  const callById = new Map(calls.map((c) => [c.id, c]));
  // 2026-08-27, per Abhishek: group by real assistant instead of vertical --
  // null (no sourceAssistantId, i.e. a manually-added call) buckets into a
  // single "Other" group rather than being dropped. `NO_ASSISTANT_KEY` is a
  // local grouping sentinel only; the actual inserted row still stores a
  // real `null` (see rankingRows.push below), never this string.
  const NO_ASSISTANT_KEY = "__no_assistant__";
  const assistantKeys = new Set(
    calls.map((c) => c.sourceAssistantId ?? NO_ASSISTANT_KEY),
  );

  // All aggregation happens in memory first; the database only sees the
  // clear-and-rewrite at the bottom, inside ONE transaction. (Found as a
  // scale risk during the concurrency rework: the old delete-then-insert-
  // per-vertical loop ran as autocommit statements, so a crash mid-write
  // stranded a vertical with zero ranking rows.)
  const rankingRows: Array<typeof benchmarkRankingsTable.$inferInsert> = [];

  for (const assistantKey of assistantKeys) {
    const assistantId = assistantKey === NO_ASSISTANT_KEY ? null : assistantKey;
    const rowsForGroup = results.filter(
      (r) => (callById.get(r.result.callId)?.sourceAssistantId ?? NO_ASSISTANT_KEY) === assistantKey,
    );

    // A ranking row still carries `vertical` as a display tag (2026-08-27):
    // an assistant's calls are expected to share one vertical, but this
    // takes whichever is most common in the group rather than assuming it,
    // in case a call was ever miscategorized.
    const verticalCounts = new Map<string, number>();
    for (const r of rowsForGroup) {
      const v = callById.get(r.result.callId)?.vertical;
      if (v) verticalCounts.set(v, (verticalCounts.get(v) ?? 0) + 1);
    }
    const vertical = [...verticalCounts.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? "rush";

    const byProvider = new Map<string, typeof rowsForGroup>();
    for (const row of rowsForGroup) {
      const list = byProvider.get(row.result.providerId) ?? [];
      list.push(row);
      byProvider.set(row.result.providerId, list);
    }

    const maxLatencyFinalMs = Math.max(
      0,
      ...rowsForGroup.map((r) => r.score.latencyFinalMs ?? 0),
    );
    const maxCostPerMinute = Math.max(0, ...rowsForGroup.map((r) => r.score.costPerMinute ?? 0));

    const providerAggregates = [...byProvider.entries()].map(([providerId, rows]) => {
      const avg = (values: Array<number | null>) => {
        const present = values.filter((v): v is number => v !== null);
        return present.length ? present.reduce((a, b) => a + b, 0) / present.length : null;
      };
      const wer = avg(rows.map((r) => r.score.wer));
      const entityAccuracy = avg(rows.map((r) => r.score.entityAccuracy));
      const alphanumericAccuracy = avg(rows.map((r) => r.score.alphanumericAccuracy));
      const latencyFirstPartialMs = avg(rows.map((r) => r.score.latencyFirstPartialMs));
      const latencyFinalMs = avg(rows.map((r) => r.score.latencyFinalMs));
      const costPerMinute = avg(rows.map((r) => r.score.costPerMinute));
      const diarizationScore = avg(rows.map((r) => r.score.diarizationScore));

      const composite = compositeScore({
        wer,
        entityAccuracy,
        alphanumericAccuracy,
        latencyFinalMs,
        costPerMinute,
        maxLatencyFinalMs,
        maxCostPerMinute,
      });

      return {
        providerId,
        providerName: providers.find((p) => p.id === providerId)?.name ?? providerId,
        wer,
        entityAccuracy,
        alphanumericAccuracy,
        latencyFirstPartialMs,
        latencyFinalMs,
        costPerMinute,
        diarizationScore,
        composite,
        sampleSize: rows.length,
      };
    });

    providerAggregates.sort((a, b) => (b.composite ?? -1) - (a.composite ?? -1));

    if (providerAggregates.length === 0) continue; // nothing scored ok for this group yet

    // Per-PROVIDER confidence note (threshold review 2026-08-25): the old
    // note keyed only on rank 1's sample size with a <10 cutoff, so (a) a
    // runner-up with 2 scored cells shipped with no caveat while rank 1 had
    // 20, and (b) 10- and 11-call groups passed as "decision-grade" even
    // though the PRD's Full-Benchmark bar is >=12 calls per group
    // (docs/PRD.md AC-FULL-1 -- written against verticals, applied per
    // assistant-group now for the same reason: too few samples is too few
    // samples regardless of what the group is called).
    const confidenceNoteFor = (sampleSize: number): string =>
      sampleSize < 12
        ? `Confidence: low -- only ${sampleSize} scored call(s) for this provider in this group (decision bar is >=12, PRD AC-FULL-1). Do not treat as decision-grade.`
        : `Based on ${sampleSize} scored call(s) for this provider in this group.`;

    rankingRows.push(
      ...providerAggregates.map((agg, index) => ({
        id: randomUUID(),
        runId,
        vertical,
        assistantId,
        providerId: agg.providerId,
        providerName: agg.providerName,
        rank: index + 1,
        // Null, not 0 -- "no scored cell had this metric" is a real,
        // distinct state from "measured and scored zero" (found
        // 2026-08-24: this ?? 0 was making alphanumericAccuracy display as
        // a real 0% score on every ranking row, when the true state was
        // "no entity in this run was ever alphanumeric enough to score").
        // Same reasoning extends latencyFirstPartialMs to batch/URL
        // adapters, which have no first-partial notion at all (RUN-02) --
        // 0ms previously read as "instantly fast" rather than "not
        // applicable."
        wer: agg.wer,
        entityAccuracy: agg.entityAccuracy,
        alphanumericAccuracy: agg.alphanumericAccuracy,
        latencyFirstPartialMs: agg.latencyFirstPartialMs,
        latencyFinalMs: agg.latencyFinalMs,
        costPerMinute: agg.costPerMinute,
        diarizationScore: agg.diarizationScore,
        recommendation:
          agg.composite === null
            ? "Insufficient evidence (missing WER or entity accuracy) -- do not rank this provider yet."
            : index === 0
              ? `Leading candidate for ${assistantId ? `this assistant's calls (${vertical})` : `calls with no assistant on file (${vertical})`}. ${confidenceNoteFor(agg.sampleSize)}`
              : `Behind rank 1 on composite score. ${confidenceNoteFor(agg.sampleSize)}`,
      })),
    );
  }

  await db.transaction(async (tx) => {
    await tx.delete(benchmarkRankingsTable).where(eq(benchmarkRankingsTable.runId, runId));
    if (rankingRows.length > 0) {
      await tx.insert(benchmarkRankingsTable).values(rankingRows);
    }
  });
}

export { RANKING_WEIGHTS };

// Boot recovery for the async job states: the executor is still in-process
// fire-and-forget (the durable-queue move to pg-boss, FR-EXC-1, remains
// open), so a process restart mid-run would otherwise strand "queued" /
// "running" runs until someone manually re-executed them. On boot, re-enter
// every such run -- the alreadyOk resumability check makes that safe and
// idempotent -- then recompute any mid-flight bulk's stored status.
export async function recoverInterruptedRuns(): Promise<void> {
  const stuckRuns = await db
    .select({ id: benchmarkRunsTable.id })
    .from(benchmarkRunsTable)
    .where(inArray(benchmarkRunsTable.status, ["queued", "running"]));
  for (const run of stuckRuns) {
    logger.warn({ runId: run.id }, "recovering interrupted run after restart");
    void executeBenchmarkRun(run.id, "system-boot").catch((err) => {
      logger.error({ err, runId: run.id }, "recovered run crashed");
    });
  }

  const stuckBulks = await db
    .select({ id: benchmarkBulksTable.id })
    .from(benchmarkBulksTable)
    .where(inArray(benchmarkBulksTable.status, ["estimating", "running"]));
  for (const bulk of stuckBulks) {
    await refreshBulkStatus(bulk.id);
  }
}
