import { createHash, randomUUID } from "node:crypto";
import { and, desc, eq, inArray, ne, sql } from "drizzle-orm";
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
  normalizeTranscript,
  type HybridSeverity,
} from "@workspace/scoring";
import {
  ProviderConfigError,
  failureClassOf,
  getProviderAdapter,
  getProviderApiModel,
  isFailureClass,
  isRetryableFailureClass,
  type FailureClass,
  type ProviderTranscribeResult,
  vendorOfProviderId,
} from "@workspace/stt-providers";
import { logger } from "./logger";
import { writeAudit } from "./audit";
import { refreshBulkStatus } from "./bulk-status";
import { getOrCacheAudioBytes, readCellAudioSource, type CellAudio, type CellAudioSource } from "./audio-cache";
import { computeHybridFlagsForRun } from "./hybrid-flagging";
import { runAutoAgentVerificationForRun } from "./agent-verify";
import { drainWithConcurrency, envInt } from "./concurrency";

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
// T-110: keyed by VENDOR (the rate limit is the vendor's, whichever model
// row is running), so a T-104 model row inherits its vendor's slot count.
const VENDOR_CONCURRENCY_OVERRIDES: Record<string, number> = {
  deepgram: 8,
  assemblyai: 6,
  openai: 4,
  elevenlabs: 4,
  gladia: 4,
  speechmatics: 4,
  cartesia: 2,
};

