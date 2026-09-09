/**
 * R-7: which calls need checking? Count the seeds before building a monitor.
 *
 * A grill script, not a feature -- the same shape and the same door as
 * mine-confirmed-entities.ts. Abhishek, 2026-09-08, asked for a path that
 * checks only the calls that need it, and PRD v7 Part E says that path's
 * trigger has to be an IMPLICIT signal already stored on the call, not an
 * LLM read of one transcript. Nothing here decides to build it. This prints
 * whether any stored signal is worth building on, and the decision goes into
 * PRD v7 Part E.
 *
 * Reads the database. Writes nothing, calls no provider and no LLM, spends
 * nothing.
 *
 * PII: the corpus is real callers. Nothing below prints a transcript, a name,
 * a phone number or a call id -- only counts, and the `endedReason` vocabulary,
 * which is Vapi's own enum.
 *
 *   pnpm --filter @workspace/api-server exec tsx --env-file-if-exists=.env ./src/mine-triage-signals.ts
 */
// A module, so top-level await is legal. Everything below is imported
// dynamically for the same reason mine-confirmed-entities.ts does it: the env
// file has to be loaded before @workspace/db reads DATABASE_URL at import.
export {};

const { db, pool, benchmarkCallsTable, benchmarkAgentScansTable } = await import("@workspace/db");
// The 2x2 arithmetic lives in lib/ so it can be proved against synthetic cells
// without the corpus -- these numbers become a decision in PRD v7 Part E.
const { signalStats } = await import("./lib/triage-signals");
type SignalCell = import("./lib/triage-signals").SignalCell;

/**
 * Ended reasons that mean the CALLER hung up on a call that ran normally.
 * Anything else -- an error, a timeout, the assistant or the pipeline ending
 * it -- is the signal. Set from the live vocabulary printed below, so a reason
 * this corpus has never produced cannot be silently assumed benign.
 */
const CUSTOMER_ENDED = new Set(["customer-ended-call"]);

/** A signal is a seed only if it beats the base rate by this much AND leaves
 *  real work out. Stated here rather than eyeballed off the table. */
const LIFT_MARGIN_POINTS = 10;
const MAX_SELECTED_SHARE = 0.8;

type Call = typeof benchmarkCallsTable.$inferSelect;

const calls = await db.select().from(benchmarkCallsTable);
const scans = await db.select().from(benchmarkAgentScansTable);

// The truth column: did the free hybrid pass flag this call? Latest scan per
// call -- a call rescanned after a re-run is judged on its current state, not
// on the first answer it ever got.
const latestScan = new Map<string, { status: string; at: Date }>();
for (const scan of scans) {
  const at = scan.createdAt;
  const held = latestScan.get(scan.callId);
  if (!held || held.at < at) latestScan.set(scan.callId, { status: scan.status, at });
}

/** Only these two are a verdict. A scan that errored, or is still scanning,
 *  answers nothing and is dropped from every population rather than counted
 *  as "not flagged" -- the same rule the null columns get. */
const VERDICT = new Set(["flagged", "clean"]);

const pad = (value: number | string, width: number) => String(value).padStart(width, " ");
const pct = (value: number) => `${(value * 100).toFixed(1)}%`;

