import type { Response } from "express";
import type { ZodError, ZodIssue } from "@workspace/api-zod";

/**
 * T-150: say what is wrong with the request in a sentence.
 *
 * Every route answered a validation failure with `zodError.message`, which is
 * zod's own `JSON.stringify` of its issue array. The generated client turns an
 * error body into `HTTP 400 Bad Request: <the error field>`, so what actually
 * reached the screen was:
 *
 *   HTTP 400 Bad Request: [ { "code": "invalid_type", "expected": "object",
 *   "received": "undefined", "path": [ "criteria" ], "message": "Required" } ]
 *
 * -- machine internals, in a place only a person reads. The issues carry
 * everything needed to say it plainly instead; this turns them into
 * "criteria is required", keyed off the issue code so nothing is parsed out
 * of prose.
 *
 * The status stays 400 and the field stays `error`, so no caller changes.
 */

const MAX_ISSUES = 5;

/** "criteria.window", or a name for the whole body when the path is empty. */
function nameOf(issue: ZodIssue): string {
  const path = issue.path.filter((p: string | number) => p !== "").join(".");
  return path === "" ? "the request" : path;
}

function describeIssue(issue: ZodIssue): string {
  const name = nameOf(issue);
  switch (issue.code) {
    case "invalid_type":
      // zod reports a missing value as `received: "undefined"` -- the single
      // most common failure, and the one worth naming exactly (T-142 removed
      // the coercion that used to hide it).
      return issue.received === "undefined" || issue.received === "null"
        ? `${name} is required`
        : `${name} must be a ${issue.expected}, not ${issue.received === "array" ? "an array" : `a ${issue.received}`}`;
    case "invalid_string":
      return typeof issue.validation === "string"
        ? `${name} must be a valid ${issue.validation}`
        : `${name} is not in the expected format`;
    case "invalid_enum_value":
      return `${name} must be one of: ${issue.options.join(", ")}`;
    case "too_small": {
      // "at least 2" is meaningless without saying 2 of what.
      const unit = issue.type === "string" ? " characters" : issue.type === "array" ? " items" : "";
      return (issue.type === "string" || issue.type === "array") && Number(issue.minimum) <= 1
        ? `${name} must not be empty`
        : `${name} must be at least ${issue.minimum}${unit}`;
    }
    case "too_big": {
      const unit = issue.type === "string" ? " characters" : issue.type === "array" ? " items" : "";
      return `${name} must be at most ${issue.maximum}${unit}`;
    }
    case "unrecognized_keys":
      return `${name} has unexpected field(s): ${issue.keys.join(", ")}`;
    default:
      // Union members, refinements and anything zod adds later: keep zod's own
      // sentence, but say which field it is about.
      return name === "the request" ? issue.message : `${name}: ${issue.message}`;
  }
}

export function describeInvalidInput(error: ZodError): string {
  const seen: string[] = [];
  for (const issue of error.issues) {
    const text = describeIssue(issue);
    if (!seen.includes(text)) seen.push(text);
  }
  if (seen.length === 0) return "The request is not valid.";
  const shown = seen.slice(0, MAX_ISSUES).join("; ");
  const hidden = seen.length - MAX_ISSUES;
  return hidden > 0 ? `${shown} (and ${hidden} more problem${hidden === 1 ? "" : "s"})` : shown;
}

/** The one way a route answers a failed `safeParse`. */
export function respondInvalid(res: Response, error: ZodError): void {
  res.status(400).json({ error: describeInvalidInput(error) });
}
