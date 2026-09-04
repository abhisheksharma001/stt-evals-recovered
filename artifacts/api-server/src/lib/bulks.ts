import { promises as fs } from "node:fs";
import { and, asc, eq, inArray } from "drizzle-orm";
import {
  benchmarkAgentScansTable,
  benchmarkBulksTable,
  benchmarkCallsTable,
  benchmarkProviderCallResultsTable,
  benchmarkProvidersTable,
  benchmarkRankingsTable,
  benchmarkRunsTable,
  db,
  type BenchmarkBulkRow,
  type BulkSelectionCriteria,
} from "@workspace/db";
import { buildRunManifest } from "./manifest";
import { isFailureClass, isRetryableFailureClass } from "@workspace/stt-providers";
import { executeBenchmarkRun, requestRunCancellation } from "./run-executor";
import { drainWithConcurrency, envInt } from "./concurrency";
import { audioCachePathFor } from "./audio-cache";
import { VAPI_RETENTION_WINDOW_DAYS } from "./vapi-retention";
import { writeAudit } from "./audit";
import { logger } from "./logger";
import { resolveProductionProviderId } from "./verdict";
import { describeEmptySelection, type SelectionExclusion } from "./empty-selection";

// 2026-08-27, per Abhishek ("let's not take the calls which are 14 days
// back, so we never encounter this problem again"): matches the warning
// threshold already shown in Corpus's RetentionWarning UI and the
// `retention_expired` known-cause text in lib/agent.ts's KNOWN_FAILURE_BY_CLASS --
// one number, not three independent guesses at the same Vapi plan limit.

// T-6 fix (2026-08-27, base-solidity review): launchBulk used to fire EVERY
// shard run at once (`void executeBenchmarkRun(...)` in a plain loop). A
// 1,000-call bulk at the default shardSize 50 is 20 shards -- 20 concurrent
// executeBenchmarkRunInner calls, each independently hitting the (now
// module-level singleton, see run-executor.ts) per-provider semaphores.
// Capping how many SHARDS run at once bounds how much of the corpus is
// simultaneously in flight, on top of the per-provider vendor cap.
const BULK_SHARD_CONCURRENCY = envInt("BULK_SHARD_CONCURRENCY", 3, 8);

// FR-BLK-10: hard cap on live bulks. The oldest bulk is evicted (its runs,
// results, scores, rankings go with it -- all regenerable); the corpus itself
// is never touched by eviction.
export const MAX_LIVE_BULKS = 3;

// FR-BLK-5 cost gate, env-tunable. $50 default: at planning prices a
// 1,000-call x 2min x 7-provider bulk is ~$84, so the default gates exactly
// the class of launch this gate exists for.
export const BULK_COST_THRESHOLD_CENTS = (() => {
  const raw = process.env.BULK_COST_THRESHOLD_CENTS;
  const parsed = raw ? Number.parseInt(raw, 10) : NaN;
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 5000;
})();

export class BulkSelectionEmptyError extends Error {}
export class BulkNameConflictError extends Error {}

// drizzle wraps driver errors in DrizzleQueryError, so the pg code lives on
// .cause, not on the thrown error itself (found live: a template's second
// same-day launch 500'd instead of 409-ing on the unique name index).
export function isUniqueViolation(err: unknown): boolean {
  const direct = (err as { code?: string }).code;
  const cause = (err as { cause?: { code?: string } }).cause?.code;
  return direct === "23505" || cause === "23505";
}

/** Resolves a (possibly relative) criteria window to concrete bounds. */
export function resolveDateWindow(
  criteria: BulkSelectionCriteria,
  now: Date = new Date(),
): { from?: Date; to?: Date } {
  if (criteria.lastNDays && criteria.lastNDays > 0) {
    return {
      from: new Date(now.getTime() - criteria.lastNDays * 24 * 60 * 60 * 1000),
      to: now,
    };
  }
  return {
    from: criteria.startedAtFrom ? new Date(criteria.startedAtFrom) : undefined,
    to: criteria.startedAtTo ? new Date(criteria.startedAtTo) : undefined,
  };
}

/**
 * Turns selection criteria into concrete corpus call ids. Selects from the
 * ALREADY-IMPORTED corpus (benchmark_calls) -- a bulk never talks to Vapi
 * directly; importing is the Import page's job (COR-01).
 */
export type ResolvedCriteriaCallIds = {
  callIds: string[];
  // 2026-08-27, per Abhishek: calls this old only cost real provider money
  // to fail identically on every provider (Vapi can never re-issue a URL
  // past its retention window, confirmed live: 45 failed cells on one bulk,
  // all "retention window" or the known archive-bucket 403, zero of them
  // provider-specific). Excluded from selection rather than left to fail --
  // UNLESS a run already cached this call's audio to local disk before it
  // aged out (audio-cache.ts), in which case Vapi's retention window
  // doesn't matter any more and the call is still perfectly runnable.
  excludedRetentionExpiredCount: number;
};

