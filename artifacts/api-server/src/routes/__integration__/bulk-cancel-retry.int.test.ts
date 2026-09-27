// W-12a5: cancelling a bulk also stops a retry-failed that has not yet
// started all its shards.
//
// Found live 2026-09-26 on the capped W-12 bulk: the cancel fired at 1,984 ok
// cells, but retryBulkFailedCells still held shards in its drain list. Those
// shards were "failed" or "complete", not "queued", so cancelBulk left them
// alone and the executor's status gate let them in -- the bulk went on to
// 2,311 cells after it read "cancelled".
//
// SAFETY: this suite calls executeBenchmarkRun (through the retry), so what
// keeps it free is the same as run-executor-disabled.int.test.ts:
//   1. Every provider is a Fixtures provider (`fx-<suffix>-N`), which matches
//      no adapter, so no vendor is ever called.
//   2. Every call has no audioObjectPath, so the executor fails the cell
//      before any audio is fetched.
//   3. No cell reaches "ok", so the judge is never reached.
// Never put a real provider id in this file.
//
// Timing is made deterministic with a row lock, not a sleep: the test holds
// FOR UPDATE on the first BULK_SHARD_CONCURRENCY (3) shards, so each of them
// blocks on its first write ("status = running") and the fourth shard waits
// in the drain list until the lock is released -- after the cancel.
import { afterAll, describe, expect, it } from "vitest";
import { eq, inArray } from "drizzle-orm";
import { benchmarkProviderCallResultsTable, benchmarkRunsTable, db, pool } from "@workspace/db";
import { cancelBulk, retryBulkFailedCells } from "../../lib/bulks";
import { Fixtures } from "./fixtures";

const fx = new Fixtures();

afterAll(async () => {
  await fx.cleanup();
  await pool.end();
});

async function runRow(runId: string) {
  const [row] = await db.select().from(benchmarkRunsTable).where(eq(benchmarkRunsTable.id, runId));
  return row;
}

async function cellCount(runId: string): Promise<number> {
  const rows = await db
    .select({ id: benchmarkProviderCallResultsTable.id })
    .from(benchmarkProviderCallResultsTable)
    .where(eq(benchmarkProviderCallResultsTable.runId, runId));
  return rows.length;
}

describe("W-12a5 cancel during retry-failed", () => {
  it("skips every shard the retry had not started once the bulk is cancelled", async () => {
    const provider = await fx.provider();
    const bulk = await fx.bulk({ status: "partial", providerIds: [provider.id] });
    const before = new Date("2026-09-26T00:00:00.000Z");
    const shards = [];
    for (let shardIndex = 0; shardIndex < 4; shardIndex++) {
      const call = await fx.call();
      shards.push(
        await fx.run({
          bulkId: bulk.id,
          shardIndex,
          status: "failed",
          providerIds: [provider.id],
          callIds: [call.id],
          callCount: 1,
          completedAt: before,
        }),
      );
    }
    const held = shards.slice(0, 3);
    const waiting = shards[3];

    const lock = await pool.connect();
    try {
      await lock.query("BEGIN");
      await lock.query("SELECT id FROM benchmark_runs WHERE id = ANY($1::uuid[]) FOR UPDATE", [held.map((r) => r.id)]);

      const { retriedRunIds } = await retryBulkFailedCells(bulk.id, fx.actor);
      expect(retriedRunIds).toEqual(shards.map((r) => r.id));
      await cancelBulk(bulk.id, fx.actor);

      await lock.query("COMMIT");
    } finally {
      lock.release();
    }

    // Wait until the fourth shard is settled one way or the other: skipped
    // (cancelled) or run to the end (completedAt moved past `before`).
    const deadline = Date.now() + 15_000;
    for (;;) {
      const row = await runRow(waiting.id);
      const settled = row.status === "cancelled" || (row.status !== "running" && row.completedAt! > before);
      const heldRows = await db.select().from(benchmarkRunsTable).where(inArray(benchmarkRunsTable.id, held.map((r) => r.id)));
      if (settled && heldRows.every((r) => r.status !== "running")) break;
      if (Date.now() > deadline) throw new Error(`shards did not settle: waiting=${row.status}`);
      await new Promise((r) => setTimeout(r, 100));
    }

    const after = await runRow(waiting.id);
    expect(after.status).toBe("cancelled");
    expect(await cellCount(waiting.id)).toBe(0);
  });
});
