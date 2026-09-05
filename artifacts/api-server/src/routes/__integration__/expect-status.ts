// M-6a: the integration suite fails roughly once in ten runs, in a different
// file each time, on `main` as much as on a feature branch -- four failures
// in about forty-five runs, measured 2026-09-05 and written up in
// docs/backlog/good-to-have.md. Three of the four were status assertions that
// printed two numbers and nothing else, so each occurrence cost a re-run and
// taught nothing about the cause.
//
// The fourth failed with `Error: socket hang up` -- no answer to print. This
// file cannot help with that one, and does not pretend to.
//
// Vitest's second argument to expect() is put in front of the assertion
// message, including in the one-line summary that survives when CI truncates
// the rest, so the server's own answer travels with the failure. The matcher
// is unchanged: a 500 still fails a test that expected a 404.
//
// The prescribed form in the step register -- expect({ status, body })
// .toMatchObject({ status: 404 }) -- was tried first and does not work:
// vitest prints "(3 matching properties omitted from actual)" and shows only
// the status, which is what it does today.
import { expect } from "vitest";
import type { Response } from "supertest";

// Superagent keeps the raw response text on `.text` for JSON as well as for
// HTML, so this is what the server actually sent rather than a
// re-serialisation of the parsed body. It is capped because an HTML error
// page or a long list would bury the failure it exists to explain, and the
// interesting part of an error is at the front.
const MAX_EVIDENCE_CHARS = 500;

export function serverSaid(res: Response): string {
  const text = typeof res.text === "string" ? res.text.trim() : "";
  if (text === "") return "server sent an empty body";
  const shown = text.slice(0, MAX_EVIDENCE_CHARS);
  return `server said: ${shown}${text.length > shown.length ? " ...(truncated)" : ""}`;
}

// `where` names which request failed when one test makes several -- the loops
// in riskiest-endpoints carried the path by comparing `${path} -> ${status}`
// strings, which named the request but never the answer.
export function expectStatus(res: Response, want: number, where?: string): void {
  expect(res.status, where === undefined ? serverSaid(res) : `${where}: ${serverSaid(res)}`).toBe(want);
}
