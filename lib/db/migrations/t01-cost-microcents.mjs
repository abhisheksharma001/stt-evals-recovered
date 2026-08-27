// T-01, run once against production 2026-08-28. Kept as the audit record of
// what happened to the data, not as something to run again (it is guarded and
// idempotent, but there is nothing left for it to do).
//
// Why raw SQL instead of `drizzle-kit push`: the backfill and the column drop
// have to be in ONE transaction. cost_cents was a lossy round of
// cost_per_minute, so the exact value had to be recovered from cost_per_minute
// BEFORE cost_cents was dropped -- push cannot express that ordering.
//
// Result on the live DB:
//   benchmark_agent_scans : 75 rows, 0 with a cost (every judged insert had
//                           failed -- that IS the bug), so nothing to preserve.
//   benchmark_scores      : 731 rows. Only 597 had cost_cents; all 731 had the
//                           exact cost_per_minute. Backfilling from the exact
//                           column recovered cost for 134 rows that previously
//                           had none, and restored sub-cent precision on the rest.
//   Bulk 7d2585da         : reported $2.90, actually $3.0135 -- the old integer
//                           rounding UNDERSTATED real spend by 3.8%.
//
// Run with: DATABASE_URL=... node lib/db/migrations/t01-cost-microcents.mjs
import pg from "pg";

const { Client } = pg;
const c = new Client({ connectionString: process.env.DATABASE_URL });
await c.connect();

const q = async (sql, params) => (await c.query(sql, params)).rows;

const before = await q(`
  select
    (select count(*) from benchmark_agent_scans)                                  as scans,
    (select count(*) from benchmark_agent_scans where judge_cost_cents is not null) as scans_with_cost,
    (select count(*) from benchmark_scores)                                       as scores,
    (select count(*) from benchmark_scores where cost_cents is not null)          as scores_with_cost,
    (select count(*) from benchmark_scores where cost_per_minute is not null)     as scores_with_exact
`);
console.log("BEFORE:", before[0]);

if (Number(before[0].scans_with_cost) > 0) {
  console.error("REFUSING: judge_cost_cents has non-null rows; this migration assumed all were null (every insert failed). Investigate before dropping.");
  process.exit(1);
}

await q("begin");
try {
  // 1. agent scans: every row is null (all judged inserts failed), so there is
  //    nothing to preserve -- add the correct column, drop the broken one.
  await q(`alter table benchmark_agent_scans add column if not exists judge_cost_microcents integer`);
  await q(`alter table benchmark_agent_scans drop column if exists judge_cost_cents`);

  // 2. scores: cost_cents is a LOSSY round of cost_per_minute (which is a real,
  //    in dollars, and holds the exact value). Backfill from the exact column,
  //    not from the rounded one -- this recovers precision that was lost.
  await q(`alter table benchmark_scores add column if not exists cost_microcents integer`);
  const filled = await q(`
    update benchmark_scores
       set cost_microcents = round(cost_per_minute::numeric * 1000000)
     where cost_per_minute is not null
       and cost_microcents is null
    returning id
  `);
  await q(`alter table benchmark_scores drop column if exists cost_cents`);
  await q("commit");
  console.log(`backfilled ${filled.length} score rows from cost_per_minute (exact, not from the rounded cents)`);
} catch (e) {
  await q("rollback");
  throw e;
}

const after = await q(`
  select
    (select count(*) from benchmark_scores where cost_microcents is not null) as scores_with_microcents,
    (select round(avg(cost_microcents)) from benchmark_scores)                as avg_microcents,
    (select round(sum(cost_microcents) / 10000.0, 2) from benchmark_scores)   as total_cents
`);
console.log("AFTER:", after[0]);

const cols = await q(`
  select table_name, column_name, data_type
    from information_schema.columns
   where (table_name = 'benchmark_agent_scans' and column_name like 'judge_cost%')
      or (table_name = 'benchmark_scores'      and column_name like 'cost_%')
   order by table_name, column_name
`);
console.table(cols);

await c.end();