// T-10: default duration band. Below 60s a call is mostly greeting and
// hang-up; above 120s the gold-review cost per call climbs fast. Both are
// overridable per bulk; `maxDurationSeconds: null` means no cap.
export const DEFAULT_MIN_DURATION_SECONDS = 60;
export const DEFAULT_MAX_DURATION_SECONDS = 120;

export class BulkDurationBandError extends Error {}

/** Resolve the (min, max) band from explicit input, criteria, then defaults. */
export function resolveDurationBand(input: {
  minDurationSeconds?: number;
  maxDurationSeconds?: number | null;
  criteria: BulkSelectionCriteria;
}): { min: number; max: number | null } {
  const min =
    input.minDurationSeconds ??
    input.criteria.minDurationSeconds ??
    DEFAULT_MIN_DURATION_SECONDS;
  const max =
    input.maxDurationSeconds !== undefined
      ? input.maxDurationSeconds
      : input.criteria.maxDurationSeconds !== undefined
        ? input.criteria.maxDurationSeconds
        : DEFAULT_MAX_DURATION_SECONDS;
  if (max !== null && max < min) {
    throw new BulkDurationBandError(
      `maxDurationSeconds (${max}) must be >= minDurationSeconds (${min})`,
    );
  }
  return { min, max };
}

// T-14's buckets and M-3b's refusal sentence live in `empty-selection.ts`
// (db-free so they can be unit-tested); re-exported here because this is
// where callers have always imported them from.
export type { SelectionExclusion };

export type ResolvedCriteriaSelection = ResolvedCriteriaCallIds & {
  /** Calls that passed the "who" filters (vertical / assistant / account) or
   *  were explicitly picked -- the pool the exclusions are counted against. */
  inScopeCount: number;
  excluded: SelectionExclusion[];
};

type CandidateRow = {
  id: string;
  durationSeconds: number;
  sourceStartedAt: Date | null;
  sourceEndedReason: string | null;
  sourceSuccessEvaluation: string | null;
};

/**
 * Decides, for one in-scope call, which exclusion bucket it falls into, or
 * null when it is selected. Order matters and is the order a person reads
 * the filters in: date window, duration band, outcome, success evaluation.
 * A call failing several filters is counted once, under the first.
 *
 * This is THE matcher. resolveCriteriaCallIds (bulk creation) and the
 * preview endpoint both go through it, so the count a person sees before
 * launching is the count that gets frozen -- there is no second copy to
 * drift (the UI used to carry one).
 */
function exclusionBucketFor(
  c: CandidateRow,
  criteria: BulkSelectionCriteria,
  window: { from?: Date; to?: Date },
  minDurationSeconds: number,
  maxDurationSeconds: number | null,
): string | null {
  if (window.from || window.to) {
    // A NULL start date never satisfies a gte/lte window -- named on its own
    // so a date-filtered bulk that comes back small says why.
    if (c.sourceStartedAt === null) return "no start date on record";
    if (window.from && c.sourceStartedAt < window.from) return "outside the date window";
    if (window.to && c.sourceStartedAt > window.to) return "outside the date window";
  }
  // FR-SEL-7 / T-10: the duration band.
  if (c.durationSeconds < minDurationSeconds) return `shorter than ${minDurationSeconds}s`;
  if (maxDurationSeconds !== null && c.durationSeconds > maxDurationSeconds) {
    return `longer than ${maxDurationSeconds}s`;
  }
  // T-13: an unknown outcome never passes an outcome filter, and is its own
  // bucket rather than hiding inside a reason it does not have.
  const hasOutcomeFilter = Boolean(
    criteria.includeEndedReasons?.length || criteria.excludeEndedReasons?.length,
  );
  if (hasOutcomeFilter && c.sourceEndedReason === null) return "no captured outcome";
  if (
    criteria.includeEndedReasons?.length &&
    !criteria.includeEndedReasons.includes(c.sourceEndedReason as string)
  ) {
    return `outcome: ${c.sourceEndedReason}`;
  }
  if (
    criteria.excludeEndedReasons?.length &&
    criteria.excludeEndedReasons.includes(c.sourceEndedReason as string)
  ) {
    return `outcome: ${c.sourceEndedReason}`;
  }
  if (criteria.successEvaluation && c.sourceSuccessEvaluation !== criteria.successEvaluation) {
    return c.sourceSuccessEvaluation === null
      ? "no success evaluation"
      : `success evaluation: ${c.sourceSuccessEvaluation}`;
  }
  return null;
}

