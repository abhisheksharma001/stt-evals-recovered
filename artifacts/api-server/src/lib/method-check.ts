// W-12b (PRD Part F, §1b): the method check.
//
// The tool ranks providers without a gold transcript, by how often each one
// disagrees with its peers. That is a claim about a proxy. The public Pipecat
// set (W-12a) is the one place on file where every clip carries a gold that
// came with the dataset, so there the proxy can be held against the truth:
// across the providers, does ordering by pooled peer-flag rate agree with
// ordering by pooled gold WER? Spearman rho, with its exact one-sided
// permutation p (docs/research.md R-1), and a plain verdict word.
//
// Aggregate arithmetic only (D-15): no transcript or clip leaves this file,
// only counts and rates. The public bulk is read here and nowhere else in the
// verdict, trend or overview paths.
import { and, eq, inArray } from "drizzle-orm";
import {
  db,
  benchmarkBulksTable,
  benchmarkProviderCallResultsTable,
  benchmarkRunsTable,
  benchmarkScoresTable,
} from "@workspace/db";
import { normalizeTranscript } from "@workspace/scoring";

import { aggregateMethodCheck, type MethodCheckFigures, type MethodCheckRow } from "./method-check-aggregate";

/** W-12a's ACCOUNT_LABEL in scripts/src/import-public-set.ts, which also
 *  names the bulk. Copied, not imported across packages. */
export const METHOD_CHECK_BULK_NAME = "Public: Pipecat 1k";

/** "partial" is a finished bulk with some failed cells (the set
 *  words-to-watch.ts reads). "cancelled" joins it here only (Abhishek
 *  2026-09-26: the W-12 bulk was capped at 2,000 cells by cancelling it); the
 *  cut leaves half-run calls, which aggregateMethodCheck drops. */
const FINISHED_BULK_STATUSES: readonly string[] = ["complete", "partial", "cancelled"];
/** A cancelled bulk is stamped completedAt at once while cells already in
 *  flight still finish, and peer flags are written only when a shard stops. */
const STILL_GOING_RUN_STATUSES: readonly string[] = ["queued", "running"];

export type MethodCheck =
  | { state: "not_run" }
  | ({ state: "measured"; bulkId: string; completedAt: Date } & MethodCheckFigures);

type Edits = { substitutions?: unknown; deletions?: unknown; insertions?: unknown; referenceWords?: unknown };
const count = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null);

export async function methodCheck(): Promise<MethodCheck> {
  const [bulk] = await db
    .select({ id: benchmarkBulksTable.id, status: benchmarkBulksTable.status, completedAt: benchmarkBulksTable.completedAt })
    .from(benchmarkBulksTable)
    .where(eq(benchmarkBulksTable.name, METHOD_CHECK_BULK_NAME));
  // Absent is not zero: no finished bulk means no number at all.
  if (!bulk || !FINISHED_BULK_STATUSES.includes(bulk.status) || !bulk.completedAt) return { state: "not_run" };

  const runs = await db
    .select({ id: benchmarkRunsTable.id, status: benchmarkRunsTable.status })
    .from(benchmarkRunsTable)
    .where(and(eq(benchmarkRunsTable.bulkId, bulk.id), eq(benchmarkRunsTable.purpose, "batch")));
  if (runs.some((r) => STILL_GOING_RUN_STATUSES.includes(r.status))) return { state: "not_run" };
  const cells =
    runs.length === 0
      ? []
      : await db
          .select({
            callId: benchmarkProviderCallResultsTable.callId,
            providerId: benchmarkProviderCallResultsTable.providerId,
            transcript: benchmarkProviderCallResultsTable.hypothesisTranscript,
            peerFlagCount: benchmarkScoresTable.peerFlagCount,
            detail: benchmarkScoresTable.detail,
          })
          .from(benchmarkProviderCallResultsTable)
          .innerJoin(benchmarkScoresTable, eq(benchmarkScoresTable.resultId, benchmarkProviderCallResultsTable.id))
          .where(
            and(
              inArray(
                benchmarkProviderCallResultsTable.runId,
                runs.map((r) => r.id),
              ),
              eq(benchmarkProviderCallResultsTable.status, "ok"),
            ),
          );

  const rows: MethodCheckRow[] = cells.map((c) => {
    const edits = (c.detail?.edits ?? null) as Edits | null;
    const s = count(edits?.substitutions);
    const d = count(edits?.deletions);
    const i = count(edits?.insertions);
    return {
      callId: c.callId,
      providerId: c.providerId,
      errors: s === null || d === null || i === null ? null : s + d + i,
      referenceWords: count(edits?.referenceWords),
      peerFlagCount: c.peerFlagCount,
      words: normalizeTranscript(c.transcript ?? "").split(" ").filter(Boolean).length,
    };
  });

  return { state: "measured", bulkId: bulk.id, completedAt: bulk.completedAt, ...aggregateMethodCheck(rows) };
}
