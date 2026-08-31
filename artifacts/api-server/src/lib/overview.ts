// T-71 (PRD-v4-uiux E.3): the numbers the Overview page opens on. Every
// figure here is computed server-side from the same tables the detail pages
// read, so the Overview can never disagree with Bulks, Corpus or Results
// about a count. Nothing is estimated and nothing null is rendered as zero:
// where a figure has no basis (no finished bulk yet, no priced cell yet) the
// field says so with null / a separate "unpriced" count.
import { and, desc, eq, gte, inArray, sql } from "drizzle-orm";
import {
  benchmarkAgentScansTable,
  benchmarkBulksTable,
  benchmarkCallsTable,
  benchmarkProviderCallResultsTable,
  benchmarkProvidersTable,
  benchmarkRunsTable,
  benchmarkScoresTable,
  db,
} from "@workspace/db";
import { isFailureClass, isRetryableFailureClass } from "@workspace/stt-providers";
import { listCachedCallIds } from "./audio-cache";
import { isPastVapiRetention } from "./vapi-retention";

/** Bulks that have finished executing. `partial` is finished-with-failures,
 *  not in-flight, so it counts: its verdict is as real as a `complete` one. */
const FINISHED_BULK_STATUSES = ["complete", "partial"] as const;

/** Call statuses that still want a person before the call is usable. The
 *  review gates were retired 2026-08-27, so in normal use this is 0 -- but a
 *  call moved by hand stays visible here rather than vanishing. */
const AWAITING_REVIEW_STATUSES = ["needs_review", "ready_for_gold", "gold_in_review"] as const;

export type OverviewBulkRef = {
  id: string;
  name: string;
  status: string;
  completedAt: string | null;
};

export async function latestFinishedBulk(): Promise<OverviewBulkRef | null> {
  const [row] = await db
    .select({
      id: benchmarkBulksTable.id,
      name: benchmarkBulksTable.name,
      status: benchmarkBulksTable.status,
      completedAt: benchmarkBulksTable.completedAt,
      createdAt: benchmarkBulksTable.createdAt,
    })
    .from(benchmarkBulksTable)
    .where(inArray(benchmarkBulksTable.status, [...FINISHED_BULK_STATUSES]))
    // completedAt is the honest "newest"; a finished bulk with no completedAt
    // (retry cleared it, then the retry finished before the status flip) falls
    // back to creation order rather than sorting first.
    .orderBy(sql`${benchmarkBulksTable.completedAt} desc nulls last`, desc(benchmarkBulksTable.createdAt))
    .limit(1);
  if (!row) return null;
  return {
    id: row.id,
    name: row.name,
    status: row.status,
    completedAt: row.completedAt ? row.completedAt.toISOString() : null,
  };
}

export async function runningBulk(): Promise<{ id: string; name: string } | null> {
  const [row] = await db
    .select({ id: benchmarkBulksTable.id, name: benchmarkBulksTable.name })
    .from(benchmarkBulksTable)
    .where(eq(benchmarkBulksTable.status, "running"))
    .orderBy(desc(benchmarkBulksTable.createdAt))
    .limit(1);
  return row ?? null;
}

/** T-140: one line of the retryable-cells figure, so the number can say what
 *  it is made of. `reason` is the retryable failure class, or the literal
 *  "skipped_pending_review" for a cell that never failed at all (it was held
 *  back by review). Nothing else can appear: an unclassified or permanent
 *  failure is not counted as retryable in the first place. */
export type RetryableCellGroup = {
  providerId: string;
  providerName: string;
  reason: string;
  cells: number;
};

export type NeedsHuman = {
  callsAwaitingReview: number;
  hardCaseCalls: number;
  retryableFailedCells: number;
  /** The same cells as `retryableFailedCells`, grouped by provider + reason,
   *  biggest group first. Empty when the figure is 0. */
  retryableFailedCellGroups: RetryableCellGroup[];
  audioUnsavedCalls: number;
};