export async function resolveCriteriaSelection(
  criteria: BulkSelectionCriteria,
  minDurationSeconds: number,
  maxDurationSeconds: number | null,
  now: Date = new Date(),
): Promise<ResolvedCriteriaSelection> {
  // Explicit-picks-only criteria select exactly those calls. The scope query
  // below would otherwise pull the whole corpus under a callIds-only
  // selection (found by the e2e harness: a 5-call explicit bulk came back
  // with 9 calls).
  const hasFilters = Boolean(
    criteria.vertical ||
      criteria.assistantIds?.length ||
      criteria.accountLabel ||
      criteria.lastNDays ||
      criteria.startedAtFrom ||
      criteria.startedAtTo ||
      criteria.includeEndedReasons?.length ||
      criteria.excludeEndedReasons?.length ||
      criteria.successEvaluation,
  );

  const columns = {
    id: benchmarkCallsTable.id,
    durationSeconds: benchmarkCallsTable.durationSeconds,
    sourceStartedAt: benchmarkCallsTable.sourceStartedAt,
    sourceEndedReason: benchmarkCallsTable.sourceEndedReason,
    sourceSuccessEvaluation: benchmarkCallsTable.sourceSuccessEvaluation,
  };

  // Scope = the "who" filters. Everything after (date, band, outcome) is a
  // named exclusion counted against this pool.
  const inScope = new Map<string, CandidateRow>();
  if (hasFilters || !criteria.callIds?.length) {
    const scopeConditions = [
      criteria.vertical ? eq(benchmarkCallsTable.vertical, criteria.vertical) : undefined,
      criteria.assistantIds?.length
        ? inArray(benchmarkCallsTable.sourceAssistantId, criteria.assistantIds)
        : undefined,
      criteria.accountLabel
        ? eq(benchmarkCallsTable.sourceAccountLabel, criteria.accountLabel)
        : undefined,
    ].filter((c) => c !== undefined);
    const rows = await db
      .select(columns)
      .from(benchmarkCallsTable)
      .where(scopeConditions.length ? and(...scopeConditions) : undefined);
    for (const row of rows) inScope.set(row.id, row);
  }

  // Explicit picks merge in unfiltered, exactly as before: a hand-picked
  // call skips the window / band / outcome checks (only the retention pass
  // below still applies, because an uncached expired call cannot run no
  // matter who picked it).
  const explicitIds = new Set<string>();
  if (criteria.callIds?.length) {
    const explicit = await db
      .select(columns)
      .from(benchmarkCallsTable)
      .where(inArray(benchmarkCallsTable.id, criteria.callIds));
    for (const row of explicit) {
      inScope.set(row.id, row);
      explicitIds.add(row.id);
    }
  }

  const window = resolveDateWindow(criteria, now);
  const buckets = new Map<string, number>();
  const bump = (bucket: string) => buckets.set(bucket, (buckets.get(bucket) ?? 0) + 1);
  const passing: CandidateRow[] = [];
  for (const c of inScope.values()) {
    const bucket = explicitIds.has(c.id)
      ? null
      : exclusionBucketFor(c, criteria, window, minDurationSeconds, maxDurationSeconds);
    if (bucket === null) passing.push(c);
    else bump(bucket);
  }

  const retentionCutoff = new Date(now.getTime() - VAPI_RETENTION_WINDOW_DAYS * 24 * 60 * 60 * 1000);
  const callIds: string[] = [];
  let excludedRetentionExpiredCount = 0;
  await Promise.all(
    passing.map(async (c) => {
      const expired = c.sourceStartedAt !== null && c.sourceStartedAt < retentionCutoff;
      if (!expired) {
        callIds.push(c.id);
        return;
      }
      try {
        await fs.access(audioCachePathFor(c.id));
        callIds.push(c.id); // aged out, but already cached -- still runnable
      } catch {
        excludedRetentionExpiredCount += 1;
      }
    }),
  );
  if (excludedRetentionExpiredCount > 0) {
    buckets.set(
      `past Vapi's ${VAPI_RETENTION_WINDOW_DAYS}-day retention window and never cached`,
      excludedRetentionExpiredCount,
    );
  }

  // Stable order: biggest bucket first, ties alphabetical, so the preview
  // reads the same way twice for the same corpus.
  const excluded = [...buckets.entries()]
    .map(([bucket, count]) => ({ bucket, count }))
    .sort((a, b) => b.count - a.count || a.bucket.localeCompare(b.bucket));

  return { callIds, excludedRetentionExpiredCount, inScopeCount: inScope.size, excluded };
}

