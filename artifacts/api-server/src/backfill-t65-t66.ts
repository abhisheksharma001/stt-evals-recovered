/**
 * One-off data backfill for register rows T-65 and T-66 (2026-08-29).
 *
 *   T-65: 106 flagged scans link agent_pick_result_id to a result row in a
 *         DIFFERENT run than the scan's own (agent-verify.ts resolved the
 *         latest ok row for (call, provider) across all runs). Re-point each
 *         to the same provider's ok row inside the scan's own run. Every
 *         one of the 106 has such a row (checked before writing this).
 *   T-66: two 2026-08-24 manual agent_scan runs had 5/5 failed cells yet
 *         their scans are "flagged". No candidates ever existed, so the
 *         flags were an LLM-only guess. Reclassify as "error" with a note.
 *
 * Idempotent: re-running finds nothing to change. Prints before/after.
 *
 *   pnpm --filter @workspace/api-server exec tsx --env-file-if-exists=.env ./src/backfill-t65-t66.ts [--apply]
 *
 * Without --apply it only counts.
 */
import { sql } from "drizzle-orm";

const APPLY = process.argv.includes("--apply");

const { db, pool } = await import("@workspace/db");
const crossRun = sql`select count(*)::int as n from benchmark_agent_scans s join benchmark_provider_call_results r on r.id = s.agent_pick_result_id where s.run_id is not null and r.run_id <> s.run_id`;
const legacy = sql`select count(*)::int as n from benchmark_agent_scans where status = 'flagged' and run_id in ('ef4692f5-84a4-4e32-a0fa-3a09c60c6589', '83a51677-ade7-4c8e-837b-3fe151fa34ff')`;

const before65 = (await db.execute(crossRun)).rows[0]!.n;
const before66 = (await db.execute(legacy)).rows[0]!.n;
console.log(`T-65 cross-run pick links: ${before65}; T-66 legacy flagged scans: ${before66}`);
if (!APPLY) {
  console.log("dry run -- pass --apply to write");
  await pool.end();
  process.exit(0);
}

const relinked = await db.execute(sql`
  update benchmark_agent_scans s set agent_pick_result_id = x.id
  from benchmark_provider_call_results r, benchmark_provider_call_results x
  where r.id = s.agent_pick_result_id and s.run_id is not null and r.run_id <> s.run_id
    and x.run_id = s.run_id and x.call_id = s.call_id and x.provider_id = r.provider_id and x.status = 'ok'`);
const reclassified = await db.execute(sql`
  update benchmark_agent_scans
  set status = 'error',
      error_message = 'legacy (2026-08-24 manual agent_scan): every re-transcription cell failed, so no candidates existed and the flags were an LLM-only guess with nothing behind them. Reclassified by T-66.'
  where status = 'flagged' and run_id in ('ef4692f5-84a4-4e32-a0fa-3a09c60c6589', '83a51677-ade7-4c8e-837b-3fe151fa34ff')`);
await db.execute(sql`
  insert into audit_log (entity_type, entity_id, actor_label, action, after_state)
  values ('agent_scan', 'backfill', 'backfill-t65-t66', 'backfill_pick_links_and_legacy_flagged',
          ${JSON.stringify({ relinked: relinked.rowCount, reclassified: reclassified.rowCount })}::jsonb)`);

const after65 = (await db.execute(crossRun)).rows[0]!.n;
const after66 = (await db.execute(legacy)).rows[0]!.n;
console.log(`relinked ${relinked.rowCount} (cross-run now ${after65}); reclassified ${reclassified.rowCount} (legacy flagged now ${after66})`);
await pool.end();