export async function needsHuman(): Promise<NeedsHuman> {
  const calls = await db
    .select({
      id: benchmarkCallsTable.id,
      status: benchmarkCallsTable.status,
      hardCases: benchmarkCallsTable.hardCases,
      sourceStartedAt: benchmarkCallsTable.sourceStartedAt,
      audioCacheLastOutcome: benchmarkCallsTable.audioCacheLastOutcome,
    })
    .from(benchmarkCallsTable);
  const awaiting = new Set<string>(AWAITING_REVIEW_STATUSES);
  const callsAwaitingReview = calls.filter((c) => awaiting.has(c.status)).length;
  const hardCaseCalls = calls.filter((c) => Array.isArray(c.hardCases) && c.hardCases.length > 0).length;

  // T-130: uncached audio became a person's chore in T-126 ("Save audio
  // now" on Calls) -- so the Overview must say when the chore exists.
  // Counted: every call whose bytes are not on the server's disk and whose
  // recording Vapi can still hand out. Unknown age counts (an attempt is
  // the only way to find out); calls already past the window do not -- no
  // person can save those, and Calls names them "audio gone" instead.
  // T-131: a call whose last recorded attempt was a permanent source
  // refusal (Vapi's retention 400 / the unsigned-bucket 403) is excluded
  // too -- no person can clear it, so counting it kept the figure from
  // ever reaching zero (the batch-12 residue this exists to fix).
  const cachedIds = await listCachedCallIds();
  const audioUnsavedCalls = calls.filter(
    (c) =>
      !cachedIds.has(c.id) &&
      !isPastVapiRetention(c.sourceStartedAt) &&
      c.audioCacheLastOutcome !== "source_refused",
  ).length;

  // Cells a retry could still fix, in bulks that have stopped: the same rule
  // retryBulkFailedCells applies (lib/bulks.ts), so this count and the
  // "Retry failed" button agree. Running bulks are excluded -- their failed
  // cells are still being retried by the executor itself.
  const stoppedBulks = await db
    .select({ id: benchmarkBulksTable.id })
    .from(benchmarkBulksTable)
    .where(inArray(benchmarkBulksTable.status, ["partial", "failed"]));
  let retryableFailedCells = 0;
  let retryableFailedCellGroups: RetryableCellGroup[] = [];
  if (stoppedBulks.length > 0) {
    const runs = await db
      .select({ id: benchmarkRunsTable.id, status: benchmarkRunsTable.status })
      .from(benchmarkRunsTable)
      .where(inArray(benchmarkRunsTable.bulkId, stoppedBulks.map((b) => b.id)));
    const liveRunIds = runs.filter((r) => r.status !== "cancelled").map((r) => r.id);
    if (liveRunIds.length > 0) {
      const rows = await db
        .select({
          status: benchmarkProviderCallResultsTable.status,
          failureClass: benchmarkProviderCallResultsTable.failureClass,
          providerId: benchmarkProviderCallResultsTable.providerId,
        })
        .from(benchmarkProviderCallResultsTable)
        .where(
          and(
            inArray(benchmarkProviderCallResultsTable.runId, liveRunIds),
            inArray(benchmarkProviderCallResultsTable.status, ["failed", "skipped_pending_review"]),
          ),
        );
      const retryable = rows.filter(
        (row) =>
          row.status === "skipped_pending_review" ||
          (isFailureClass(row.failureClass) && isRetryableFailureClass(row.failureClass)),
      );
      retryableFailedCells = retryable.length;

      // T-140: "15 transcripts a retry could fix" is a number nobody can act
      // on -- it says nothing about which provider, what went wrong, or that
      // clicking retry spends real provider money. Group it here, from the
      // same rows the count is made of, so the two can never disagree.
      if (retryable.length > 0) {
        const providers = await db
          .select({ id: benchmarkProvidersTable.id, name: benchmarkProvidersTable.name })
          .from(benchmarkProvidersTable);
        const nameById = new Map(providers.map((p) => [p.id, p.name]));
        const byKey = new Map<string, RetryableCellGroup>();
        for (const row of retryable) {
          const reason = row.status === "skipped_pending_review" ? "skipped_pending_review" : row.failureClass!;
          const key = `${row.providerId}\u0000${reason}`;
          const existing = byKey.get(key);
          if (existing) {
            existing.cells += 1;
          } else {
            byKey.set(key, {
              providerId: row.providerId,
              // A provider row deleted from Setup leaves results behind; the
              // id is still the honest name for it, never a blank.
              providerName: nameById.get(row.providerId) ?? row.providerId,
              reason,
              cells: 1,
            });
          }
        }
        retryableFailedCellGroups = [...byKey.values()].sort(
          (a, b) => b.cells - a.cells || a.providerName.localeCompare(b.providerName),
        );
      }
    }
  }

  return {
    callsAwaitingReview,
    hardCaseCalls,
    retryableFailedCells,
    retryableFailedCellGroups,
    audioUnsavedCalls,
  };
}

export type MonthSpend = {
  monthStart: string;
  /** Sum of recorded per-cell STT cost this month. Cells with no recorded
   *  cost are counted separately, never folded in as zero. */
  sttMicrocents: number;
  sttCellsPriced: number;
  sttCellsUnpriced: number;
  /** OpenAI judge spend this month: agent scans. Same unpriced rule. */
  agentMicrocents: number;
  agentJudgementsPriced: number;
  agentJudgementsUnpriced: number;
};

export function monthStartUtc(now = new Date()): Date {
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
}

export async function monthSpend(now = new Date()): Promise<MonthSpend> {
  const start = monthStartUtc(now);
  const priced = (col: unknown) => sql<number>`count(${col})::int`;
  const unpriced = (col: unknown) => sql<number>`count(*) filter (where ${col} is null)::int`;
  const total = (col: unknown) => sql<number>`coalesce(sum(${col}), 0)::bigint`;

  const [[stt], [scans]] = await Promise.all([
    db
      .select({
        micro: total(benchmarkScoresTable.costMicrocents),
        priced: priced(benchmarkScoresTable.costMicrocents),
        unpriced: unpriced(benchmarkScoresTable.costMicrocents),
      })
      .from(benchmarkScoresTable)
      .where(gte(benchmarkScoresTable.scoredAt, start)),
    // Only scans that actually called the judge carry a cost; a "clean" scan
    // made no LLM call and is neither priced nor unpriced.
    db
      .select({
        micro: total(benchmarkAgentScansTable.judgeCostMicrocents),
        priced: priced(benchmarkAgentScansTable.judgeCostMicrocents),
        unpriced: unpriced(benchmarkAgentScansTable.judgeCostMicrocents),
      })
      .from(benchmarkAgentScansTable)
      .where(
        and(
          gte(benchmarkAgentScansTable.createdAt, start),
          inArray(benchmarkAgentScansTable.status, ["flagged", "approved", "rejected", "error"]),
          sql`${benchmarkAgentScansTable.judgePromptTokens} is not null`,
        ),
      ),
  ]);

  return {
    monthStart: start.toISOString(),
    sttMicrocents: Number(stt?.micro ?? 0),
    sttCellsPriced: stt?.priced ?? 0,
    sttCellsUnpriced: stt?.unpriced ?? 0,
    agentMicrocents: Number(scans?.micro ?? 0),
    agentJudgementsPriced: scans?.priced ?? 0,
    agentJudgementsUnpriced: scans?.unpriced ?? 0,
  };
}