export async function resolveCriteriaCallIds(
  criteria: BulkSelectionCriteria,
  minDurationSeconds: number,
  maxDurationSeconds: number | null,
  now: Date = new Date(),
): Promise<ResolvedCriteriaCallIds> {
  const { callIds, excludedRetentionExpiredCount } = await resolveCriteriaSelection(
    criteria,
    minDurationSeconds,
    maxDurationSeconds,
    now,
  );
  return { callIds, excludedRetentionExpiredCount };
}

/** Pre-flight cost estimate in cents: total audio minutes x summed per-minute rates. */
export async function estimateBulkCostCents(
  callIds: string[],
  providerIds: string[],
): Promise<number> {
  const calls: Array<{ durationSeconds: number }> = callIds.length
    ? await db
        .select({ durationSeconds: benchmarkCallsTable.durationSeconds })
        .from(benchmarkCallsTable)
        .where(inArray(benchmarkCallsTable.id, callIds))
    : [];
  const providers: Array<{ costPerMinute: number }> = providerIds.length
    ? await db
        .select({ costPerMinute: benchmarkProvidersTable.costPerMinute })
        .from(benchmarkProvidersTable)
        .where(inArray(benchmarkProvidersTable.id, providerIds))
    : [];
  const totalMinutes =
    calls.reduce((sum, c) => sum + c.durationSeconds, 0) / 60;
  const ratePerMinute = providers.reduce((sum, p) => sum + p.costPerMinute, 0);
  return Math.ceil(totalMinutes * ratePerMinute * 100);
}

// 2026-08-27, per Abhishek ("show the openai agent cost ... separately,
// estimated"): the agent judge call only fires for calls the free hybrid
// pass actually flags, so callCount alone can't predict it the way STT cost
// can -- this projects from real history: what fraction of past scans came
// back flagged (or were flagged and since resolved), and what those judge
// calls actually cost.
//
// T-35 (2026-08-29): the placeholder fallback ("assume 30% flag at 0.5c")
// is gone. It was checked against the first real bulks: 4c estimated vs
// 42c actual (56 calls, 56/56 flagged, ~0.75c per judge call). History is
// 244 scans now, so the projection is real; on a database with no scans
// at all this returns null -- "no basis for an estimate", shown as such --
// rather than a number that was wrong by 10x.
//
// T-01 (2026-08-28): reads micro-cents from the scan table (the column it
// used to read was integer cents and never held a value). Returns whole
// CENTS, because a bulk-level estimate is a budget figure a person reads.
export async function estimateBulkAgentCostCents(callCount: number): Promise<number | null> {
  if (callCount === 0) return 0;
  const scans = await db
    .select({ status: benchmarkAgentScansTable.status, judgeCostMicrocents: benchmarkAgentScansTable.judgeCostMicrocents })
    .from(benchmarkAgentScansTable);
  if (scans.length === 0) return null;

  const judgedCount = scans.filter((s) => s.status === "flagged" || s.status === "approved" || s.status === "rejected").length;
  const judgeCosts = scans.map((s) => s.judgeCostMicrocents).filter((c): c is number => c !== null);
  if (judgeCosts.length === 0) return null; // judged, but never priced: nothing to project from
  const flagRate = judgedCount / scans.length;
  const avgJudgeCostMicrocents = judgeCosts.reduce((sum, c) => sum + c, 0) / judgeCosts.length;
  return Math.ceil((callCount * flagRate * avgJudgeCostMicrocents) / 10_000);
}

export type BulkPreviewResult = {
  inScopeCount: number;
  matchedCount: number;
  excluded: SelectionExclusion[];
  estimate: {
    sttCostCents: number;
    /** null = no scan history to project from (T-35); never a guess. */
    agentCostCents: number | null;
    totalCostCents: number;
    overThreshold: boolean;
  } | null;
  costThresholdCents: number;
  /** T-56: for each production transcriber among the matched calls,
   *  whether the provider it maps to is one of the candidates. */
  productionCoverage: { vendor: string; model: string | null; calls: number; providerId: string | null; benchmarked: boolean }[];
};

/**
 * T-14: what createBulkFromCriteria would do, without doing it. Same band
 * resolution, same matcher, same estimators, same threshold -- so the number
 * in the dialog is the number that gets frozen. The estimate is null with no
 * providers: the count is meaningful on its own and is shown first.
 */
