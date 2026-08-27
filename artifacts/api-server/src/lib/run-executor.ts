import { createHash, randomUUID } from "node:crypto";
import { and, desc, eq, inArray } from "drizzle-orm";
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
import {
  score,
  scoreEntities,
  SCORING_VERSION,
  severityRank,
  hybridCompositeScore,
  type HybridSeverity,
} from "@workspace/scoring";
import {
  ProviderConfigError,
  getProviderAdapter,
  type ProviderTranscribeResult,
} from "@workspace/stt-providers";
import { logger } from "./logger";
import { writeAudit } from "./audit";
import { refreshBulkStatus } from "./bulk-status";
import { getOrCacheAudioBytes, readCachedAudioBytes } from "./audio-cache";
import { computeHybridFlagsForRun } from "./hybrid-flagging";

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
export function envInt(name: string, fallback: number, max: number): number {
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
  // T-6 fix: capacity can shrink/grow at runtime (429 back-pressure) without
  // disturbing in-flight holders. shrinkBy may take `slots` negative --
  // that's intentional, it just means that many additional release() calls
  // must land before a new acquire() can proceed; nothing is lost or
  // double-counted as long as every acquire is eventually released.
  shrinkBy(n: number): void {
    this.slots -= n;
  }
  growBy(n: number): void {
    for (let i = 0; i < n; i += 1) {
      const next = this.waiters.shift();
      if (next) next();
      else this.slots += 1;
    }
  }
}

// T-6 fix (2026-08-27, base-solidity review): this registry used to be
// created FRESH inside executeBenchmarkRunInner, so every shard run of a
// bulk got its own independent set of per-provider semaphores. A 1,000-call
// bulk sharded into 20 runs (default shardSize 50) meant 20x the configured
// PROVIDER_CONCURRENCY hitting each vendor simultaneously -- a self-
// inflicted 429 storm against the exact gate meant to prevent one, and
// since latency feeds the ranking composite, a self-inflicted storm doesn't
// just slow the bulk down, it corrupts the ranking it's producing.
// Module-level singleton: every run in this process shares the same
// per-provider slot pool, no matter how many shards are in flight.
const providerSlots = new Map<string, Semaphore>();

// Suggested starting points per vendor shape (sync REST vs async-poll vs
// WebSocket-streaming) -- not yet tuned against real 429s (see
// docs/PRD-v3-technical.md T-6). Any provider not listed falls back to the
// PROVIDER_CONCURRENCY env default below.
const PROVIDER_CONCURRENCY_OVERRIDES: Record<string, number> = {
  "deepgram-nova-3": 8,
  "assemblyai-universal": 6,
  "openai-gpt-4o-transcribe": 4,
  "elevenlabs-scribe": 4,
  "gladia-solaria": 4,
  speechmatics: 4,
  "cartesia-ink-whisper": 2,
};

function baseConcurrencyFor(providerId: string): number {
  return PROVIDER_CONCURRENCY_OVERRIDES[providerId] ?? PROVIDER_CONCURRENCY;
}

function slotsFor(providerId: string): Semaphore {
  let s = providerSlots.get(providerId);
  if (!s) {
    s = new Semaphore(baseConcurrencyFor(providerId));
    providerSlots.set(providerId, s);
  }
  return s;
}

// T-6 fix: on a 429, halve the offending provider's live concurrency for 60s
// then restore it -- one transition logged, not one line per cell, and
// idempotent while the back-off window is already active so a burst of 429s
// doesn't compound into starving the provider entirely.
const backPressureActive = new Set<string>();

