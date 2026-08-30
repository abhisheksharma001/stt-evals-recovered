// T-112 / T-113: per-assistant signals for a Results group card -- how sure
// the AI judge was, and which calls a person flagged as hard. The db half;
// the arithmetic is in assistant-signals-aggregate.ts.
//
// Scope rules match lib/words-to-watch.ts: bulkId given = that bulk's runs;
// null = all-time, every finished bulk's batch runs. One scan per call (the
// latest) so a re-execution never double-counts.
import { and, desc, eq, inArray } from "drizzle-orm";
import {
  benchmarkAgentScansTable,
  benchmarkBulksTable,
  benchmarkCallsTable,
  benchmarkProviderCallResultsTable,
  benchmarkRunsTable,
  db,
} from "@workspace/db";
import { aggregateHardCases, aggregateJudgeConfidence, type HardCaseSummary, type JudgeConfidenceSummary } from "./assistant-signals-aggregate";

export type AssistantSignals = {
  bulkId: string | null;
  bulksCovered: number;
  assistantId: string | null;
  /** Distinct calls with at least one result cell in scope. */
  callsInScope: number;
  judge: JudgeConfidenceSummary;
  hardCases: HardCaseSummary;
};

const FINISHED_BULK_STATUSES = ["complete", "partial"] as const;

export async function assistantSignals(bulkId: string | null, assistantId: string | null): Promise<AssistantSignals> {
  const runs = bulkId
    ? await db
        .select({ id: benchmarkRunsTable.id, bulkId: benchmarkRunsTable.bulkId })
        .from(benchmarkRunsTable)
        .where(eq(benchmarkRunsTable.bulkId, bulkId))
    : await db
        .select({ id: benchmarkRunsTable.id, bulkId: benchmarkRunsTable.bulkId })
        .from(benchmarkRunsTable)
        .innerJoin(benchmarkBulksTable, eq(benchmarkBulksTable.id, benchmarkRunsTable.bulkId))
        .where(and(eq(benchmarkRunsTable.purpose, "batch"), inArray(benchmarkBulksTable.status, [...FINISHED_BULK_STATUSES])))
        .orderBy(desc(benchmarkRunsTable.createdAt));
  const bulksCovered = new Set(runs.map((r) => r.bulkId)).size;
  const empty: AssistantSignals = {
    bulkId,
    bulksCovered,
    assistantId,
    callsInScope: 0,
    judge: aggregateJudgeConfidence([]),
    hardCases: aggregateHardCases([]),
  };
  if (runs.length === 0) return empty;
  const runIds = runs.map((r) => r.id);

  const cells = await db
    .selectDistinct({ callId: benchmarkProviderCallResultsTable.callId })
    .from(benchmarkProviderCallResultsTable)
    .where(inArray(benchmarkProviderCallResultsTable.runId, runIds));
  if (cells.length === 0) return empty;

  const calls = await db
    .select({ id: benchmarkCallsTable.id, label: benchmarkCallsTable.label, hardCases: benchmarkCallsTable.hardCases })
    .from(benchmarkCallsTable)
    .where(
      assistantId === null
        ? inArray(benchmarkCallsTable.id, cells.map((c) => c.callId))
        : and(inArray(benchmarkCallsTable.id, cells.map((c) => c.callId)), eq(benchmarkCallsTable.sourceAssistantId, assistantId)),
    );
  if (calls.length === 0) return empty;
  const callIds = calls.map((c) => c.id);

  const scans = await db
    .select({
      callId: benchmarkAgentScansTable.callId,
      createdAt: benchmarkAgentScansTable.createdAt,
      status: benchmarkAgentScansTable.status,
      judgeConfidence: benchmarkAgentScansTable.judgeConfidence,
      agentPickReasoning: benchmarkAgentScansTable.agentPickReasoning,
    })
    .from(benchmarkAgentScansTable)
    .where(and(inArray(benchmarkAgentScansTable.runId, runIds), inArray(benchmarkAgentScansTable.callId, callIds)));

  return {
    bulkId,
    bulksCovered,
    assistantId,
    callsInScope: calls.length,
    judge: aggregateJudgeConfidence(scans),
    hardCases: aggregateHardCases(calls),
  };
}