export async function previewBulkSelection(input: {
  criteria: BulkSelectionCriteria;
  providerIds?: string[];
  minDurationSeconds?: number;
  maxDurationSeconds?: number | null;
}): Promise<BulkPreviewResult> {
  const { min, max } = resolveDurationBand(input);
  const selection = await resolveCriteriaSelection(input.criteria, min, max);
  const providerIds = input.providerIds ?? [];
  let estimate: BulkPreviewResult["estimate"] = null;
  if (providerIds.length > 0) {
    const sttCostCents = await estimateBulkCostCents(selection.callIds, providerIds);
    const agentCostCents = await estimateBulkAgentCostCents(selection.callIds.length);
    // A null agent estimate is "unknown", not zero; the total is then STT
    // only and the response says so via the null.
    const totalCostCents = sttCostCents + (agentCostCents ?? 0);
    estimate = {
      sttCostCents,
      agentCostCents,
      totalCostCents,
      overThreshold: totalCostCents > BULK_COST_THRESHOLD_CENTS,
    };
  }
  // T-56: the verdict's "vs production" comparison can only fill when
  // production's own provider is a candidate. Say so here, before money.
  const productionCoverage: BulkPreviewResult["productionCoverage"] = [];
  if (selection.callIds.length > 0) {
    const prodRows = await db
      .select({ vendor: benchmarkCallsTable.sourceTranscriberProvider, model: benchmarkCallsTable.sourceTranscriberModel })
      .from(benchmarkCallsTable)
      .where(inArray(benchmarkCallsTable.id, selection.callIds));
    const providerRows = await db
      .select({ id: benchmarkProvidersTable.id, name: benchmarkProvidersTable.name, model: benchmarkProvidersTable.model })
      .from(benchmarkProvidersTable);
    const counts = new Map<string, { vendor: string; model: string | null; calls: number }>();
    for (const r of prodRows) {
      if (!r.vendor) continue;
      const key = `${r.vendor}::${r.model ?? ""}`;
      const entry = counts.get(key) ?? { vendor: r.vendor, model: r.model ?? null, calls: 0 };
      entry.calls += 1;
      counts.set(key, entry);
    }
    for (const entry of [...counts.values()].sort((a, b) => b.calls - a.calls)) {
      const providerId = resolveProductionProviderId(entry.vendor, entry.model, providerRows);
      productionCoverage.push({ ...entry, providerId, benchmarked: providerId !== null && providerIds.includes(providerId) });
    }
  }
  return {
    inScopeCount: selection.inScopeCount,
    matchedCount: selection.callIds.length,
    excluded: selection.excluded,
    estimate,
    costThresholdCents: BULK_COST_THRESHOLD_CENTS,
    productionCoverage,
  };
}

export type CreateBulkResult = {
  bulk: BenchmarkBulkRow;
  launched: boolean;
  evictedBulkId: string | null;
};

/**
 * Shared creation path for POST /bulks and template launches: resolve and
 * freeze the criteria, estimate cost, evict the oldest bulk when at the cap
 * (FR-BLK-10), insert, then either launch immediately or park at
 * awaiting_confirmation behind the cost gate (FR-BLK-5).
 */
