/**
 * M-15: are there enough confirmed entity references in the corpus to be
 * worth building a feature on?
 *
 * A grill script, not a feature. 75 of the 100 saved artifacts contain tool
 * calls, and some of those calls carry values the customer said out loud --
 * a phone number, a name, a date. If the tool then succeeded, the value was
 * confirmed by something other than a transcriber; if the same value also
 * appears in the customer's own turns, the pair is a reference a run could
 * be scored against without a human writing a gold transcript. This prints
 * how many such pairs exist. Whether to build on them is a later step, and
 * only if the number justifies it.
 *
 * Reads the disk and the database. It writes nothing, calls no provider and
 * spends nothing.
 *
 * PII: `<callId>.artifact.json` holds a real caller's words and a real
 * caller's phone number. Nothing below prints a value -- only tool names,
 * argument names and counts. That is also why the outcome rule and the
 * mention check live in lib/confirmed-entities.ts and are unit-tested there
 * against synthetic fixtures: the rules can be proved without the corpus.
 *
 *   pnpm --filter @workspace/api-server exec tsx --env-file-if-exists=.env ./src/mine-confirmed-entities.ts
 */
import { readFile } from "node:fs/promises";

import type { ArgumentTally } from "./lib/confirmed-entities";

const { db, pool, benchmarkCallsTable } = await import("@workspace/db");
const { artifactCachePathFor } = await import("./lib/audio-cache");
// tallyToolCall, not stringArgumentsOf: an argument VALUE never enters this
// file. See its own comment -- the corpus is real caller PII and the break
// test found nothing stopping a debug print here.
const { customerTurnsOf, tallyToolCall, toolOutcome, FRAGILE_MAX_LENGTH } = await import(
  "./lib/confirmed-entities"
);

type ArtifactMessage = {
  role?: unknown;
  name?: unknown;
  result?: unknown;
  toolCallId?: unknown;
  toolCalls?: unknown;
};

const emptyTally = (): ArgumentTally => ({
  candidates: 0,
  fromSucceeded: 0,
  present: 0,
  fragile: 0,
});

const corpus = { calls: 0, artifact: 0, unreadable: 0, withToolCalls: 0, toolCalls: 0 };
const outcomes = { succeeded: 0, failed: 0, unknown: 0 };
const drafts = { present: 0, missing: 0, noCustomerTurn: 0 };
const byPair = new Map<string, ArgumentTally>();
const totals = emptyTally();

const rows = await db
  .select({ id: benchmarkCallsTable.id, draftTranscript: benchmarkCallsTable.draftTranscript })
  .from(benchmarkCallsTable);
corpus.calls = rows.length;

for (const row of rows) {
  let parsed: unknown;
  try {
    parsed = JSON.parse(await readFile(artifactCachePathFor(row.id), "utf8"));
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") corpus.unreadable += 1;
    continue;
  }
  corpus.artifact += 1;

  const messages = (parsed as { messages?: unknown })?.messages;
  if (!Array.isArray(messages)) continue;
  const list = messages as ArtifactMessage[];

  // Vapi splits a tool call across two messages: `tool_calls` carries the
  // arguments, `tool_call_result` carries what came back, joined by
  // toolCallId. All 119 in the corpus join, so an unmatched call would be a
  // new shape rather than a normal absence -- it is counted as unknown.
  const resultFor = new Map<string, unknown>();
  for (const message of list) {
    if (message.role !== "tool_call_result") continue;
    if (typeof message.toolCallId === "string") resultFor.set(message.toolCallId, message.result);
  }

  const turns = customerTurnsOf(row.draftTranscript);
  let sawToolCall = false;

  for (const message of list) {
    if (message.role !== "tool_calls" || !Array.isArray(message.toolCalls)) continue;
    for (const raw of message.toolCalls) {
      const call = raw as { id?: unknown; function?: { name?: unknown; arguments?: unknown } };
      const tool = typeof call.function?.name === "string" ? call.function.name : "(unnamed)";
      sawToolCall = true;
      corpus.toolCalls += 1;

      const outcome =
        typeof call.id === "string" && resultFor.has(call.id)
          ? toolOutcome(resultFor.get(call.id))
          : "unknown";
      outcomes[outcome] += 1;

      for (const counted of tallyToolCall(tool, call.function?.arguments, outcome, turns)) {
        const key = `${tool} ${counted.name}`;
        const running = byPair.get(key) ?? emptyTally();
        for (const field of ["candidates", "fromSucceeded", "present", "fragile"] as const) {
          running[field] += counted.tally[field];
          totals[field] += counted.tally[field];
        }
        byPair.set(key, running);
      }
    }
  }

  if (sawToolCall) {
    corpus.withToolCalls += 1;
    if (!row.draftTranscript) drafts.missing += 1;
    else if (!turns) drafts.noCustomerTurn += 1;
    else drafts.present += 1;
  }
}

const pad = (value: number, width: number) => String(value).padStart(width, " ");

console.log("corpus");
console.log(`  calls in database                ${pad(corpus.calls, 5)}`);
console.log(`  artifact on disk                 ${pad(corpus.artifact, 5)}`);
console.log(`  artifact unreadable              ${pad(corpus.unreadable, 5)}`);
console.log(`  with at least one tool call      ${pad(corpus.withToolCalls, 5)}`);
console.log(`  tool calls                       ${pad(corpus.toolCalls, 5)}`);

console.log("\ntool results (by structure, never by searching the text for a word)");
console.log(`  succeeded                        ${pad(outcomes.succeeded, 5)}`);
console.log(`  failed                           ${pad(outcomes.failed, 5)}`);
console.log(`  status unknown -- NOT success    ${pad(outcomes.unknown, 5)}`);

console.log("\ncustomer turns, of the calls that made a tool call");
console.log(`  draft has User: lines            ${pad(drafts.present, 5)}`);
console.log(`  draft is assistant-only          ${pad(drafts.noCustomerTurn, 5)}`);
console.log(`  no draft at all                  ${pad(drafts.missing, 5)}`);

const sorted = [...byPair.entries()].sort(
  (a, b) =>
    b[1].present - a[1].present ||
    b[1].candidates - a[1].candidates ||
    a[0].localeCompare(b[0]),
);
console.log("\nstring arguments, by tool and argument name");
console.log(`  ${"tool".padEnd(38)}${"argument".padEnd(26)}  cand   ok  seen  frag`);
for (const [key, tally] of sorted) {
  const [tool, name] = key.split(" ");
  console.log(
    `  ${(tool ?? "").padEnd(38)}${(name ?? "").padEnd(26)}` +
      `${pad(tally.candidates, 6)}${pad(tally.fromSucceeded, 5)}${pad(tally.present, 6)}${pad(tally.fragile, 6)}`,
  );
}

const solid = totals.present - totals.fragile;
console.log(
  `\ncand = string argument, ok = its tool succeeded, seen = value is in the ` +
    `customer's turns, frag = seen but <= ${FRAGILE_MAX_LENGTH} normalized characters, ` +
    `so the match could be an accident inside a longer word`,
);
console.log(`\nusable references: ${solid} (${totals.present} including fragile matches)`);
console.log(`>= 10 usable references: ${solid >= 10 ? "YES" : "NO"}`);

await pool.end();
