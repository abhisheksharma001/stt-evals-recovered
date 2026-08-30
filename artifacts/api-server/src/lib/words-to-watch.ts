// T-87: words to watch, per bulk and (optionally) per assistant. The db half;
// the arithmetic is in words-to-watch-aggregate.ts.
import { and, eq, inArray } from "drizzle-orm";
import { benchmarkCallsTable, benchmarkProviderCallResultsTable, benchmarkRunsTable, db } from "@workspace/db";
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
  bulkId: string;
  assistantId: string | null;
  /** Calls in scope with at least one ok transcript. */
  callsScanned: number;
  /** Of those, calls where spans could be built and at least one exists. */
  callsWithSpans: number;
  words: WatchWord[];
};

/** Bulk must exist (caller checks). assistantId null = every call in the bulk. */
export async function wordsToWatch(bulkId: string, assistantId: string | null, limit?: number): Promise<WordsToWatch> {
  const runs = await db.select({ id: benchmarkRunsTable.id }).from(benchmarkRunsTable).where(eq(benchmarkRunsTable.bulkId, bulkId));
  if (runs.length === 0) return { bulkId, assistantId, callsScanned: 0, callsWithSpans: 0, words: [] };
  const runIds = runs.map((r) => r.id);

  const cells = await db
    .selectDistinct({ callId: benchmarkProviderCallResultsTable.callId, runId: benchmarkProviderCallResultsTable.runId })
    .from(benchmarkProviderCallResultsTable)
    .where(and(inArray(benchmarkProviderCallResultsTable.runId, runIds), eq(benchmarkProviderCallResultsTable.status, "ok")));
  if (cells.length === 0) return { bulkId, assistantId, callsScanned: 0, callsWithSpans: 0, words: [] };

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
    assistantId,
    callsScanned: new Set(inScope.map((c) => c.callId)).size,
    callsWithSpans: callsWithSpans.size,
    words: aggregateWordsToWatch(spans, limit),
  };
}