function applyBackPressure(providerId: string): void {
  if (backPressureActive.has(providerId)) return;
  backPressureActive.add(providerId);
  const sem = slotsFor(providerId);
  const current = baseConcurrencyFor(providerId);
  const reduced = Math.max(1, Math.floor(current / 2));
  const delta = current - reduced;
  if (delta > 0) sem.shrinkBy(delta);
  logger.warn({ providerId, from: current, to: reduced }, "429 received -- halving provider concurrency for 60s");
  setTimeout(() => {
    if (delta > 0) sem.growBy(delta);
    backPressureActive.delete(providerId);
    logger.info({ providerId, restoredTo: current }, "429 back-off window elapsed -- provider concurrency restored");
  }, 60_000).unref();
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
  opts: { audioResolver?: (call: BenchmarkCallRow) => Promise<Buffer> } = {},
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
  audioResolver: (call: BenchmarkCallRow) => Promise<Buffer> = getOrCacheAudioBytes,
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

  // T-7 fix (2026-08-27, base-solidity review): this used to keep every
  // resolved call's audio Buffer in `audioByCallId` for the ENTIRE shard
  // (a 50-call shard held ~200MB of buffers at once; a full, uncapped bulk
  // held gigabytes), even though the bytes are durably on local disk the
  // moment they're resolved. This pre-pass now only warms the disk cache
  // and records ok/error per call -- resolved once per CALL, not once per
  // (call, provider), so a stale/broken recording still only costs one
  // resolution. The actual bytes are read back per-cell, right before that
  // cell's provider call, so at most RUN_CONCURRENCY cells' worth of audio
  // is ever held in memory at once, not the whole shard's.
  const audioStatusByCallId = new Map<string, { ok: boolean; error: string | null }>();
  await drainWithConcurrency(runnableCalls, Math.min(RUN_CONCURRENCY, 8), async (call) => {
    if (!call.audioObjectPath) {
      audioStatusByCallId.set(call.id, { ok: false, error: "Call has no audioObjectPath to send to a provider." });
      return;
    }
    try {
      await audioResolver(call); // warms the disk cache; bytes discarded here on purpose
      audioStatusByCallId.set(call.id, { ok: true, error: null });
    } catch (err) {
      audioStatusByCallId.set(call.id, {
        ok: false,
        error: `Could not get this call's audio: ${err instanceof Error ? err.message : String(err)}`,
      });
    }
  });

  /** Reads one cell's audio bytes right before it's needed -- disk cache
   * first (cheap; warmed by the pre-pass above for the production
   * getOrCacheAudioBytes resolver), falling back to audioResolver(call)
   * directly so a test/rehearsal's substitute resolver (which may not write
   * to the standard disk cache at all) still works unchanged. */
  async function readCellAudio(call: BenchmarkCallRow): Promise<Buffer> {
    try {
      return await readCachedAudioBytes(call.id);
    } catch {
      return audioResolver(call);
    }
  }

  // Materialize the full cell list up front so progress logging has a real
  // denominator and the worker pool drains a flat queue instead of a nested
  // loop. Cells whose audio never resolved are failed immediately without
  // occupying a provider slot.
  const cells: Array<{ call: BenchmarkCallRow; provider: BenchmarkProviderRow }> = [];
  for (const call of runnableCalls) {
    const status = audioStatusByCallId.get(call.id) ?? { ok: false, error: "Audio resolution skipped." };
    for (const provider of providers.filter((p) => !alreadyOk.has(`${p.id}::${call.id}`))) {
      if (!status.ok) {
        await insertResult(runId, call.id, provider.id, {
          status: "failed",
          submittedAt: new Date(),
          finalAt: new Date(),
          httpStatus: null,
          hypothesisTranscript: null,
          rawOutput: null,
          errorMessage: status.error,
        });
        failedCells += 1;
        continue;
      }
      cells.push({ call, provider });
    }
  }

  // Drain cells through the global worker pool; each vendor additionally
  // gets its own semaphore (module-level singleton, T-6 above) so one slow/
  // polling provider can't crowd out the rest, and so concurrent shard runs
  // of the same bulk share one real cap instead of multiplying it.
  let completedCells = 0;
  let cancelledCells = 0;
  await drainWithConcurrency(cells, RUN_CONCURRENCY, async ({ call, provider }) => {
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
      // T-7: read this cell's bytes only once it actually has a provider
      // slot -- a cell queued waiting for a slot holds no buffer at all.
      const audioBytes = await readCellAudio(call);
      const outcome = await runCell(runId, call, provider, audioBytes);
      if (outcome === "ok") okCells += 1;
      else if (outcome === "config_blocked") configBlockedCells += 1;
      else failedCells += 1;
    } catch (err) {
      try {
        await insertResult(runId, call.id, provider.id, {
          status: "failed",
          submittedAt: new Date(),
          finalAt: new Date(),
          httpStatus: null,
          hypothesisTranscript: null,
          rawOutput: null,
          errorMessage: `Could not read this call's audio for this cell: ${err instanceof Error ? err.message : String(err)}`,
        });
      } catch (insertErr) {
        logger.error({ insertErr, runId, providerId: provider.id, callId: call.id }, "failed to persist cell audio-read failure");
      }
      failedCells += 1;
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

  // 2026-08-27, per Abhishek ("we don't need a gold transcript any more"):
  // gold-free hybrid flagging (lib/scoring/src/hybrid.ts) across every
  // provider that succeeded in this run, compared against each other --
  // free (no LLM call), so it runs unconditionally before rankings, which
  // now sorts on its output instead of WER/entity-accuracy.
  try {
    await computeHybridFlagsForRun(runId);
  } catch (err) {
    logger.error({ err, runId }, "Failed to compute hybrid flags for run");
  }

  try {
    // T-1 fix: a bulk shard run computes rankings at BULK scope (every
    // shard's evidence together), not just its own ~50 calls -- an ad-hoc
    // (non-bulk) run keeps the unchanged per-run behavior.
    if (run.bulkId) {
      await computeRankingsForBulk(run.bulkId);
    } else {
      await computeRankingsForRun(runId, run.callIds, run.providerIds);
    }
  } catch (err) {
    // Ranking is a derived aggregate -- if it fails, the run must still be
    // finalized so it doesn't get stuck in "running" forever (the raw
    // results/scores that did land are still queryable via /results either
    // way, so nothing is lost).
    logger.error({ err, runId, bulkId: run.bulkId }, "Failed to compute rankings for run");
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
  audioBytes: Buffer,
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
        audioBytes,
        diarize: true,
        // T-8: lets the async-poll adapters scale their timeout to this
        // call's actual length instead of a fixed 120s.
        audioDurationSeconds: call.durationSeconds,
      });
      if (candidate.status === "ok" || !isRetryableOutcome(candidate.httpStatus, candidate.errorMessage)) {
        result = candidate;
        break;
      }
      // Terminal-shaped body but a retryable status (429/5xx): remember and
      // back off.
      if (candidate.httpStatus === 429) applyBackPressure(provider.id);
      lastTransient = { result: candidate };
    } catch (err) {
      if ((err as { httpStatus?: unknown }).httpStatus === 429) applyBackPressure(provider.id);
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

    // T-10 fix (2026-08-27, base-solidity review): with gold retired,
    // call.goldTranscript is empty for every call. score()'s word-alignment
    // against an empty reference produces one "ins" op PER WORD of the
    // hypothesis -- a second, bulkier copy of the transcript stored as
    // wordDiff, for data that's meaningless by construction (wer itself
    // already comes back null since referenceWords===0). Skip straight to
    // entity scoring (gold-independent -- it just checks whether the
    // call's known entities appear in the hypothesis) when there's no gold,
    // and don't touch alignWords/wordDiff/edits at all.
    const hasGold = !!call.goldTranscript?.trim();
    const costForThisCell = (provider.costPerMinute * call.durationSeconds) / 60;
    let wer: number | null;
    let entityAccuracy: number | null;
    let alphanumericAccuracy: number | null;
    let detail: Record<string, unknown>;
    if (hasGold) {
      const scored = score({
        callId: call.id,
        vertical: call.vertical as "rush" | "property_management" | "trucking",
        providerId: provider.id,
        goldTranscript: call.goldTranscript ?? "",
        hypothesisTranscript: result.hypothesisTranscript,
        entities: call.entityReferences,
        latencyFinalMs,
        latencyFirstPartialMs,
        costPerMinute: costForThisCell,
        diarizationScore: result.diarizationScore,
      });
      wer = scored.wer;
      entityAccuracy = scored.entityAccuracy;
      alphanumericAccuracy = scored.alphanumericAccuracy;
      detail = { edits: scored.edits, entityResults: scored.entityResults, wordDiff: scored.wordDiff };
    } else {
      const entity = scoreEntities(call.entityReferences, result.hypothesisTranscript);
      wer = null;
      entityAccuracy = entity.accuracy;
      alphanumericAccuracy = entity.alphanumericAccuracy;
      detail = { entityResults: entity.results };
    }

    await db.insert(benchmarkScoresTable).values({
      resultId: resultRow.id,
      scoringVersion: SCORING_VERSION,
      wer,
      entityAccuracy,
      alphanumericAccuracy,
      latencyFirstPartialMs,
      latencyFinalMs,
      costPerMinute: costForThisCell,
      // T-11 (base-solidity review): this column is mislabeled -- it has
      // always held the cost of THIS CELL (rate * this call's duration),
      // not a per-minute rate, and that mislabeling now leaks into the UI
      // and CSV export (docs/PRD-v3-uiux.md U-8 tracks the full rename).
      // costCents is the same value, correctly named and cents-denominated,
      // added alongside rather than replacing the column above so nothing
      // reading costPerMinute today breaks.
      costCents: Math.round(costForThisCell * 100),
      diarizationScore: result.diarizationScore,
      detail,
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
type RankingResultRow = {
  result: typeof benchmarkProviderCallResultsTable.$inferSelect;
  score: typeof benchmarkScoresTable.$inferSelect;
};

// T-1 fix (2026-08-27, base-solidity review): shared aggregation core,
// extracted so both computeRankingsForRun (ad-hoc runs) and
// computeRankingsForBulk (below -- rankings spanning every shard of a
// bulk) compute identically from a results/calls/providers set. Previously
// rankings were only ever computed per RUN; a bulk sharded into 20 runs
// (default shardSize 50) wrote 20 competing ranking sets, and GET
// /benchmark/rankings picked whichever run's createdAt happened to be
// newest (effectively arbitrary, since shards fire within milliseconds of
// each other) -- showing 50 calls of evidence out of 1,000.
function aggregateRankingRows(
  results: RankingResultRow[],
  calls: (typeof benchmarkCallsTable.$inferSelect)[],
  providers: (typeof benchmarkProvidersTable.$inferSelect)[],
): Array<Omit<typeof benchmarkRankingsTable.$inferInsert, "id" | "runId" | "bulkId">> {
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

  // All aggregation happens in memory first; the write side (below, per
  // caller) is a clear-and-rewrite inside ONE transaction. (Found as a
  // scale risk during the concurrency rework: the old delete-then-insert-
  // per-vertical loop ran as autocommit statements, so a crash mid-write
  // stranded a vertical with zero ranking rows.)
  const rankingRows: Array<Omit<typeof benchmarkRankingsTable.$inferInsert, "id" | "runId" | "bulkId">> = [];

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
    // T-2 fix (2026-08-27, base-solidity review): flagBadness now uses
    // peerFlagCount/peerFlagSeverity (cross-provider disagreement + entity
    // mismatch, available for every provider), NOT flagCount/flagSeverity
    // (which include confidence spans -- available for only 3 of 7
    // providers, so folding them in here punished a provider for the
    // honesty of reporting its own uncertainty). flagBadness = avgPeerFlag-
    // Count + avgPeerFlagSeverityScore (severityRank 0..3) -- see
    // hybridCompositeScore's own comment for why these are blended into one
    // number instead of weighted as two separate metrics.
    const flagBadnessOf = (r: (typeof rowsForGroup)[number]): number | null =>
      r.score.peerFlagCount === null && r.score.peerFlagSeverity === null
        ? null
        : (r.score.peerFlagCount ?? 0) + severityRank((r.score.peerFlagSeverity as HybridSeverity | null) ?? "none");
    const maxFlagBadness = Math.max(0, ...rowsForGroup.map((r) => flagBadnessOf(r) ?? 0));

    const providerAggregates = [...byProvider.entries()].map(([providerId, rows]) => {
      const avg = (values: Array<number | null>) => {
        const present = values.filter((v): v is number => v !== null);
        return present.length ? present.reduce((a, b) => a + b, 0) / present.length : null;
      };
      // 2026-08-27, per Abhishek: gold-free. wer/entityAccuracy are no
      // longer scored (see run-executor's per-cell score() call and
      // routes/benchmark.ts's retired ready_to_run gold gate) -- averaging
      // them here would just average nulls into null, harmless to leave in
      // for historical runs but not what this run's rows will have.
      const wer = avg(rows.map((r) => r.score.wer));
      const entityAccuracy = avg(rows.map((r) => r.score.entityAccuracy));
      const alphanumericAccuracy = avg(rows.map((r) => r.score.alphanumericAccuracy));
      const latencyFirstPartialMs = avg(rows.map((r) => r.score.latencyFirstPartialMs));
      const latencyFinalMs = avg(rows.map((r) => r.score.latencyFinalMs));
      const costPerMinute = avg(rows.map((r) => r.score.costPerMinute));
      const diarizationScore = avg(rows.map((r) => r.score.diarizationScore));
      // avgFlagCount/avgFlagSeverityScore stay the FULL picture (confidence
      // included) for display; avgPeerFlagCount/avgPeerFlagSeverityScore
      // (T-2) are the confidence-free numbers the composite below reads.
      const avgFlagCount = avg(rows.map((r) => r.score.flagCount));
      const avgFlagSeverityScore = avg(
        rows.map((r) => (r.score.flagSeverity === null ? null : severityRank(r.score.flagSeverity as HybridSeverity))),
      );
      const avgPeerFlagCount = avg(rows.map((r) => r.score.peerFlagCount));
      const avgPeerFlagSeverityScore = avg(
        rows.map((r) => (r.score.peerFlagSeverity === null ? null : severityRank(r.score.peerFlagSeverity as HybridSeverity))),
      );
      const flagBadness = avg(rows.map(flagBadnessOf));

      const composite = hybridCompositeScore({
        flagBadness,
        latencyFinalMs,
        costPerMinute,
        maxFlagBadness,
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
        avgFlagCount,
        avgFlagSeverityScore,
        avgPeerFlagCount,
        avgPeerFlagSeverityScore,
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
        avgFlagCount: agg.avgFlagCount,
        avgFlagSeverityScore: agg.avgFlagSeverityScore,
        avgPeerFlagCount: agg.avgPeerFlagCount,
        avgPeerFlagSeverityScore: agg.avgPeerFlagSeverityScore,
        // T-1: real evidence size behind this row -- distinct providers'
        // sampleSize can differ within a group, so this is the group's own
        // scored-call count (rowsForGroup, deduped by call), not any one
        // provider's sampleSize.
        callsScored: new Set(rowsForGroup.map((r) => r.result.callId)).size,
        recommendation:
          agg.composite === null
            ? "Insufficient evidence (no cell succeeded) -- do not rank this provider yet."
            : index === 0
              ? `Leading candidate for ${assistantId ? `this assistant's calls (${vertical})` : `calls with no assistant on file (${vertical})`} -- fewest/least-severe hybrid flags among ready providers. ${confidenceNoteFor(agg.sampleSize)}`
              : `Behind rank 1 on hybrid flag composite (more or more-severe cross-provider/confidence/entity flags). ${confidenceNoteFor(agg.sampleSize)}`,
      })),
    );
  }

  return rankingRows;
}

// RANK-01/FR-S8: aggregate one ad-hoc run's own scores into per-assistant
// rankings, keyed by runId. Unchanged in behavior from before the T-1
// refactor above -- ad-hoc (non-bulk) runs from the Runs page were never
// the part that was wrong; a bulk shard run never calls this (see
// computeRankingsForBulk below).
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
    .select({ result: benchmarkProviderCallResultsTable, score: benchmarkScoresTable })
    .from(benchmarkProviderCallResultsTable)
    .innerJoin(benchmarkScoresTable, eq(benchmarkScoresTable.resultId, benchmarkProviderCallResultsTable.id))
    .where(
      and(
        eq(benchmarkProviderCallResultsTable.runId, runId),
        eq(benchmarkProviderCallResultsTable.status, "ok"),
      ),
    );

  const rows = aggregateRankingRows(results, calls, providers);

  await db.transaction(async (tx) => {
    await tx.delete(benchmarkRankingsTable).where(eq(benchmarkRankingsTable.runId, runId));
    if (rows.length > 0) {
      await tx.insert(benchmarkRankingsTable).values(
        rows.map((row) => ({ ...row, id: randomUUID(), runId, bulkId: null })),
      );
    }
  });
}

// T-1 fix (2026-08-27, base-solidity review): rankings for a BULK, spanning
// every one of its shard runs -- not one shard's ~50 calls. Called instead
// of computeRankingsForRun whenever a finishing run has a bulkId (see
// executeBenchmarkRunInner below). Recomputes from scratch every time any
// shard finishes (idempotent, cheap relative to the provider calls that
// produced the underlying scores), so the LAST shard to finish always
// leaves the complete, correct picture -- serialized per-bulk by an
// advisory lock so two shards finishing at the same instant can't
// interleave the delete/insert.
export async function computeRankingsForBulk(bulkId: string): Promise<void> {
  const lockClient = await pool.connect();
  try {
    await lockClient.query("SELECT pg_advisory_lock(hashtext($1))", [`bulk-rankings:${bulkId}`]);

    const bulkRuns = await db
      .select({ id: benchmarkRunsTable.id, callIds: benchmarkRunsTable.callIds, providerIds: benchmarkRunsTable.providerIds })
      .from(benchmarkRunsTable)
      .where(eq(benchmarkRunsTable.bulkId, bulkId));
    if (bulkRuns.length === 0) return;

    const runIds = bulkRuns.map((r) => r.id);
    // The most recently CREATED shard run stands in for `runId` on the
    // written rows -- the API response schema requires a run id string, and
    // nothing meaningful reads it as "the one run that produced this" any
    // more (bulkId is the real scope now); it's kept purely so existing
    // consumers (e.g. the CSV filename slicing runId.slice(0,8)) keep
    // working unchanged.
    const [latestRun] = await db
      .select({ id: benchmarkRunsTable.id })
      .from(benchmarkRunsTable)
      .where(inArray(benchmarkRunsTable.id, runIds))
      .orderBy(desc(benchmarkRunsTable.createdAt))
      .limit(1);
    const representativeRunId = latestRun?.id ?? runIds[0]!;

    const allCallIds = [...new Set(bulkRuns.flatMap((r) => r.callIds))];
    const allProviderIds = [...new Set(bulkRuns.flatMap((r) => r.providerIds))];

    const [calls, providers] = await Promise.all([
      db.select().from(benchmarkCallsTable).where(inArray(benchmarkCallsTable.id, allCallIds)),
      db.select().from(benchmarkProvidersTable).where(inArray(benchmarkProvidersTable.id, allProviderIds)),
    ]);
    const results = await db
      .select({ result: benchmarkProviderCallResultsTable, score: benchmarkScoresTable })
      .from(benchmarkProviderCallResultsTable)
      .innerJoin(benchmarkScoresTable, eq(benchmarkScoresTable.resultId, benchmarkProviderCallResultsTable.id))
      .where(
        and(
          inArray(benchmarkProviderCallResultsTable.runId, runIds),
          eq(benchmarkProviderCallResultsTable.status, "ok"),
        ),
      );

    const rows = aggregateRankingRows(results, calls, providers);

    await db.transaction(async (tx) => {
      await tx.delete(benchmarkRankingsTable).where(eq(benchmarkRankingsTable.bulkId, bulkId));
      if (rows.length > 0) {
        await tx.insert(benchmarkRankingsTable).values(
          rows.map((row) => ({ ...row, id: randomUUID(), runId: representativeRunId, bulkId })),
        );
      }
    });
  } finally {
    await lockClient.query("SELECT pg_advisory_unlock(hashtext($1))", [`bulk-rankings:${bulkId}`]);
    lockClient.release();
  }
}

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
