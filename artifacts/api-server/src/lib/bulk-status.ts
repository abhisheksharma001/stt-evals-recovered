import { eq, inArray } from "drizzle-orm";
import {
  benchmarkBulksTable,
  benchmarkProviderCallResultsTable,
  benchmarkRunsTable,
  db,
} from "@workspace/db";

// Recomputes a bulk's stored status from the ground truth of its shard runs
// and their cells (FR-BLK-4). Called by the run executor every time a shard
// run finalizes, by the retry/cancel routes, and at boot for bulks that were
// mid-flight when the process last died -- the stored status is a cache of
// this derivation, never the other way around.
//
// "cancelled" is sticky here on purpose: the cancel route sets it directly
// and late-finishing in-flight cells (FR-BLK-7) must not flip the bulk back.
export async function refreshBulkStatus(bulkId: string): Promise<void> {
  const [bulk] = await db
    .select()
    .from(benchmarkBulksTable)
    .where(eq(benchmarkBulksTable.id, bulkId))
    .limit(1);
  if (!bulk || bulk.status === "cancelled") return;

  const runs = await db
    .select()
    .from(benchmarkRunsTable)
    .where(eq(benchmarkRunsTable.bulkId, bulkId));
  if (runs.length === 0) return; // not launched yet -- draft/awaiting stays

  if (
    runs.some(
      (run) =>
        run.status === "queued" ||
        run.status === "running" ||
        run.status === "blocked",
    )
  ) {
    if (bulk.status !== "running") {
      await db
        .update(benchmarkBulksTable)
        .set({ status: "running", updatedAt: new Date() })
        .where(eq(benchmarkBulksTable.id, bulkId));
    }
    return;
  }

  // Every shard run is terminal. Verdict comes from the cells: `partial`
  // when >=1 cell failed after retries (FR-BLK-4), `failed` only when
  // literally nothing succeeded.
  const results = await db
    .select({ status: benchmarkProviderCallResultsTable.status })
    .from(benchmarkProviderCallResultsTable)
    .where(
      inArray(
        benchmarkProviderCallResultsTable.runId,
        runs.map((run) => run.id),
      ),
    );
  const okCells = results.filter((r) => r.status === "ok").length;
  const failedCells = results.filter((r) => r.status === "failed").length;
  const cancelledCells = results.filter((r) => r.status === "cancelled").length;

  let status: string;
  if (okCells === 0 && failedCells > 0) {
    status = "failed";
  } else if (failedCells > 0 || cancelledCells > 0) {
    status = "partial";
  } else {
    status = "complete";
  }

  await db
    .update(benchmarkBulksTable)
    .set({ status, completedAt: new Date(), updatedAt: new Date() })
    .where(eq(benchmarkBulksTable.id, bulkId));
}