export async function createBulkFromCriteria(input: {
  name?: string;
  criteria: BulkSelectionCriteria;
  providerIds: string[];
  shardSize?: number;
  minDurationSeconds?: number;
  maxDurationSeconds?: number | null;
  confirm?: boolean;
  actorLabel: string;
}): Promise<CreateBulkResult> {
  const now = new Date();
  const { min: minDuration, max: maxDuration } = resolveDurationBand(input);
  const shardSize = input.shardSize ?? 50;

  const providers = await db
    .select({ id: benchmarkProvidersTable.id })
    .from(benchmarkProvidersTable)
    .where(inArray(benchmarkProvidersTable.id, input.providerIds));
  if (providers.length !== input.providerIds.length) {
    throw new BulkSelectionEmptyError(
      "one or more provider ids do not exist",
    );
  }

  // M-3b: go through the full selection, not resolveCriteriaCallIds, so a
  // refusal can say WHICH filter emptied it. The buckets already exist (T-14)
  // and the preview endpoint already shows them; the wrapper dropped them, so
  // a person launching a stale template only saw "matched no corpus calls".
  const { callIds, inScopeCount, excluded, excludedRetentionExpiredCount } = await resolveCriteriaSelection(input.criteria, minDuration, maxDuration, now);
  if (callIds.length === 0) {
    throw new BulkSelectionEmptyError(describeEmptySelection(inScopeCount, excluded));
  }

  // FR-BLK-1: freeze. A relative window becomes concrete bounds AND the
  // exact resolved call set -- re-viewing this bulk later never shifts.
  const { from, to } = resolveDateWindow(input.criteria, now);
  const frozenCriteria: BulkSelectionCriteria = {
    ...input.criteria,
    lastNDays: undefined,
    startedAtFrom: from?.toISOString(),
    startedAtTo: to?.toISOString(),
    minDurationSeconds: minDuration,
    maxDurationSeconds: maxDuration,
    resolvedCallIds: callIds,
    resolvedAt: now.toISOString(),
  };

  const estimatedSttCostCents = await estimateBulkCostCents(
    callIds,
    input.providerIds,
  );
  const estimatedAgentCostCents = await estimateBulkAgentCostCents(callIds.length);
  const estimatedCostCents = estimatedSttCostCents + (estimatedAgentCostCents ?? 0);
  const overThreshold = estimatedCostCents > BULK_COST_THRESHOLD_CENTS;
  const name = input.name ?? now.toISOString().slice(0, 10); // FR-BLK-2

  const notesLines: string[] = [];
  if (overThreshold && !input.confirm) {
    notesLines.push(
      `Estimated cost $${(estimatedCostCents / 100).toFixed(2)} (STT $${(estimatedSttCostCents / 100).toFixed(2)} + agent verification ${estimatedAgentCostCents === null ? "unknown, no scan history" : `$${(estimatedAgentCostCents / 100).toFixed(2)}`}) exceeds the $${(BULK_COST_THRESHOLD_CENTS / 100).toFixed(2)} threshold -- confirm to launch (FR-BLK-5).`,
    );
  }
  if (excludedRetentionExpiredCount > 0) {
    notesLines.push(
      `${excludedRetentionExpiredCount} matched call(s) excluded -- past Vapi's ${VAPI_RETENTION_WINDOW_DAYS}-day retention window and never cached, so every provider would fail identically on them.`,
    );
  }

  const { bulk, evictedBulkId } = await db.transaction(async (tx) => {
    // FR-BLK-10: at the cap, evict the oldest in the same transaction.
    // Rankings carry no FK to runs (benchmark_rankings.runId is a bare
    // uuid), so they must be removed explicitly before the cascade.
    let evicted: string | null = null;
    const existing = await tx
      .select({ id: benchmarkBulksTable.id })
      .from(benchmarkBulksTable)
      .orderBy(asc(benchmarkBulksTable.createdAt));
    if (existing.length >= MAX_LIVE_BULKS) {
      const oldest = existing[0];
      // T-1: bulk-scoped ranking rows (computeRankingsForBulk in
      // run-executor.ts) carry bulkId directly now -- delete by that
      // primarily. Also still delete by the runId subquery for any rows
      // written before this change (bulkId null, only runId set).
      await tx.delete(benchmarkRankingsTable).where(eq(benchmarkRankingsTable.bulkId, oldest.id));
      await tx.delete(benchmarkRankingsTable).where(
        inArray(
          benchmarkRankingsTable.runId,
          tx
            .select({ id: benchmarkRunsTable.id })
            .from(benchmarkRunsTable)
            .where(eq(benchmarkRunsTable.bulkId, oldest.id)),
        ),
      );
      // M-3c: benchmark_agent_scans.run_id has no ON DELETE, so a scan row
      // blocks the cascade into benchmark_runs and the whole launch answered
      // 500. The scans were folded into the run executor in e0399cc, after
      // this eviction was written, and nobody came back. Detached, not
      // deleted: a scan is keyed by CALL, the corpus is never touched by
      // eviction, and its judge verdict cost real OpenAI money. Every
      // run-scoped query matches on runId with eq/inArray, so a null runId
      // simply stops matching the run that no longer exists, while the call
      // comparison still finds the verdict by callId.
      // M-3d: and the SAME table's agent_pick_result_id, which points at a
      // result cell that cascades from the run -- the other half of this
      // bug. Checked against pg_constraint rather than guessed: these two
      // are the ONLY foreign keys into the bulk -> runs -> results -> scores
      // cascade that are not themselves ON DELETE CASCADE.
      await tx
        .update(benchmarkAgentScansTable)
        .set({ agentPickResultId: null })
        .where(
          inArray(
            benchmarkAgentScansTable.agentPickResultId,
            tx
              .select({ id: benchmarkProviderCallResultsTable.id })
              .from(benchmarkProviderCallResultsTable)
              .innerJoin(benchmarkRunsTable, eq(benchmarkProviderCallResultsTable.runId, benchmarkRunsTable.id))
              .where(eq(benchmarkRunsTable.bulkId, oldest.id)),
          ),
        );
      await tx
        .update(benchmarkAgentScansTable)
        .set({ runId: null })
        .where(
          inArray(
            benchmarkAgentScansTable.runId,
            tx
              .select({ id: benchmarkRunsTable.id })
              .from(benchmarkRunsTable)
              .where(eq(benchmarkRunsTable.bulkId, oldest.id)),
          ),
        );
      await tx
        .delete(benchmarkBulksTable)
        .where(eq(benchmarkBulksTable.id, oldest.id));
      evicted = oldest.id;
    }

    let inserted: BenchmarkBulkRow;
    try {
      [inserted] = await tx
        .insert(benchmarkBulksTable)
        .values({
          name,
          status:
            overThreshold && !input.confirm
              ? "awaiting_confirmation"
              : "draft",
          selectionCriteria: frozenCriteria,
          providerIds: input.providerIds,
          shardSize,
          minDurationSeconds: minDuration,
          maxDurationSeconds: maxDuration,
          estimatedCostCents,
          estimatedSttCostCents,
          estimatedAgentCostCents,
          launchedByLabel: input.actorLabel,
          notes: notesLines.length > 0 ? notesLines.join("\n") : null,
        })
        .returning();
    } catch (err) {
      if (isUniqueViolation(err)) {
        throw new BulkNameConflictError(`bulk name "${name}" is already in use`);
      }
      throw err;
    }
    return { bulk: inserted, evictedBulkId: evicted };
  });

  await writeAudit({
    entityType: "bulk",
    entityId: bulk.id,
    actorLabel: input.actorLabel,
    action: "create",
    afterState: {
      name: bulk.name,
      status: bulk.status,
      callCount: callIds.length,
      excludedRetentionExpiredCount,
      estimatedCostCents,
      estimatedSttCostCents,
      estimatedAgentCostCents,
      evictedBulkId,
    },
  });

  if (bulk.status === "draft") {
    await launchBulk(bulk.id, input.actorLabel);
    const [refreshed] = await db
      .select()
      .from(benchmarkBulksTable)
      .where(eq(benchmarkBulksTable.id, bulk.id))
      .limit(1);
    return { bulk: refreshed ?? bulk, launched: true, evictedBulkId };
  }
  return { bulk, launched: false, evictedBulkId };
}

