// T-87: words to watch, per bulk and (optionally) per assistant. The db half;
// the arithmetic is in words-to-watch-aggregate.ts.
import { and, desc, eq, inArray } from "drizzle-orm";
import { benchmarkBulksTable, benchmarkCallsTable, benchmarkProviderCallResultsTable, benchmarkRunsTable, db } from "@workspace/db";
import type { DisagreementSpansResult } from "@workspace/scoring";
import { buildSpansForCallRun } from "./disagreement-spans";
import { aggregateWordsToWatch, type WatchWord } from "./words-to-watch-aggregate";

// Spans are a pure function of stored, immutable result rows, so the built
// result for a (call, run) never changes. Cached per process, same reason
// lib/overview.ts cached span keys before T-86.
const spansByCellRun = new Map<string, DisagreementSpansResult>();
async function spansFor(callId: string, runId: string): Promise<DisagreementSpansResult> {
  const key = `${callId}::${runId}`;
  const cached = spansByCellRun.get(key);
  if (cached) return cached;
  const built = await buildSpansForCallRun(callId, runId);
  spansByCellRun.set(key, built);
  return built;
}

export type WordsToWatch = {
  /** Null = all-time: every finished bulk, the latest run per call. */
  bulkId: string | null;
  /** Finished bulks the scan drew from (1 in bulk mode). */
  bulksCovered: number;
  assistantId: string | null;
  /** Calls in scope with at least one ok transcript. */
  callsScanned: number;
  /** Of those, calls where spans could be built and at least one exists. */
  callsWithSpans: number;
  words: WatchWord[];
};

/** Bulks that have finished executing -- same rule as lib/trend.ts. */
const FINISHED_BULK_STATUSES = ["complete", "partial"] as const;

/**
 * Bulk must exist when given (caller checks). bulkId null = all-time
 * (T-92): every finished bulk's batch runs, and for a call that ran in
 * several bulks only its most recent run counts, so a call is never
 * counted three times for the same word.
 * assistantId null = every call in scope.
 */
export async function wordsToWatch(bulkId: string | null, assistantId: string | null, limit?: number): Promise<WordsToWatch> {
  const empty = (bulksCovered: number): WordsToWatch => ({ bulkId, bulksCovered, assistantId, callsScanned: 0, callsWithSpans: 0, words: [] });
  const runs = bulkId
    ? await db
        .select({ id: benchmarkRunsTable.id, bulkId: benchmarkRunsTable.bulkId, createdAt: benchmarkRunsTable.createdAt })
        .from(benchmarkRunsTable)
        .where(eq(benchmarkRunsTable.bulkId, bulkId))
    : await db
        .select({ id: benchmarkRunsTable.id, bulkId: benchmarkRunsTable.bulkId, createdAt: benchmarkRunsTable.createdAt })
        .from(benchmarkRunsTable)
        .innerJoin(benchmarkBulksTable, eq(benchmarkBulksTable.id, benchmarkRunsTable.bulkId))
        .where(and(eq(benchmarkRunsTable.purpose, "batch"), inArray(benchmarkBulksTable.status, [...FINISHED_BULK_STATUSES])))
        .orderBy(desc(benchmarkRunsTable.createdAt));
  const bulksCovered = new Set(runs.map((r) => r.bulkId)).size;
  if (runs.length === 0) return empty(bulksCovered);
  const runIds = runs.map((r) => r.id);
  const runOrder = new Map(runs.map((r) => [r.id, r.createdAt.getTime()]));

  const allCells = await db
    .selectDistinct({ callId: benchmarkProviderCallResultsTable.callId, runId: benchmarkProviderCallResultsTable.runId })
    .from(benchmarkProviderCallResultsTable)
    .where(and(inArray(benchmarkProviderCallResultsTable.runId, runIds), eq(benchmarkProviderCallResultsTable.status, "ok")));
  // Latest run per call. In bulk mode a call is in exactly one run already.
  const latestByCall = new Map<string, { callId: string; runId: string }>();
  for (const c of allCells) {
    const cur = latestByCall.get(c.callId);
    if (!cur || (runOrder.get(c.runId) ?? 0) > (runOrder.get(cur.runId) ?? 0)) latestByCall.set(c.callId, c);
  }
  const cells = [...latestByCall.values()];
  if (cells.length === 0) return empty(bulksCovered);

  let inScope = cells;
  if (assistantId !== null) {
    const calls = await db
      .select({ id: benchmarkCallsTable.id })
      .from(benchmarkCallsTable)
      .where(and(inArray(benchmarkCallsTable.id, [...new Set(cells.map((c) => c.callId))]), eq(benchmarkCallsTable.sourceAssistantId, assistantId)));
    const keep = new Set(calls.map((c) => c.id));
    inScope = cells.filter((c) => keep.has(c.callId));
  }

  const spans = [];
  const callsWithSpans = new Set<string>();
  for (const cell of inScope) {
    const built = await spansFor(cell.callId, cell.runId);
    if (built.spans.length > 0) callsWithSpans.add(cell.callId);
    for (const s of built.spans) {
      spans.push({ callId: cell.callId, majorityText: s.majorityText, readings: s.readings.map((r) => ({ providerId: r.providerId, text: r.text })) });
    }
  }
  return {
    bulkId,
    bulksCovered,
    assistantId,
    callsScanned: new Set(inScope.map((c) => c.callId)).size,
    callsWithSpans: callsWithSpans.size,
    words: aggregateWordsToWatch(spans, limit),
  };
}
