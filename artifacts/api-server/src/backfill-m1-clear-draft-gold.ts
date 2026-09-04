/**
 * One-off data backfill for register row M-1 (2026-09-04, PRD v6 Part A).
 *
 * 19 of the 21 calls carrying a `gold_transcript` hold a byte-identical copy
 * of their own `draft_transcript` -- Vapi's own live transcriber output,
 * `AI:` / `User:` labels and all, written by actor `claude-pipeline-test` on
 * 2026-08-24 (audit log, call:update). A draft is never a reference: scoring
 * a candidate provider against it measures agreement with whatever Vapi ran
 * that day, not accuracy, and every WER computed on those calls is wrong by
 * construction. Clearing the copies puts those calls back on the gold-free
 * consensus path, which is the recommended one.
 *
 * The two calls whose gold really was edited by a person (3559ea45..,
 * 64d8f463..) differ from their draft and are therefore never selected.
 * Existing `benchmark_scores` rows are left alone on purpose -- they are
 * history, and each run's manifest records the gold it saw.
 *
 * Idempotent: re-running finds nothing to clear. Dry run by default.
 *
 *   pnpm --filter @workspace/api-server exec tsx --env-file-if-exists=.env ./src/backfill-m1-clear-draft-gold.ts [--apply]
 */
import { and, eq, isNotNull } from "drizzle-orm";

const APPLY = process.argv.includes("--apply");
const { db, pool, benchmarkCallsTable } = await import("@workspace/db");
const { writeAudit } = await import("./lib/audit");

const draftCopies = and(
  isNotNull(benchmarkCallsTable.goldTranscript),
  eq(benchmarkCallsTable.goldTranscript, benchmarkCallsTable.draftTranscript),
);

const rows = await db
  .select({
    id: benchmarkCallsTable.id,
    gold: benchmarkCallsTable.goldTranscript,
    draft: benchmarkCallsTable.draftTranscript,
  })
  .from(benchmarkCallsTable)
  .where(draftCopies);
console.log(`M-1: ${rows.length} to clear (gold_transcript is a copy of draft_transcript)`);
if (!APPLY) {
  for (const row of rows) console.log(`  ${row.id.slice(0, 8)}: ${row.gold?.length ?? 0} chars, identical to draft`);
  console.log("dry run -- pass --apply to write");
  await pool.end();
  process.exit(0);
}

let cleared = 0;
for (const row of rows) {
  const updated = await db
    .update(benchmarkCallsTable)
    .set({ goldTranscript: null })
    .where(and(eq(benchmarkCallsTable.id, row.id), draftCopies))
    .returning({ id: benchmarkCallsTable.id });
  if (updated.length === 0) continue;
  // Same two fields the audit trail already carries for a call update, so a
  // restore is a copy of the draft back into gold if anyone ever wants it.
  await writeAudit({
    entityType: "call",
    entityId: row.id,
    actorLabel: "backfill-m1-clear-draft-gold",
    action: "update",
    beforeState: { goldTranscript: row.gold, draftTranscript: row.draft },
    afterState: { goldTranscript: null, draftTranscript: row.draft },
  });
  cleared += 1;
}

const remaining = await db.select({ id: benchmarkCallsTable.id }).from(benchmarkCallsTable).where(draftCopies);
const withGold = await db
  .select({ id: benchmarkCallsTable.id })
  .from(benchmarkCallsTable)
  .where(isNotNull(benchmarkCallsTable.goldTranscript));
console.log(`cleared ${cleared}; draft copies now ${remaining.length}; calls still carrying gold: ${withGold.length}`);
await pool.end();
