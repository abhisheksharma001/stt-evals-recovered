// W-7: Layer 2's "what else happened" strip (PRD v8 Part C). Per call, the
// per-turn latencies off the saved artifact and the four signals M-7a and the
// importer already store on the calls row; pooled per layer with the two
// denominators each number must be read against. Nothing here is collected
// and nothing here is text: the artifact's `messages` and `transcript` are
// never read past the key, and no path with a caller id is logged -- a
// missing or unreadable artifact is "not timed", silently.
//
// null is "Vapi did not measure this on that call" and is never rendered as
// 0 (M-7a's rule). The route scopes to one agent through the same seam the
// verdict uses, so the two halves of the drawer describe the same calls.
import fs from "node:fs/promises";
import { eq, inArray } from "drizzle-orm";
import { benchmarkCallsTable, benchmarkRunsTable, db } from "@workspace/db";
import { artifactCachePathFor } from "./audio-cache";
import { readTurnLatencies, type TurnLatency } from "./production-signals";
import { summarizeTurnSignals, type BulkTurnSignals, type TurnSignalsCall } from "./turn-signals-summary";
import { scopeCallsToAssistant } from "./verdict";

export type { BulkTurnSignals, LatencyPool, TurnSignalsCall, TurnSignalsSummary, ValueCount } from "./turn-signals-summary";

/** The saved artifact's turns, or null for any reason at all -- there is no
 *  reason a reader of numbers should learn (or log) which caller's file is
 *  missing. */
async function turnsOnDisk(callId: string): Promise<TurnLatency[] | null> {
  try {
    return readTurnLatencies(JSON.parse(await fs.readFile(artifactCachePathFor(callId), "utf8")));
  } catch {
    return null;
  }
}

/** Throws AssistantNotInBulkError when `assistantId` names no call here. */
export async function bulkTurnSignals(bulkId: string, assistantId?: string): Promise<BulkTurnSignals> {
  const runs = await db
    .select({ callIds: benchmarkRunsTable.callIds })
    .from(benchmarkRunsTable)
    .where(eq(benchmarkRunsTable.bulkId, bulkId));
  const callIds = [...new Set(runs.flatMap((r) => r.callIds))];

  const rows = callIds.length
    ? await db
        .select({
          id: benchmarkCallsTable.id,
          sourceAssistantId: benchmarkCallsTable.sourceAssistantId,
          prodAssistantInterruptions: benchmarkCallsTable.prodAssistantInterruptions,
          prodToolCalls: benchmarkCallsTable.prodToolCalls,
          sourceEndedReason: benchmarkCallsTable.sourceEndedReason,
          sourceSuccessEvaluation: benchmarkCallsTable.sourceSuccessEvaluation,
        })
        .from(benchmarkCallsTable)
        .where(inArray(benchmarkCallsTable.id, callIds))
    : [];
  const scoped = scopeCallsToAssistant(rows, assistantId).sort((a, b) => a.id.localeCompare(b.id));

  const calls: TurnSignalsCall[] = await Promise.all(
    scoped.map(async (row) => ({
      callId: row.id,
      turns: await turnsOnDisk(row.id),
      assistantInterruptions: row.prodAssistantInterruptions,
      toolCalls: row.prodToolCalls,
      endedReason: row.sourceEndedReason,
      successEvaluation: row.sourceSuccessEvaluation,
    })),
  );

  return { bulkId, assistantId: assistantId ?? null, calls, summary: summarizeTurnSignals(calls) };
}
