// R-43 (ox-alpha B-63): the stt-score CLI did `JSON.parse(raw) as ScoreInput`
// -- a blind cast. A row missing `goldTranscript`, or carrying a number where
// a string belongs, did not fail there; it exploded somewhere inside score()
// with a TypeError that named neither the row nor the field nor the file. The
// person running the CLI has a JSON file in front of them and no way to tell
// which of its 400 rows is wrong.
//
// Deliberately hand-written rather than a zod schema. This package has no zod
// dependency, and adding one to the scoring library -- the pure, hot path that
// every flag and span goes through -- to improve a CLI error message is the
// wrong trade. The check is shallow on purpose: it establishes the shape
// score() relies on and says where a bad row is, which is the whole complaint.

import type { ScoreInput } from "./core";

const VERTICALS = ["rush", "property_management", "trucking"] as const;
const REQUIRED_STRINGS = [
  "callId",
  "providerId",
  "goldTranscript",
  "hypothesisTranscript",
] as const;

/** Human-readable problems with one row, empty when it is usable. */
function rowProblems(row: unknown, index: number): string[] {
  const at = `row ${index}`;
  if (row === null || typeof row !== "object" || Array.isArray(row)) {
    return [`${at}: expected an object, got ${Array.isArray(row) ? "an array" : typeof row}`];
  }
  const r = row as Record<string, unknown>;
  const problems: string[] = [];
  for (const key of REQUIRED_STRINGS) {
    if (typeof r[key] !== "string") {
      problems.push(
        r[key] === undefined
          ? `${at}: missing "${key}"`
          : `${at}: "${key}" must be a string, got ${typeof r[key]}`,
      );
    }
  }
  if (!VERTICALS.includes(r.vertical as (typeof VERTICALS)[number])) {
    problems.push(
      `${at}: "vertical" must be one of ${VERTICALS.join(", ")}, got ${JSON.stringify(r.vertical)}`,
    );
  }
  // score() maps over this. A non-array is the crash the CLI actually hit.
  if (!Array.isArray(r.entities)) {
    problems.push(
      r.entities === undefined
        ? `${at}: missing "entities" (use [] when there are none)`
        : `${at}: "entities" must be an array, got ${typeof r.entities}`,
    );
  } else {
    r.entities.forEach((e, i) => {
      if (e === null || typeof e !== "object" || typeof (e as { value?: unknown }).value !== "string") {
        problems.push(`${at}: entities[${i}] must be an object with a string "value"`);
      }
    });
  }
  return problems;
}

/** Parses the CLI's input file into rows, or throws naming every bad row.
 *
 *  Reports ALL bad rows, not the first: someone fixing a generated file wants
 *  the list, not one round trip per row. */
export function parseScoreInput(parsed: unknown, source: string): ScoreInput[] {
  const rows = Array.isArray(parsed) ? parsed : [parsed];
  if (rows.length === 0) {
    throw new Error(`${source}: no rows to score (the file parsed to an empty array).`);
  }
  const problems = rows.flatMap((row, i) => rowProblems(row, i));
  if (problems.length > 0) {
    throw new Error(
      `${source}: ${problems.length} problem(s) in ${rows.length} row(s):\n` +
        problems.map((p) => `  - ${p}`).join("\n"),
    );
  }
  return rows as ScoreInput[];
}