/**
 * FR-BLK-3: fan the frozen call set into shards; each shard x providerIds is
 * one ordinary run (purpose "batch") through the existing executor. Runs are
 * created with their immutable manifests (RUN-01) and fired async.
 */
export async function launchBulk(
  bulkId: string,
  actorLabel: string,
): Promise<void> {
  const [bulk] = await db
    .select()
    .from(benchmarkBulksTable)
    .where(eq(benchmarkBulksTable.id, bulkId))
    .limit(1);
  if (!bulk) throw new Error(`bulk ${bulkId} not found`);
  if (bulk.status !== "draft" && bulk.status !== "awaiting_confirmation") {
    throw new Error(`bulk is ${bulk.status}, not launchable`);
  }
  const callIds = bulk.selectionCriteria.resolvedCallIds ?? [];
  if (callIds.length === 0) throw new Error("bulk has no frozen call set");

  const shards: string[][] = [];
  for (let i = 0; i < callIds.length; i += bulk.shardSize) {
    shards.push(callIds.slice(i, i + bulk.shardSize));
  }

  await db
    .update(benchmarkBulksTable)
    .set({ status: "estimating", updatedAt: new Date() })
    .where(eq(benchmarkBulksTable.id, bulkId));

  // Create every shard's run ROW up front (fast: DB inserts only) so the
  // bulk's full shard list exists immediately -- the Bulks/Runs UI can see
  // all N shards as "queued" right away, same as before.
  const runs: (typeof benchmarkRunsTable.$inferSelect)[] = [];
  for (let shardIndex = 0; shardIndex < shards.length; shardIndex++) {
    const shardCallIds = shards[shardIndex];
    const manifest = await buildRunManifest(shardCallIds, bulk.providerIds);
    const [run] = await db
      .insert(benchmarkRunsTable)
      .values({
        status: "queued",
        purpose: "batch",
        bulkId: bulk.id,
        shardIndex,
        providerIds: bulk.providerIds,
        callIds: shardCallIds,
        callCount: shardCallIds.length,
        manifest,
        notes: `Shard ${shardIndex + 1}/${shards.length} of bulk "${bulk.name}".`,
      })
      .returning();
    runs.push(run);
  }

  // T-6 fix: EXECUTION is throttled to BULK_SHARD_CONCURRENCY shards at
  // once, not fired all together -- this whole drain is itself fire-and-
  // forget (launchBulk must return quickly; a 1,000-call bulk can take a
  // long time to fully execute), so it does not block the caller.
  void drainWithConcurrency(runs, BULK_SHARD_CONCURRENCY, async (run) => {
    await executeBenchmarkRun(run.id, actorLabel).catch((err) => {
      logger.error({ err, runId: run.id, bulkId }, "bulk shard run crashed");
    });
  });

  await db
    .update(benchmarkBulksTable)
    .set({ status: "running", updatedAt: new Date() })
    .where(eq(benchmarkBulksTable.id, bulkId));

  await writeAudit({
    entityType: "bulk",
    entityId: bulkId,
    actorLabel,
    action: "launch",
    afterState: { shards: shards.length, calls: callIds.length },
  });
}

