// T-71 (PRD-v4-uiux E.3): the numbers the Overview page opens on. Every
// figure here is computed server-side from the same tables the detail pages
// read, so the Overview can never disagree with Bulks, Corpus or Results
// about a count. Nothing is estimated and nothing null is rendered as zero:
// where a figure has no basis (no finished bulk yet, no priced cell yet) the
// field says so with null / a separate "unpriced" count.
import { and, desc, eq, gte, inArray, sql } from "drizzle-orm";
import {
  benchmarkAdjudicationsTable,
  benchmarkAgentScansTable,
  benchmarkBulksTable,
  benchmarkCallsTable,
  benchmarkProviderCallResultsTable,
  benchmarkRunsTable,
  benchmarkScoresTable,
  db,
} from "@workspace/db";
import { isFailureClass, isRetryableFailureClass } from "@workspace/stt-providers";
import { buildSpansForCallRun } from "./disagreement-spans";

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

// Spans are a pure function of stored, immutable result rows (see
// lib/disagreement-spans.ts), so the set of span keys for a (call, run) never
// changes once computed. Cache it per process: the first Overview load after
// a restart pays for the build, every later one is a Map lookup plus one
// cheap adjudications query. Adjudications are NOT cached -- they change.
const spanKeysByCellRun = new Map<string, string[]>();
const spanKey = (startMs: number, endMs: number) => `${startMs}-${endMs}`;

async function spanKeysFor(callId: string, runId: string): Promise<string[]> {
  const key = `${callId}::${runId}`;
  const cached = spanKeysByCellRun.get(key);
  if (cached) return cached;
  const built = await buildSpansForCallRun(callId, runId);
  const keys = built.spans.map((s) => spanKey(s.startMs, s.endMs));
  spanKeysByCellRun.set(key, keys);
  return keys;
}

export type SpanAdjudicationCounts = { total: number; adjudicated: number };

/** Disagreement spans in a finished bulk, and how many a human has already
 *  ruled on (T-67's gap). One (call, run) pair per call: the run in this
 *  bulk that holds the call's successful cells -- the same default the
 *  adjudication page uses when no run is named. */
export async function spanAdjudicationCounts(bulkId: string): Promise<SpanAdjudicationCounts> {
  const runs = await db
    .select({ id: benchmarkRunsTable.id })
    .from(benchmarkRunsTable)
    .where(eq(benchmarkRunsTable.bulkId, bulkId));
  if (runs.length === 0) return { total: 0, adjudicated: 0 };
  const runIds = runs.map((r) => r.id);

  const cells = await db
    .selectDistinct({
      callId: benchmarkProviderCallResultsTable.callId,
      runId: benchmarkProviderCallResultsTable.runId,
    })
    .from(benchmarkProviderCallResultsTable)
    .where(
      and(
        inArray(benchmarkProviderCallResultsTable.runId, runIds),
        eq(benchmarkProviderCallResultsTable.status, "ok"),
      ),
    );

  const adjudications = await db
    .select({
      callId: benchmarkAdjudicationsTable.callId,
      runId: benchmarkAdjudicationsTable.runId,
      startMs: benchmarkAdjudicationsTable.spanStartMs,
      endMs: benchmarkAdjudicationsTable.spanEndMs,
    })
    .from(benchmarkAdjudicationsTable)
    .where(inArray(benchmarkAdjudicationsTable.runId, runIds));
  const adjudicated = new Set(adjudications.map((a) => `${a.callId}::${a.runId}::${spanKey(a.startMs, a.endMs)}`));

  let total = 0;
  let adjudicatedCount = 0;
  for (const cell of cells) {
    const keys = await spanKeysFor(cell.callId, cell.runId);
    total += keys.length;
    for (const k of keys) if (adjudicated.has(`${cell.callId}::${cell.runId}::${k}`)) adjudicatedCount += 1;
  }
  return { total, adjudicated: adjudicatedCount };
}

export type NeedsHuman = {
  callsAwaitingReview: number;
  hardCaseCalls: number;
  retryableFailedCells: number;
};

export async function needsHuman(): Promise<NeedsHuman> {
  const calls = await db
    .select({ status: benchmarkCallsTable.status, hardCases: benchmarkCallsTable.hardCases })
    .from(benchmarkCallsTable);
  const awaiting = new Set<string>(AWAITING_REVIEW_STATUSES);
  const callsAwaitingReview = calls.filter((c) => awaiting.has(c.status)).length;
  const hardCaseCalls = calls.filter((c) => Array.isArray(c.hardCases) && c.hardCases.length > 0).length;

  // Cells a retry could still fix, in bulks that have stopped: the same rule
  // retryBulkFailedCells applies (lib/bulks.ts), so this count and the
  // "Retry failed" button agree. Running bulks are excluded -- their failed
  // cells are still being retried by the executor itself.
  const stoppedBulks = await db
    .select({ id: benchmarkBulksTable.id })
    .from(benchmarkBulksTable)
    .where(inArray(benchmarkBulksTable.status, ["partial", "failed"]));
  let retryableFailedCells = 0;
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
        })
        .from(benchmarkProviderCallResultsTable)
        .where(
          and(
            inArray(benchmarkProviderCallResultsTable.runId, liveRunIds),
            inArray(benchmarkProviderCallResultsTable.status, ["failed", "skipped_pending_review"]),
          ),
        );
      retryableFailedCells = rows.filter(
        (row) =>
          row.status === "skipped_pending_review" ||
          (isFailureClass(row.failureClass) && isRetryableFailureClass(row.failureClass)),
      ).length;
    }
  }

  return { callsAwaitingReview, hardCaseCalls, retryableFailedCells };
}

export type MonthSpend = {
  monthStart: string;
  /** Sum of recorded per-cell STT cost this month. Cells with no recorded
   *  cost are counted separately, never folded in as zero. */
  sttMicrocents: number;
  sttCellsPriced: number;
  sttCellsUnpriced: number;
  /** OpenAI judge spend this month: agent scans plus judge replays on
   *  adjudicated spans. Same unpriced rule. */
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

  const [[stt], [scans], [replays]] = await Promise.all([
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
    db
      .select({
        micro: total(benchmarkAdjudicationsTable.judgeCostMicrocents),
        priced: priced(benchmarkAdjudicationsTable.judgeCostMicrocents),
        unpriced: unpriced(benchmarkAdjudicationsTable.judgeCostMicrocents),
      })
      .from(benchmarkAdjudicationsTable)
      .where(gte(benchmarkAdjudicationsTable.judgeReplayedAt, start)),
  ]);

  return {
    monthStart: start.toISOString(),
    sttMicrocents: Number(stt?.micro ?? 0),
    sttCellsPriced: stt?.priced ?? 0,
    sttCellsUnpriced: stt?.unpriced ?? 0,
    agentMicrocents: Number(scans?.micro ?? 0) + Number(replays?.micro ?? 0),
    agentJudgementsPriced: (scans?.priced ?? 0) + (replays?.priced ?? 0),
    agentJudgementsUnpriced: (scans?.unpriced ?? 0) + (replays?.unpriced ?? 0),
  };
}
