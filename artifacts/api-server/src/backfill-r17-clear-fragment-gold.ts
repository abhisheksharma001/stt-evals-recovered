/**
 * One-off data backfill for register row R-17 (2026-09-09, memo O-76).
 *
 * Call 3559ea45's `gold_transcript` is 25 words against a 111-word draft on a
 * 51-second call -- roughly the first eleven seconds, ending mid-conversation
 * on a question mark. Whoever was typing stopped. It is not a transcript of
 * the call; it is the start of one.
 *
 * Scoring a provider against it does not measure accuracy: every word the
 * provider correctly heard after the fragment ends counts as an insertion, so
 * the WER on that call runs from 0.400 to 3.560 across its eight cells and
 * ranks providers by how much MORE than the fragment they transcribed. It is
 * half of the entire labelled set, so M-18's proxy-agreement figure is half
 * computed on a quantity that is upside down.
 *
 * "Finish or clear it" lost its first branch on 2026-09-09: finishing means a
 * person transcribing the remaining forty seconds, and Abhishek closed that
 * road (R-14). So it is cleared, leaving one real labelled call (64d8f463,
 * 186 gold words against a 157-word draft -- longer than the draft, which is
 * what a human transcript of a machine's output looks like).
 *
 * Existing `benchmark_scores` rows are left alone on purpose, exactly as M-1
 * left them: they are history, and each run's manifest records the gold it
 * saw. `proxy_agreement` filters on the live gold at query time, so the call
 * drops out of the measurement the moment this runs.
 *
 * The call's `status` is left at `ready_to_run` -- M-1's precedent. Status is
 * about whether a call may be run, and a call with no gold is the normal case
 * here, not a broken one.
 *
 * Guarded by the gold's SHA-256, not by its length: if anybody has edited the
 * field since this was written the script refuses rather than deleting work it
 * has not read. Idempotent -- once cleared there is nothing matching to clear.
 * Dry run by default.
 *
 *   pnpm --filter @workspace/api-server exec tsx --env-file-if-exists=.env ./src/backfill-r17-clear-fragment-gold.ts [--apply]
 */
import { createHash } from "node:crypto";
import { eq } from "drizzle-orm";

const CALL_ID = "3559ea45-50e5-4543-b439-3f8eff61b4c0";
/** SHA-256 of the 137-character fragment as read from the live row 2026-09-09. */
const FRAGMENT_SHA256 = "8629c069af4bb8d7d13110b5c74a3e1879030cdb25a97b6c3d6746e4305baa02";

const APPLY = process.argv.includes("--apply");
const { db, pool, benchmarkCallsTable } = await import("@workspace/db");
const { writeAudit } = await import("./lib/audit");

const [row] = await db
  .select({
    id: benchmarkCallsTable.id,
    gold: benchmarkCallsTable.goldTranscript,
    draft: benchmarkCallsTable.draftTranscript,
  })
  .from(benchmarkCallsTable)
  .where(eq(benchmarkCallsTable.id, CALL_ID));

if (!row) {
  console.log(`R-17: call ${CALL_ID.slice(0, 8)} not on file -- nothing to do`);
  await pool.end();
  process.exit(0);
}
if (row.gold === null) {
  console.log(`R-17: call ${CALL_ID.slice(0, 8)} already carries no gold -- nothing to do`);
  await pool.end();
  process.exit(0);
}

const sha = createHash("sha256").update(row.gold).digest("hex");
if (sha !== FRAGMENT_SHA256) {
  // Somebody wrote to this field after 2026-09-09. Whatever is there now is
  // not the fragment this step was reasoned about, so this script has no
  // grounds to delete it.
  console.error(`R-17: gold on ${CALL_ID.slice(0, 8)} is not the recorded fragment`);
  console.error(`  expected sha256 ${FRAGMENT_SHA256}`);
  console.error(`  found    sha256 ${sha} (${row.gold.length} chars)`);
  console.error("refusing to clear -- re-read the row and update the step before re-running");
  await pool.end();
  process.exit(1);
}

console.log(`R-17: 1 to clear -- ${CALL_ID.slice(0, 8)}, ${row.gold.length} chars, sha256 matches the recorded fragment`);
if (!APPLY) {
  console.log("dry run -- pass --apply to write");
  await pool.end();
  process.exit(0);
}

await db.update(benchmarkCallsTable).set({ goldTranscript: null }).where(eq(benchmarkCallsTable.id, CALL_ID));
// Same two fields M-1's audit row carries, so the fragment is restorable from
// the audit trail by anyone who ever wants it back.
await writeAudit({
  entityType: "call",
  entityId: CALL_ID,
  actorLabel: "backfill-r17-clear-fragment-gold",
  action: "update",
  beforeState: { goldTranscript: row.gold, draftTranscript: row.draft },
  afterState: { goldTranscript: null, draftTranscript: row.draft },
});

// Read it back rather than trusting the update's own word for it.
const [after] = await db
  .select({ gold: benchmarkCallsTable.goldTranscript })
  .from(benchmarkCallsTable)
  .where(eq(benchmarkCallsTable.id, CALL_ID));
if (after?.gold !== null) {
  console.error(`R-17: gold on ${CALL_ID.slice(0, 8)} is STILL SET after the update`);
  await pool.end();
  process.exit(1);
}
console.log(`cleared 1; gold on ${CALL_ID.slice(0, 8)} is now null`);
await pool.end();
