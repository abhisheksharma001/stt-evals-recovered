// T-23: the raw material for the cross-bulk trend strip. One summed cell per
// (bulk, client, assistant, provider) over every finished bulk -- totals
// only (peer flags, words, scored calls, clean calls), on exactly the T-19
// basis the rankings use, so the client can pool cells into any scope
// without averaging averages. The pure pooling lives in
// @workspace/scoring's buildTrend; this file is just the read.
import { and, eq, inArray } from "drizzle-orm";
import {
  benchmarkBulksTable,
  benchmarkCallsTable,
  benchmarkProviderCallResultsTable,
  benchmarkProvidersTable,
  benchmarkRunsTable,
  benchmarkScoresTable,
  db,
} from "@workspace/db";
import { normalizeTranscript, type TrendBulk, type TrendCell } from "@workspace/scoring";

export type BenchmarkTrend = { bulks: TrendBulk[]; cells: TrendCell[] };

/** Bulks that have finished scoring. A running bulk would draw a point
 * that keeps moving; it joins the strip once it settles. */
const FINISHED_BULK_STATUSES = ["complete", "partial"] as const;

export async function benchmarkTrend(): Promise<BenchmarkTrend> {
  const bulkRows = await db
    .select({
      id: benchmarkBulksTable.id,
      name: benchmarkBulksTable.name,
      status: benchmarkBulksTable.status,
      createdAt: benchmarkBulksTable.createdAt,
      completedAt: benchmarkBulksTable.completedAt,
    })
    .from(benchmarkBulksTable)
    .where(inArray(benchmarkBulksTable.status, [...FINISHED_BULK_STATUSES]));
  const bulks: TrendBulk[] = bulkRows.map((b) => ({
    id: b.id,
    name: b.name,
    at: (b.completedAt ?? b.createdAt).toISOString(),
    status: b.status,
  }));
  if (bulks.length === 0) return { bulks, cells: [] };

  const runs = await db
    .select({ id: benchmarkRunsTable.id, bulkId: benchmarkRunsTable.bulkId })
    .from(benchmarkRunsTable)
    .where(inArray(benchmarkRunsTable.bulkId, bulks.map((b) => b.id)));
  const bulkIdByRun = new Map(runs.map((r) => [r.id, r.bulkId!]));
  if (runs.length === 0) return { bulks, cells: [] };

  // Only cells that carry a peer flag count take part -- same rule as
  // aggregateRankingRows (run-executor.ts): a cell scored before hybrid
  // flagging has null there and must not read as a clean call.
  const rows = await db
    .select({
      runId: benchmarkProviderCallResultsTable.runId,
      callId: benchmarkProviderCallResultsTable.callId,
      providerId: benchmarkProviderCallResultsTable.providerId,
      transcript: benchmarkProviderCallResultsTable.hypothesisTranscript,
      peerFlagCount: benchmarkScoresTable.peerFlagCount,
    })
    .from(benchmarkProviderCallResultsTable)
    .innerJoin(benchmarkScoresTable, eq(benchmarkScoresTable.resultId, benchmarkProviderCallResultsTable.id))
    .where(
      and(
        inArray(benchmarkProviderCallResultsTable.runId, runs.map((r) => r.id)),
        eq(benchmarkProviderCallResultsTable.status, "ok"),
      ),
    );
  const scored = rows.filter((r) => r.peerFlagCount !== null);
  if (scored.length === 0) return { bulks, cells: [] };

  const callIds = [...new Set(scored.map((r) => r.callId))];
  const providerIds = [...new Set(scored.map((r) => r.providerId))];
  const [calls, providers] = await Promise.all([
    db
      .select({
        id: benchmarkCallsTable.id,
        accountLabel: benchmarkCallsTable.sourceAccountLabel,
        assistantId: benchmarkCallsTable.sourceAssistantId,
      })
      .from(benchmarkCallsTable)
      .where(inArray(benchmarkCallsTable.id, callIds)),
    db
      .select({ id: benchmarkProvidersTable.id, name: benchmarkProvidersTable.name })
      .from(benchmarkProvidersTable)
      .where(inArray(benchmarkProvidersTable.id, providerIds)),
  ]);
  const callById = new Map(calls.map((c) => [c.id, c]));
  const providerNameById = new Map(providers.map((p) => [p.id, p.name]));

  const cells = new Map<string, TrendCell>();
  for (const r of scored) {
    const bulkId = bulkIdByRun.get(r.runId);
    const call = callById.get(r.callId);
    if (!bulkId || !call) continue;
    // Empty-string labels are the pre-backfill state -- treat as unknown.
    const accountLabel = call.accountLabel ? call.accountLabel : null;
    const assistantId = call.assistantId ? call.assistantId : null;
    const key = `${bulkId}|${accountLabel ?? ""}|${assistantId ?? ""}|${r.providerId}`;
    const cell =
      cells.get(key) ??
      ({
        bulkId,
        accountLabel,
        assistantId,
        providerId: r.providerId,
        providerName: providerNameById.get(r.providerId) ?? r.providerId,
        peerFlags: 0,
        words: 0,
        callsScored: 0,
        cleanCalls: 0,
      } satisfies TrendCell);
    const flags = r.peerFlagCount ?? 0;
    cell.peerFlags += flags;
    cell.words += normalizeTranscript(r.transcript ?? "").split(" ").filter(Boolean).length;
    cell.callsScored += 1;
    if (flags === 0) cell.cleanCalls += 1;
    cells.set(key, cell);
  }

  return { bulks, cells: [...cells.values()] };
}