/**
 * FR-BLK-6: re-execute only shard runs that still have non-ok cells. The
 * executor's resumability (v1 FR-E4) is what makes this cheap: cells that
 * already succeeded are skipped, so a retry never re-bills them. Calls that
 * were skipped_pending_review get re-evaluated -- one that reached
 * ready_to_run since the first attempt runs for real this time.
 */
export async function retryBulkFailedCells(
  bulkId: string,
  actorLabel: string,
): Promise<{ retriedRunIds: string[] }> {
  const runs = await db
    .select()
    .from(benchmarkRunsTable)
    .where(eq(benchmarkRunsTable.bulkId, bulkId))
    .orderBy(asc(benchmarkRunsTable.shardIndex));

  const toRetry: (typeof runs)[number][] = [];
  for (const run of runs) {
    if (run.status === "cancelled") continue;
    // T-46: "has any failed row" used to be enough to re-execute a run. But
    // since T-43 the executor refuses cells whose recorded failure a re-run
    // cannot fix, so a run whose failures are ALL permanent has nothing a
    // retry can touch -- re-executing it spent nothing at the provider but
    // still flipped the bulk back to "running", cleared completedAt and
    // rewrote the run's status for no reason. Apply the executor's own
    // rule here, on the latest row per cell, so the selection and the
    // execution agree about what "something left to retry" means.
    const rows = await db
      .select({
        providerId: benchmarkProviderCallResultsTable.providerId,
        callId: benchmarkProviderCallResultsTable.callId,
        status: benchmarkProviderCallResultsTable.status,
        failureClass: benchmarkProviderCallResultsTable.failureClass,
        createdAt: benchmarkProviderCallResultsTable.createdAt,
      })
      .from(benchmarkProviderCallResultsTable)
      .where(eq(benchmarkProviderCallResultsTable.runId, run.id));
    const latestByCell = new Map<string, (typeof rows)[number]>();
    for (const row of rows) {
      const key = `${row.providerId}::${row.callId}`;
      const previous = latestByCell.get(key);
      if (!previous || row.createdAt > previous.createdAt) latestByCell.set(key, row);
    }
    const hasRetryableWork = [...latestByCell.values()].some(
      (row) =>
        row.status === "skipped_pending_review" ||
        (row.status === "failed" &&
          isFailureClass(row.failureClass) &&
          isRetryableFailureClass(row.failureClass)),
    );
    if (!hasRetryableWork && run.status === "complete") continue;
    toRetry.push(run);
  }
  const retriedRunIds = toRetry.map((r) => r.id);
  // T-6 fix: same shard-concurrency cap as launchBulk -- a full-bulk retry
  // must not re-fire every shard at once either.
  void drainWithConcurrency(toRetry, BULK_SHARD_CONCURRENCY, async (run) => {
    await executeBenchmarkRun(run.id, actorLabel).catch((err) => {
      logger.error({ err, runId: run.id, bulkId }, "bulk retry run crashed");
    });
  });

  if (retriedRunIds.length > 0) {
    await db
      .update(benchmarkBulksTable)
      .set({ status: "running", completedAt: null, updatedAt: new Date() })
      .where(eq(benchmarkBulksTable.id, bulkId));
  }

  await writeAudit({
    entityType: "bulk",
    entityId: bulkId,
    actorLabel,
    action: "retry_failed",
    afterState: { retriedRunIds },
  });
  return { retriedRunIds };
}

/**
 * FR-BLK-7: stop starting new cells. Queued shard runs are flipped to
 * cancelled directly (the executor's status gate then refuses them); the
 * in-flight run is signalled cooperatively -- cells already inside a provider
 * call finish and are recorded.
 */
export async function cancelBulk(
  bulkId: string,
  actorLabel: string,
): Promise<void> {
  const runs = await db
    .select()
    .from(benchmarkRunsTable)
    .where(eq(benchmarkRunsTable.bulkId, bulkId));

  for (const run of runs) {
    if (run.status === "queued") {
      await db
        .update(benchmarkRunsTable)
        .set({ status: "cancelled", completedAt: new Date() })
        .where(eq(benchmarkRunsTable.id, run.id));
    } else if (run.status === "running") {
      requestRunCancellation(run.id);
    }
  }

  await db
    .update(benchmarkBulksTable)
    .set({ status: "cancelled", completedAt: new Date(), updatedAt: new Date() })
    .where(eq(benchmarkBulksTable.id, bulkId));

  await writeAudit({
    entityType: "bulk",
    entityId: bulkId,
    actorLabel,
    action: "cancel",
    beforeState: { runStatuses: runs.map((r) => r.status) },
  });
}