const tally = (values: (string | null)[]) => {
  const counts = new Map<string, number>();
  for (const value of values) counts.set(String(value), (counts.get(String(value)) ?? 0) + 1);
  return [...counts.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
};

const [{ current_database: database }] = (
  await pool.query<{ current_database: string }>("select current_database()")
).rows as [{ current_database: string }];

console.log(`corpus (database: ${database})`);
console.log(`  calls                            ${pad(calls.length, 5)}`);
console.log(`  scans                            ${pad(scans.length, 5)}`);
console.log(`  calls with a scan                ${pad(latestScan.size, 5)}`);
for (const [status, n] of tally([...latestScan.values()].map((s) => s.status))) {
  const counts = VERDICT.has(status) ? "counted" : "DROPPED -- no verdict";
  console.log(`    latest scan ${status.padEnd(20)} ${pad(n, 5)}   ${counts}`);
}

console.log(`\nsignal columns, as stored (null is "not measured", never "no")`);
for (const [reason, n] of tally(calls.map((c) => c.sourceSuccessEvaluation))) {
  console.log(`  successEvaluation ${reason.padEnd(28)} ${pad(n, 5)}`);
}
for (const [reason, n] of tally(calls.map((c) => c.sourceEndedReason))) {
  console.log(`  endedReason       ${reason.padEnd(28)} ${pad(n, 5)}`);
}
const numeric = (pick: (c: Call) => number | null) => {
  const values = calls.map(pick).filter((v): v is number => v != null).sort((a, b) => a - b);
  return {
    n: values.length,
    nulls: calls.length - values.length,
    median: values.length ? values[Math.floor(values.length / 2)]! : null,
  };
};
for (const [name, pick] of [
  ["transcriberLatencyMs", (c: Call) => c.prodTranscriberLatencyMs],
  ["assistantInterruptions", (c: Call) => c.prodAssistantInterruptions],
  ["toolCalls", (c: Call) => c.prodToolCalls],
] as const) {
  const s = numeric(pick);
  console.log(`  ${name.padEnd(46)} n=${pad(s.n, 4)} null=${pad(s.nulls, 4)} median=${s.median}`);
}

const latencyMedian = numeric((c) => c.prodTranscriberLatencyMs).median;

/** null = this call cannot answer for this signal, and is dropped from its
 *  population rather than counted as a "no". */
const SIGNALS: { name: string; test: (c: Call) => boolean | null }[] = [
  {
    name: "success evaluation is false",
    test: (c) => (c.sourceSuccessEvaluation == null ? null : c.sourceSuccessEvaluation === "false"),
  },
  {
    name: "assistant was interrupted >= 1",
    test: (c) => (c.prodAssistantInterruptions == null ? null : c.prodAssistantInterruptions >= 1),
  },
  {
    name: "transcriber latency above corpus median",
    test: (c) =>
      c.prodTranscriberLatencyMs == null || latencyMedian == null
        ? null
        : c.prodTranscriberLatencyMs > latencyMedian,
  },
  {
    name: "ended reason is not the customer hanging up",
    test: (c) => (c.sourceEndedReason == null ? null : !CUSTOMER_ENDED.has(c.sourceEndedReason)),
  },
  { name: "no tool call was made", test: (c) => (c.prodToolCalls == null ? null : c.prodToolCalls === 0) },
];

console.log(
  `\n2x2 per signal against "the latest scan flagged this call".` +
    `\nsel = the signal picked it, flag = the hybrid pass flagged it.` +
    `\nprec = flagged among selected; rec = of all flagged, the share selected;` +
    ` base = flagged share of the population; lift = prec - base.\n`,
);
console.log(
  `  ${"signal".padEnd(42)}${"pop".padStart(5)}${"sel".padStart(5)}` +
    `${"sel+flag".padStart(9)}${"sel+ok".padStart(7)}${"prec".padStart(8)}` +
    `${"rec".padStart(8)}${"base".padStart(8)}${"lift".padStart(8)}${"head".padStart(8)}  seed?`,
);

const RULE = { liftMarginPoints: LIFT_MARGIN_POINTS, maxSelectedShare: MAX_SELECTED_SHARE };
let seeds = 0;
let untestable = 0;
for (const signal of SIGNALS) {
  const cells: SignalCell[] = [];
  for (const call of calls) {
    const scan = latestScan.get(call.id);
    if (!scan || !VERDICT.has(scan.status)) continue;
    const picked = signal.test(call);
    if (picked === null) continue;
    cells.push({ selected: picked, flagged: scan.status === "flagged" });
  }
  const s = signalStats(cells, RULE);
  if (s.verdict === "seed") seeds += 1;
  if (s.verdict === "untestable") untestable += 1;
  console.log(
    `  ${signal.name.padEnd(42)}${pad(s.population, 5)}${pad(s.selected, 5)}` +
      `${pad(s.selectedFlagged, 9)}${pad(s.selectedClean, 7)}${pad(pct(s.precision), 8)}` +
      `${pad(pct(s.recall), 8)}${pad(pct(s.base), 8)}${pad(`${(s.lift * 100).toFixed(1)}pt`, 8)}` +
      `${pad(`${s.headroom.toFixed(1)}pt`, 8)}  ${s.verdict === "seed" ? "YES" : s.verdict === "untestable" ? "UNTESTABLE" : "no"}`,
  );
}

console.log(
  `\nseed rule: a signal is a seed when it selects at most ` +
    `${pct(MAX_SELECTED_SHARE)} of its population and its precision beats the base ` +
    `rate by at least ${LIFT_MARGIN_POINTS} points.`,
);
console.log(
  `head = the most lift arithmetic allows (1 - base). A signal whose headroom is ` +
    `under the margin is UNTESTABLE here: not "tested and lost", but "the truth ` +
    `column is too nearly constant to answer".`,
);
console.log(`\nseeds found: ${seeds}   untestable: ${untestable} of ${SIGNALS.length}`);
if (seeds > 0) {
  console.log(`DECISION: ${seeds} signal(s) worth stepping. The step still has to be written and grilled.`);
} else if (untestable > 0) {
  console.log(
    `DECISION: no monitor path, and the table is not the reason. The hybrid pass ` +
      `flags almost every call it verdicts, so "which calls need checking" has no ` +
      `useful answer on this corpus -- the answer is "nearly all of them". What needs ` +
      `deciding first is the flag rate itself, not the trigger. Re-run when the ` +
      `corpus grows or the flag rate falls.`,
  );
} else {
  console.log(`DECISION: no monitor path on this corpus. Re-run when the corpus grows.`);
}

await pool.end();
