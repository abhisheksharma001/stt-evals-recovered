import { and, asc, eq, gte, inArray, lte } from "drizzle-orm";
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
import { drainWithConcurrency, envInt, executeBenchmarkRun, requestRunCancellation } from "./run-executor";
import { writeAudit } from "./audit";
import { logger } from "./logger";

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
const BULK_COST_THRESHOLD_CENTS = (() => {
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
export async function resolveCriteriaCallIds(
  criteria: BulkSelectionCriteria,
  minDurationSeconds: number,
  now: Date = new Date(),
): Promise<string[]> {
  // Explicit-picks-only criteria select exactly those calls. The filter query
  // below always carries the min-duration condition (FR-SEL-7), so running it
  // unconditionally would union in the whole corpus under a callIds-only
  // selection (found by the e2e harness: a 5-call explicit bulk came back
  // with 9 calls).
  const hasFilters = Boolean(
    criteria.vertical ||
      criteria.assistantIds?.length ||
      criteria.accountLabel ||
      criteria.lastNDays ||
      criteria.startedAtFrom ||
      criteria.startedAtTo,
  );

  const ids = new Set<string>();
  if (hasFilters || !criteria.callIds?.length) {
    const { from, to } = resolveDateWindow(criteria, now);
    const conditions = [
      criteria.vertical
        ? eq(benchmarkCallsTable.vertical, criteria.vertical)
        : undefined,
      criteria.assistantIds?.length
        ? inArray(benchmarkCallsTable.sourceAssistantId, criteria.assistantIds)
        : undefined,
      criteria.accountLabel
        ? eq(benchmarkCallsTable.sourceAccountLabel, criteria.accountLabel)
        : undefined,
      from ? gte(benchmarkCallsTable.sourceStartedAt, from) : undefined,
      to ? lte(benchmarkCallsTable.sourceStartedAt, to) : undefined,
      // FR-SEL-7: keep near-empty calls (voicemail beeps, misdials) out of a
      // bulk by default -- they inflate call counts with near-meaningless WER
      // data and eat the gold budget.
      gte(benchmarkCallsTable.durationSeconds, minDurationSeconds),
    ].filter((c) => c !== undefined);

    const matched = await db
      .select({ id: benchmarkCallsTable.id })
      .from(benchmarkCallsTable)
      .where(and(...conditions));
    for (const row of matched) ids.add(row.id);
  }

  // Explicit picks merge with filter matches, but only if they exist.
  if (criteria.callIds?.length) {
    const explicit = await db
      .select({ id: benchmarkCallsTable.id })
      .from(benchmarkCallsTable)
      .where(inArray(benchmarkCallsTable.id, criteria.callIds));
    for (const row of explicit) ids.add(row.id);
  }
  return [...ids];
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
// can -- this projects from real history (what fraction of past scans came
// back "flagged", and what those judge calls actually cost) once any exist.
// Falls back to a documented placeholder assumption before any real scan
// history exists, same placeholder-and-flag-it convention as
// costPerMinute's Nova-2 placeholder elsewhere in this codebase.
const AGENT_COST_ESTIMATE_FALLBACK = { assumedFlagRate: 0.3, assumedCostCentsPerJudgeCall: 1 };

export async function estimateBulkAgentCostCents(callCount: number): Promise<number> {
  if (callCount === 0) return 0;
  const scans = await db
    .select({ status: benchmarkAgentScansTable.status, judgeCostCents: benchmarkAgentScansTable.judgeCostCents })
    .from(benchmarkAgentScansTable);

  if (scans.length === 0) {
    return Math.ceil(callCount * AGENT_COST_ESTIMATE_FALLBACK.assumedFlagRate * AGENT_COST_ESTIMATE_FALLBACK.assumedCostCentsPerJudgeCall);
  }

  const flaggedCount = scans.filter((s) => s.status === "flagged").length;
  const flagRate = flaggedCount / scans.length;
  const judgeCosts = scans.map((s) => s.judgeCostCents).filter((c): c is number => c !== null);
  const avgJudgeCostCents = judgeCosts.length
    ? judgeCosts.reduce((sum, c) => sum + c, 0) / judgeCosts.length
    : AGENT_COST_ESTIMATE_FALLBACK.assumedCostCentsPerJudgeCall;

  return Math.ceil(callCount * flagRate * avgJudgeCostCents);
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
  confirm?: boolean;
  actorLabel: string;
}): Promise<CreateBulkResult> {
  const now = new Date();
  const minDuration =
    input.minDurationSeconds ?? input.criteria.minDurationSeconds ?? 5;
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

  const callIds = await resolveCriteriaCallIds(input.criteria, minDuration, now);
  if (callIds.length === 0) {
    throw new BulkSelectionEmptyError(
      "selection criteria matched no corpus calls",
    );
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
    resolvedCallIds: callIds,
    resolvedAt: now.toISOString(),
  };

  const estimatedSttCostCents = await estimateBulkCostCents(
    callIds,
    input.providerIds,
  );
  const estimatedAgentCostCents = await estimateBulkAgentCostCents(callIds.length);
  const estimatedCostCents = estimatedSttCostCents + estimatedAgentCostCents;
  const overThreshold = estimatedCostCents > BULK_COST_THRESHOLD_CENTS;
  const name = input.name ?? now.toISOString().slice(0, 10); // FR-BLK-2

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
          estimatedCostCents,
          estimatedSttCostCents,
          estimatedAgentCostCents,
          launchedByLabel: input.actorLabel,
          notes:
            overThreshold && !input.confirm
              ? `Estimated cost $${(estimatedCostCents / 100).toFixed(2)} (STT $${(estimatedSttCostCents / 100).toFixed(2)} + agent verification $${(estimatedAgentCostCents / 100).toFixed(2)}) exceeds the $${(BULK_COST_THRESHOLD_CENTS / 100).toFixed(2)} threshold -- confirm to launch (FR-BLK-5).`
              : null,
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
    const remaining = await db
      .select({ id: benchmarkProviderCallResultsTable.id })
      .from(benchmarkProviderCallResultsTable)
      .where(
        and(
          eq(benchmarkProviderCallResultsTable.runId, run.id),
          inArray(benchmarkProviderCallResultsTable.status, [
            "failed",
            "skipped_pending_review",
          ]),
        ),
      )
      .limit(1);
    if (remaining.length === 0 && run.status === "complete") continue;
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