function baseConcurrencyFor(providerId: string): number {
  return VENDOR_CONCURRENCY_OVERRIDES[vendorOfProviderId(providerId)] ?? PROVIDER_CONCURRENCY;
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

  // M-5: which audio channel THIS run transcribes from, decided once here.
  // Wanting the caller-only track and REFUSING to run without it are two
  // different things, and conflating them would fail every ad-hoc run over
  // the 56 corpus calls whose caller track was never rescued:
  //
  //   ad-hoc run              prefer, do not require -- best channel per
  //                           call, recording which one it got
  //   bulk requireCustomerAudio  prefer AND require -- every cell of the
  //                           bulk is the same channel, so its rankings
  //                           compare like with like
  //   bulk without it         neither: the mono mix, byte-for-byte the
  //                           pre-M-5 behaviour, so a bulk saved before
  //                           this step keeps producing its own numbers
  let runPrefersCustomer = true;
  let runRequiresCustomer = false;
  if (run.bulkId) {
    const [bulk] = await db
      .select({ selectionCriteria: benchmarkBulksTable.selectionCriteria })
      .from(benchmarkBulksTable)
      .where(eq(benchmarkBulksTable.id, run.bulkId))
      .limit(1);
    runPrefersCustomer = bulk?.selectionCriteria.requireCustomerAudio === true;
    runRequiresCustomer = runPrefersCustomer;
  }

  const alreadyOk = new Set(
    existingResults
      .filter((r) => r.status === "ok")
      .map((r) => `${r.providerId}::${r.callId}`),
  );

  // T-43: a cell whose last attempt failed for a reason a re-run cannot
  // change must not be attempted again. Before this, `alreadyOk` was the
  // only skip condition, so every retry re-sent the retention-expired and
  // 403-audio cells to a paid provider, once per retry, forever -- they
  // fail identically every time, and every one of those attempts is billed.
  // T-07 hid the button when a bulk had nothing BUT permanent failures, but
  // on a mixed bulk the button is (correctly) enabled and the executor then
  // re-billed the dead cells alongside the live ones. The refusal has to
  // live here, at the one place that spends the money.
  //
  // Null class is treated as permanent too, deliberately: a null means the
  // row predates classification (T-06) and nothing ever established that it
  // could succeed. That matches exactly what the UI already tells the user
  // about those cells -- one judgement, `isRetryableFailureClass`, drives
  // the breakdown, the button and now the executor, so they cannot drift.
  // `unknown` is NOT null and stays retryable: it was classified, the cause
  // just is not identified yet. A stored value outside the enum entirely
  // (physically possible -- the column has no CHECK constraint) falls on the
  // permanent side for the same reason a null does, and the same way the
  // bulk's failure breakdown already folds it into the unclassified bucket.
  //
  // Decided on the LATEST row per cell, not on any row: duplicate rows for
  // one (provider, call) pair exist in history (see the stale-row cleanup
  // below for how they got there), and the current state of a cell is its
  // most recent attempt.
  const latestByCell = new Map<string, (typeof existingResults)[number]>();
  for (const result of existingResults) {
    const key = `${result.providerId}::${result.callId}`;
    const previous = latestByCell.get(key);
    if (!previous || result.createdAt > previous.createdAt) latestByCell.set(key, result);
  }
  const permanentlyFailed = new Set(
    [...latestByCell.entries()]
      .filter(
        ([key, result]) =>
          result.status === "failed" &&
          !alreadyOk.has(key) &&
          !(isFailureClass(result.failureClass) && isRetryableFailureClass(result.failureClass)),
      )
      .map(([key]) => key),
  );
  if (permanentlyFailed.size > 0) {
    logger.info(
      { runId, permanentlyFailedCells: permanentlyFailed.size },
      "T-43: skipping cells whose recorded failure a re-run cannot fix",
    );
  }

  // Found live 2026-08-25: every retry re-inserted a brand-new row for any
  // cell that was NOT "ok" (e.g. the permanently-broken bucket-403 cells --
  // see docs/backlog/good-to-have.md), instead of replacing the stale
  // attempt. A run retried twice left 3 rows for the same (provider, call)
  // pair -- /results ballooned with duplicate "failed" rows, and nothing
  // ever cleaned them up. A non-"ok" row is safe to clear first *because*
  // it is about to be re-attempted and replaced -- ON DELETE CASCADE on
  // benchmark_scores.result_id means this can never orphan a real score
  // (only "ok" rows have scores, and "ok" rows are never in this set).
  //
  // T-43: that reasoning stops holding for a permanently-failed cell, which
  // is no longer re-attempted. Deleting its row would erase the only record
  // that the cell was ever tried and why -- the failure would vanish from
  // /results and from the bulk's failure breakdown instead of staying
  // visible. So those rows are excluded here and left exactly as they are.
  const staleResultIds = existingResults
    .filter((r) => r.status !== "ok" && !permanentlyFailed.has(`${r.providerId}::${r.callId}`))
    .map((r) => r.id);
  if (staleResultIds.length > 0) {
    await db
      .delete(benchmarkProviderCallResultsTable)
      .where(inArray(benchmarkProviderCallResultsTable.id, staleResultIds));
  }

  // 2026-08-27, per Abhishek's explicit decision: the de-identification gate
  // is removed. A bulk shard used to skip every call that wasn't
  // ready_to_run and record it as skipped_pending_review; with the gate gone
  // there is nothing to skip, so every selected call runs.
  //
  // skipped_pending_review remains a valid result status so historical rows
  // (and the manifest/progress code that reads them) still make sense -- it
  // is simply never written any more.
  //
  // T-43: a call every one of whose cells is already done (succeeded, or
  // permanently failed) is dropped here as well, so the audio pre-pass
  // below never resolves and downloads audio for a call there is nothing
  // left to run -- that resolution is itself a Vapi request per call.
  const isCellLive = (providerId: string, callId: string): boolean => {
    const key = `${providerId}::${callId}`;
    return !alreadyOk.has(key) && !permanentlyFailed.has(key);
  };
  const runnableCalls = calls.filter((call) =>
    providers.some((provider) => isCellLive(provider.id, call.id)),
  );
  const skippedCells: number = 0;

  let failedCells = 0;
  let configBlockedCells = 0;
  let okCells = alreadyOk.size;
  // Not re-attempted, but they ARE failed cells of this run: counted so the
  // run's final status and audit record stay honest about them, and so a
  // run left with nothing but permanent failures still finalizes as
  // "failed" rather than as an untouched "complete".
  const permanentlyFailedCells = permanentlyFailed.size;

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
  const audioStatusByCallId = new Map<
    string,
    { ok: boolean; error: string | null; failureClass: FailureClass | null }
  >();
  await drainWithConcurrency(runnableCalls, Math.min(RUN_CONCURRENCY, 8), async (call) => {
    if (!call.audioObjectPath) {
      audioStatusByCallId.set(call.id, {
        ok: false,
        error: "Call has no audioObjectPath to send to a provider.",
        // Nothing was ever imported for this call. Not a transport failure
        // and not retention -- left visible as unclassified.
        failureClass: "unknown",
      });
      return;
    }
    try {
      await audioResolver(call); // warms the disk cache; bytes discarded here on purpose
      audioStatusByCallId.set(call.id, { ok: true, error: null, failureClass: null });
    } catch (err) {
      audioStatusByCallId.set(call.id, {
        ok: false,
        error: `Could not get this call's audio: ${err instanceof Error ? err.message : String(err)}`,
        // T-06: read off the error the resolver threw (VapiRequestError /
        // VapiNoRecordingError / the audio fetch's ClassifiedError all
        // carry one), never parsed back out of the sentence above.
        failureClass: failureClassOf(err) ?? "unknown",
      });
    }
  });

  /** Reads one cell's audio bytes right before it's needed -- disk cache
   * first (cheap; warmed by the pre-pass above for the production
   * getOrCacheAudioBytes resolver), falling back to audioResolver(call)
   * directly so a test/rehearsal's substitute resolver (which may not write
   * to the standard disk cache at all) still works unchanged.
   *
   * M-5: also says WHICH channel the bytes came from, and refuses to
   * quietly substitute. A run that wants the caller-only track and cannot
   * find it fails the cell here, before the provider is called (so it costs
   * nothing) -- selection already excluded those calls, so reaching this is
   * a file disappearing mid-run, not a normal path. The alternative,
   * transcribing the mono mix and filing the number under a customer-channel
   * bulk, is the mixing this whole step exists to end. */
  async function readCellAudio(call: BenchmarkCallRow): Promise<CellAudio> {
    let audio: CellAudio;
    try {
      audio = await readCellAudioSource(call.id, { preferCustomer: runPrefersCustomer });
    } catch {
      if (runRequiresCustomer) {
        throw new Error(
          `this run reads the customer channel, but ${call.id} has no audio on disk at all`,
        );
      }
      // Nothing cached: the pre-M-5 fallback, unchanged -- a test or
      // rehearsal resolver that never writes to the standard disk cache
      // still works, and its bytes are the mono mix by definition.
      return { bytes: await audioResolver(call), source: "mono" };
    }
    if (runRequiresCustomer && audio.source !== "customer") {
      throw new Error(
        `this run reads the customer channel, but ${call.id} has no <callId>.customer.audio on disk`,
      );
    }
    return audio;
  }

  // Materialize the full cell list up front so progress logging has a real
  // denominator and the worker pool drains a flat queue instead of a nested
  // loop. Cells whose audio never resolved are failed immediately without
  // occupying a provider slot.
  const cells: Array<{ call: BenchmarkCallRow; provider: BenchmarkProviderRow }> = [];
  for (const call of runnableCalls) {
    const status = audioStatusByCallId.get(call.id) ?? {
      ok: false,
      error: "Audio resolution skipped.",
      failureClass: "unknown" as FailureClass,
    };
    for (const provider of providers.filter((p) => isCellLive(p.id, call.id))) {
      if (!status.ok) {
        await insertResult(runId, call.id, provider.id, {
          status: "failed",
          submittedAt: new Date(),
          finalAt: new Date(),
          httpStatus: null,
          hypothesisTranscript: null,
          rawOutput: null,
          errorMessage: status.error,
          failureClass: status.failureClass ?? "unknown",
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
  // T-45: which calls gained a NEW successful cell during this execution.
  // Passed to the agent pass so a re-execution only re-judges a call whose
  // evidence actually changed -- a call whose ok cells all predate this
  // execution already has its scan row and re-judging it is pure OpenAI
  // spend for an answer we already hold.
  const callIdsWithNewEvidence = new Set<string>();
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
          // Cancelled is not failed -- nothing went wrong to classify.
          failureClass: null,
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
      const audio = await readCellAudio(call);
      const outcome = await runCell(runId, call, provider, audio);
      if (outcome === "ok") {
        okCells += 1;
        callIdsWithNewEvidence.add(call.id);
      } else if (outcome === "config_blocked") configBlockedCells += 1;
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
          failureClass: failureClassOf(err) ?? "unknown",
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

  // 2026-08-27, per Abhishek ("bulk calls will also do the agent system
  // working, remove the agent thing, just keep bulk which will do the
  // work"): the OpenAI judge call that used to require a manual click on
  // the Agent page now runs automatically here, for every call that got at
  // least one successful cell in this run. Only fires the LLM call for
  // calls the free hybrid pass actually flagged -- clean calls get a
  // "clean" scan row (coverage evidence) with no OpenAI spend.
  //
  // T-45: on a re-execution, only calls whose evidence changed in THIS
  // execution (a new ok cell) or that have no finished scan for this run yet
  // are verified -- see runAutoAgentVerificationForRun for the exact rule.
  try {
    await runAutoAgentVerificationForRun(runId, actorLabel, { callIdsWithNewEvidence });
  } catch (err) {
    logger.error({ err, runId }, "Failed to run automatic agent verification for run");
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
  // T-43: said separately from the line above, because the line above is a
  // promise that retrying helps -- and for these cells it does not. They
  // were not attempted this time and will not be attempted by any future
  // retry either; their existing rows are the record of why.
  if (permanentlyFailedCells > 0) {
    notes.push(
      `${permanentlyFailedCells} cell(s) left as they were: their recorded failure cannot be fixed by re-running (expired retention, forbidden audio URL, undecodable audio, or a failure that predates classification).`,
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
  // T-43 includes permanentlyFailedCells here on purpose: those cells WERE
  // attempted (on an earlier execution) and did fail. Leaving them out
  // would let a re-execution of a run whose every remaining cell is
  // permanently dead read attemptedCells === 0 -- "nothing was attempted,
  // so nothing failed" -- and finalize as "complete".
  const attemptedCells = okCells + failedCells + configBlockedCells + permanentlyFailedCells;
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
    afterState: { status: finalStatus, okCells, failedCells, permanentlyFailedCells, configBlockedCells, skippedCells, cancelledCells, totalCells },
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
// to benchmark_provider_call_results makes the attempt committed history.
// Replacement semantics live in upsertResult() (T-27: one row per cell, the
// database enforces it) plus the stale-row cleanup at run start.
async function runCell(
  runId: string,
  call: BenchmarkCallRow,
  provider: BenchmarkProviderRow,
  audio: CellAudio,
): Promise<"ok" | "failed" | "config_blocked"> {
  const { bytes: audioBytes, source: audioSource } = audio;
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
      // A missing adapter is our own gap, not any of the runtime failure
      // modes this enum names. Visible as unclassified.
      failureClass: "unknown",
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
        // One adapter serves every model that vendor exposes; the catalog
        // says which model string this provider row means. Undefined for
        // rows the catalog doesn't cover, where the adapter keeps using its
        // own historical default -- so existing rows are unaffected.
        model: getProviderApiModel(provider.id),
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
        // Whichever of the two produced this outcome already said what kind
        // of failure it was: an adapter result carries `failureClass`, a
        // thrown error carries it on the error object. Neither is re-read
        // out of `message`.
        failureClass:
          failureClassOf(err) ??
          lastTransient.result?.failureClass ??
          "unknown",
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

    const resultRow = await upsertResult(runId, call.id, provider.id, {
      // M-5: the channel these bytes actually came from, recorded by the
      // code that opened the file -- never re-derived later from what
      // happens to be in the cache directory by then.
      audioSource,
      status: result.status,
      submittedAt,
      firstPartialAt,
      finalAt,
      httpStatus: result.httpStatus,
      hypothesisTranscript: result.hypothesisTranscript,
      rawOutput: rawOutputString,
      rawOutputHash,
      errorMessage: result.errorMessage,
      // Straight from the adapter, which set it where the failure
      // happened. Null when the cell succeeded.
      failureClass: result.status === "ok" ? null : (result.failureClass ?? "unknown"),
    });

    if (!resultRow) {
      // T-27: the cell key already holds an "ok" row written by someone
      // else (a concurrent execution of the same run -- the documented
      // no-job-queue race). That row and its score are the record; this
      // attempt's output is dropped rather than stacked beside it. The
      // provider was still billed for this attempt, which is exactly the
      // waste the race causes -- nothing here can undo that, only keep
      // it from corrupting the data.
      logger.warn(
        { runId, providerId: provider.id, callId: call.id },
        "T-27: cell already recorded ok by another writer; discarding duplicate attempt",
      );
      return "ok";
    }

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
      // costMicrocents is the same value, correctly named, added alongside
      // rather than replacing the column above so nothing reading
      // costPerMinute today breaks. T-01 (2026-08-28): this used to be
      // `Math.round(costForThisCell * 100)` -- integer cents, so a typical
      // ~0.92c cell was recorded as 1c, an ~8% error compounding across
      // every cell. costForThisCell is in DOLLARS, so $1 = 1,000,000
      // microcents.
      costMicrocents: Math.round(costForThisCell * 1_000_000),
      diarizationScore: result.diarizationScore,
      detail,
    });

    return "ok";
  } catch (err) {
    // Persistence/scoring errors are not retried (see phase comment), but a
    // crash here must still leave a visible failed row instead of silently
    // dropping the cell.
    try {
      // T-27: this is the one place an existing "ok" row may be replaced --
      // it is our own row from a few lines up, and its transcript stored
      // fine but never got a score. Before the unique key this stacked a
      // second, "failed" row beside the "ok" one and the cell read as both.
      await insertResult(
        runId,
        call.id,
        provider.id,
        {
          status: "failed",
          submittedAt: new Date(),
          finalAt: new Date(),
          httpStatus: null,
          hypothesisTranscript: null,
          rawOutput: null,
          errorMessage: `Persisted transcription but failed to store/score it: ${err instanceof Error ? err.message : String(err)}`,
          // Our own bookkeeping broke after the provider had already
          // answered. None of the provider-side classes fit.
          failureClass: "unknown",
        },
        { replaceOk: true },
      );
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
    /**
     * T-06. Required, not optional, on purpose: making this a mandatory
     * field means a new failure path cannot be added without the author
     * having to state what kind of failure it is. `null` is the correct
     * value for a non-failure row, and "unknown" the correct value for a
     * failure nobody has classified -- but both have to be chosen.
     */
    failureClass: FailureClass | null;
  },
  options: { replaceOk?: boolean } = {},
): Promise<void> {
  const rawOutputString = fields.rawOutput === null ? null : JSON.stringify(fields.rawOutput);
  await upsertResult(
    runId,
    callId,
    providerId,
    {
      status: fields.status,
      submittedAt: fields.submittedAt,
      firstPartialAt: null,
      finalAt: fields.finalAt,
      httpStatus: fields.httpStatus,
      hypothesisTranscript: fields.hypothesisTranscript,
      rawOutput: rawOutputString,
      rawOutputHash: rawOutputString
        ? createHash("sha256").update(rawOutputString).digest("hex")
        : null,
      errorMessage: fields.errorMessage,
      failureClass: fields.failureClass,
      // M-5: every row this writer produces is a failure, a cancellation or
      // a skip -- no audio was ever transcribed, so there is no channel to
      // name. Null here means "no transcription happened", which is a
      // different thing from the null on pre-M-5 rows (those are mono); the
      // status column is what tells them apart.
      audioSource: null,
    },
    options,
  );
}

type CellResultFields = Pick<
  typeof benchmarkProviderCallResultsTable.$inferInsert,
  | "status"
  | "submittedAt"
  | "firstPartialAt"
  | "finalAt"
  | "httpStatus"
  | "hypothesisTranscript"
  | "rawOutput"
  | "rawOutputHash"
  | "errorMessage"
  | "failureClass"
  | "audioSource"
>;

// T-27: the single writer for benchmark_provider_call_results. The table
// carries a unique key on (run_id, call_id, provider_id), so a cell is a
// slot that gets overwritten, never a log that gets appended to. Rules:
//
//   * A row that is not "ok" is always replaced by the newer attempt --
//     that is what "retry the failed cells" means.
//   * A row that IS "ok" is never replaced by default. An "ok" row owns a
//     benchmark_scores row and is the evidence every ranking reads; a
//     later "failed" (or a second "ok" from a concurrent executor) must
//     not clobber it. The caller sees `undefined` back and decides.
//   * `replaceOk` opts out of that guard, for the one caller that is
//     overwriting its own just-written row (transcript stored, scoring
//     blew up -- the cell genuinely is failed).
//
// `id` is kept on update so nothing that already references the row (a
// score, an agent pick) dangles; `created_at` is moved to the new attempt's
// time so "latest attempt" reads stay meaningful.
export async function upsertResult(
  runId: string,
  callId: string,
  providerId: string,
  fields: CellResultFields,
  options: { replaceOk?: boolean } = {},
): Promise<typeof benchmarkProviderCallResultsTable.$inferSelect | undefined> {
  const t = benchmarkProviderCallResultsTable;
  const [row] = await db
    .insert(t)
    .values({ runId, callId, providerId, ...fields })
    .onConflictDoUpdate({
      target: [t.runId, t.callId, t.providerId],
      set: {
        status: sql`excluded.status`,
        submittedAt: sql`excluded.submitted_at`,
        firstPartialAt: sql`excluded.first_partial_at`,
        finalAt: sql`excluded.final_at`,
        httpStatus: sql`excluded.http_status`,
        hypothesisTranscript: sql`excluded.hypothesis_transcript`,
        rawOutput: sql`excluded.raw_output`,
        rawOutputHash: sql`excluded.raw_output_hash`,
        errorMessage: sql`excluded.error_message`,
        failureClass: sql`excluded.failure_class`,
        // A replaced attempt's on-demand diagnosis described the old
        // failure, not this one.
        failureDiagnosis: null,
        failureSuggestedFix: null,
        createdAt: sql`excluded.created_at`,
      },
      ...(options.replaceOk ? {} : { setWhere: ne(t.status, "ok") }),
    })
    .returning();
  return row;
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
  audioSource?: CellAudioSource,
): Array<Omit<typeof benchmarkRankingsTable.$inferInsert, "id" | "runId" | "bulkId">> {
  const callById = new Map(calls.map((c) => [c.id, c]));
  // M-5: a bulk's ranking is computed only from cells read off the channel
  // that bulk declares. Without this, re-executing a customer-channel bulk
  // over cells an earlier (pre-M-5, mono) execution left behind would
  // average the two together and present the result as one number.
  // Undefined = no filter, which is what an ad-hoc run wants: its cells may
  // legitimately mix, because a call with no rescued caller track still
  // runs on the mono mix. That mixing is across CALLS, never across the
  // providers being compared -- every provider gets the same bytes for a
  // given call -- so the provider-vs-provider comparison stays honest.
  // Pre-M-5 rows carry null; those runs all read the mono mix, which is what
  // null means here and nowhere else in this file.
  const onChannel =
    audioSource === undefined
      ? results
      : results.filter((r) => (r.result.audioSource ?? "mono") === audioSource);
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
    const rowsForGroup = onChannel.filter(
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
    // T-61: score.costPerMinute on a CELL is that cell's whole cost (rate x
    // this call's duration -- mislabeled since T-11), so averaging it gave a
    // "per minute" that moved with call length (AssemblyAI 0.0036-0.0348
    // across groups against a $0.006 list price). The ranking's number is
    // now a real rate: this provider's total spend in the group over the
    // group's total audio minutes, in dollars. costMicrocents is the exact
    // unit (T-01); cells scored before it exist fall back to the per-cell
    // dollar figure, which is the same quantity.
    const dollarsPerMinuteFor = (rows: typeof rowsForGroup): number | null => {
      let dollars = 0;
      let minutes = 0;
      for (const r of rows) {
        const cellDollars = r.score.costMicrocents !== null ? r.score.costMicrocents / 1_000_000 : r.score.costPerMinute;
        const seconds = callById.get(r.result.callId)?.durationSeconds ?? 0;
        if (cellDollars === null || seconds <= 0) continue;
        dollars += cellDollars;
        minutes += seconds / 60;
      }
      return minutes > 0 ? dollars / minutes : null;
    };
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
    const dollarsPerMinuteByProvider = new Map([...byProvider.entries()].map(([id, rows]) => [id, dollarsPerMinuteFor(rows)]));
    const maxCostPerMinute = Math.max(0, ...[...dollarsPerMinuteByProvider.values()].map((v) => v ?? 0));

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
      const costPerMinute = dollarsPerMinuteByProvider.get(providerId) ?? null;
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

      // T-19: rates. Only cells that actually carry a peer flag count take
      // part (a cell scored before hybrid flagging has null there and
      // must not read as a clean call). Word basis = this provider's own
      // normalised transcript, the same tokenisation the flags came from.
      const flaggedCells = rows.filter((r) => r.score.peerFlagCount !== null);
      const totalPeerFlags = flaggedCells.reduce((sum, r) => sum + (r.score.peerFlagCount ?? 0), 0);
      const totalWords = flaggedCells.reduce(
        (sum, r) => sum + normalizeTranscript(r.result.hypothesisTranscript ?? "").split(" ").filter(Boolean).length,
        0,
      );
      const peerFlagsPer100Words = totalWords > 0 ? (totalPeerFlags / totalWords) * 100 : null;
      const cleanCallRate = flaggedCells.length
        ? flaggedCells.filter((r) => r.score.peerFlagCount === 0).length / flaggedCells.length
        : null;

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
        peerFlagsPer100Words,
        cleanCallRate,
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
        peerFlagsPer100Words: agg.peerFlagsPer100Words,
        cleanCallRate: agg.cleanCallRate,
        // T-1: real evidence size behind this row -- distinct providers'
        // sampleSize can differ within a group, so this is the group's own
        // scored-call count (rowsForGroup, deduped by call), not any one
        // provider's sampleSize.
        callsScored: new Set(rowsForGroup.map((r) => r.result.callId)).size,
        recommendation:
          agg.composite === null
            ? "Insufficient evidence (no cell succeeded) -- do not rank this provider yet."
            : index === 0
              // 2026-08-27, per Abhishek ("remove the property management
              // term ... it's in the decision logic"): the raw vertical enum
              // (e.g. "property_management") used to be embedded in this
              // sentence -- an internal code name leaking into what's meant
              // to read as a clean, market-standard recommendation, and
              // redundant with the assistant name already shown above it.
              // Dropped entirely rather than reformatted; vertical stays
              // available in the CSV export for anyone who needs it.
              ? `Leading candidate for ${assistantId ? "this assistant's calls" : "calls with no assistant on file"} -- fewest/least-severe hybrid flags among ready providers. ${confidenceNoteFor(agg.sampleSize)}`
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

    const [bulk] = await db
      .select({ selectionCriteria: benchmarkBulksTable.selectionCriteria })
      .from(benchmarkBulksTable)
      .where(eq(benchmarkBulksTable.id, bulkId))
      .limit(1);
    const rows = aggregateRankingRows(
      results,
      calls,
      providers,
      bulk?.selectionCriteria.requireCustomerAudio === true ? "customer" : "mono",
    );

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
