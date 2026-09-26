/**
 * One-off data backfill for register row W-12a3 (2026-09-26).
 *
 * The W-12 launch imported 1,000 public Pipecat clips: a call row each, and
 * the audio written into the disk cache as `<id>.audio` / `<id>.customer.audio`.
 * The importer never set `audio_object_path`, and the run executor refuses a
 * call with an empty one before it reads the cache
 * (`lib/run-executor.ts`, "Call has no audioObjectPath to send to a
 * provider."). Bulk 4fee349b "Public: Pipecat 1k" failed all 7,000 cells that
 * way in two seconds, spending nothing.
 *
 * This writes the same marker the importer now writes
 * (`publicAudioPath` in scripts/src/import-public-set.ts -- copied, not
 * imported across packages): `hf://datasets/<dataset>/<sample id>`. It is
 * never fetched; the executor reads the cached file. Only pipecat calls with
 * no path are touched -- a Vapi call's recording URL is never rewritten.
 *
 * Idempotent: re-running finds nothing to fill. Dry run by default.
 *
 *   pnpm --filter @workspace/api-server exec tsx --env-file-if-exists=.env ./src/backfill-w12a3-public-audio-path.ts [--apply]
 */
import { and, eq, isNull } from "drizzle-orm";

const APPLY = process.argv.includes("--apply");
const DATASET = "pipecat-ai/stt-benchmark-data";
const { db, pool, benchmarkCallsTable } = await import("@workspace/db");
const { writeAudit } = await import("./lib/audit");

const missingPath = and(
  eq(benchmarkCallsTable.sourceProvider, "pipecat"),
  isNull(benchmarkCallsTable.audioObjectPath),
);

const rows = await db
  .select({ id: benchmarkCallsTable.id, sampleId: benchmarkCallsTable.sourceCallId })
  .from(benchmarkCallsTable)
  .where(missingPath);
console.log(`W-12a3: ${rows.length} pipecat calls with no audio_object_path`);
if (!APPLY) {
  console.log("dry run -- pass --apply to write");
  await pool.end();
  process.exit(0);
}

let filled = 0;
for (const row of rows) {
  if (!row.sampleId) {
    console.log(`  ${row.id.slice(0, 8)}: no source_call_id, left alone`);
    continue;
  }
  const audioObjectPath = `hf://datasets/${DATASET}/${row.sampleId}`;
  const updated = await db
    .update(benchmarkCallsTable)
    .set({ audioObjectPath })
    .where(and(eq(benchmarkCallsTable.id, row.id), missingPath))
    .returning({ id: benchmarkCallsTable.id });
  if (updated.length === 0) continue;
  await writeAudit({
    entityType: "call",
    entityId: row.id,
    actorLabel: "backfill-w12a3-public-audio-path",
    action: "update",
    beforeState: { audioObjectPath: null },
    afterState: { audioObjectPath },
  });
  filled += 1;
}

const remaining = await db.select({ id: benchmarkCallsTable.id }).from(benchmarkCallsTable).where(missingPath);
console.log(`filled ${filled}; pipecat calls still without a path: ${remaining.length}`);
await pool.end();
