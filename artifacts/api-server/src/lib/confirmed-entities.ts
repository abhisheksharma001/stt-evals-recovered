/**
 * M-15: the pure half of the confirmed-entity grill.
 *
 * The question this exists to answer, before any feature is built on it:
 * when the production assistant called a tool with a value the customer
 * said -- a phone number, a name, a date -- did the tool succeed, and does
 * that value appear in the customer's own turns? If it does, the pair is a
 * reference a run could be scored against without a human writing gold.
 *
 * Split from the runner (mine-confirmed-entities.ts) for the same reason
 * production-signals.ts is split from backfill-m7a-production-signals.ts:
 * the rules below are the part that can be wrong, so they are the part that
 * gets tested. The runner only reads disk and prints counts.
 *
 * Nothing here takes a value out of the corpus. Callers get verdicts and
 * booleans; the argument values themselves never leave the process.
 */
import { normalizeEntity } from "@workspace/scoring";

/** What a tool result says about itself. `unknown` is not `succeeded`. */
export type ToolOutcome = "succeeded" | "failed" | "unknown";

function parseJson(value: string): unknown {
  try {
    return JSON.parse(value);
  } catch {
    return undefined;
  }
}

function record(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

/**
 * Unwraps one result into the payloads that could carry a status.
 *
 * Counted on the 100 saved artifacts, 2026-09-08: every result is a string.
 * 49 of the 119 parse to MCP content blocks -- `{ type: "text", text }` --
 * whose `text` is itself JSON, and that inner object is where the status
 * lives. Missing that second parse is what made the register's original
 * rule look at a level with no status field on it at all.
 */
function payloadsOf(rawResult: unknown): Record<string, unknown>[] {
  if (typeof rawResult !== "string") return [];
  const parsed = parseJson(rawResult);
  if (parsed === undefined) return [];
  const items = Array.isArray(parsed) ? parsed : [parsed];
  const out: Record<string, unknown>[] = [];
  for (const item of items) {
    const obj = record(item);
    if (!obj) continue;
    if (obj.type === "text" && typeof obj.text === "string") {
      const inner = record(parseJson(obj.text));
      if (inner) out.push(inner);
      continue;
    }
    out.push(obj);
  }
  return out;
}

/**
 * M-15. Whether a tool reported success, by structure -- never by searching
 * the text for a word.
 *
 * Two shapes report a status, counted on the corpus 2026-09-08:
 *   34 of 119   a boolean `successful`, beside keys named `data` and `error`
 *    8 of 119   nodemailer's `accepted` / `rejected` arrays (the email tools)
 *   77 of 119   free text with no status of any kind
 *
 * The 77 are `unknown`, and a caller must not read that as success. The
 * word rule the register originally proposed -- "result text without
 * `error`" -- fails on exactly the rows that answer honestly: all 34 carry
 * the substring "error" because that is one of their key names, so the rule
 * would mark every reliably-succeeded call as a failure and leave the 77
 * unjudgeable ones looking clean. Backwards on both halves.
 */
export function toolOutcome(rawResult: unknown): ToolOutcome {
  for (const payload of payloadsOf(rawResult)) {
    if (typeof payload.successful === "boolean") {
      return payload.successful ? "succeeded" : "failed";
    }
    if (Array.isArray(payload.accepted) && Array.isArray(payload.rejected)) {
      return payload.accepted.length > 0 && payload.rejected.length === 0 ? "succeeded" : "failed";
    }
  }
  return "unknown";
}

/**
 * The customer's own words, joined.
 *
 * Vapi writes a draft as `AI:` / `User:` lines (SCORING_VERSION v3's note).
 * 175 of 176 calls have a draft and 175 carry an `AI:` label, but only 161
 * carry a `User:` label -- 14 drafts are assistant-only. Those return "",
 * and the runner counts them as their own bucket: a call where the customer
 * never appears cannot confirm a reference and cannot deny one either.
 */
export function customerTurnsOf(draft: string | null | undefined): string {
  if (!draft) return "";
  const lines: string[] = [];
  for (const line of draft.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed.startsWith("User:")) continue;
    const said = trimmed.slice("User:".length).trim();
    if (said) lines.push(said);
  }
  return lines.join(" ");
}

export type MentionCheck = {
  /** The value appears in the customer's turns after normalizeEntity(). */
  present: boolean;
  /** Short enough that `present` could be a substring accident -- see below. */
  fragile: boolean;
};

/**
 * normalizeEntity() strips every separator and upper-cases, so the joined
 * turns become one long run of A-Z0-9 and the check is a substring test.
 * That is what makes it work on "(555) 123-4567" vs "555-123-4567", and it
 * is also why a short value matches by accident: "ANN" is inside "CANNOT".
 *
 * Rather than pick an arbitrary minimum length and silently drop values,
 * a match of four normalized characters or fewer is reported as fragile and
 * counted separately, so the "are there 10 usable references" answer can be
 * read with and without them instead of resting on an inflated number.
 */
export const FRAGILE_MAX_LENGTH = 4;

export function mentionsEntity(customerTurns: string, value: string): MentionCheck {
  const needle = normalizeEntity(value);
  if (!needle) return { present: false, fragile: false };
  const present = normalizeEntity(customerTurns).includes(needle);
  return { present, fragile: present && needle.length <= FRAGILE_MAX_LENGTH };
}

export type ToolCallArgument = { tool: string; name: string; value: string };

/**
 * The string arguments of one tool call, flattened. Non-string arguments
 * are dropped here -- of 318 argument values in the corpus, 275 are
 * strings and the rest are numbers, booleans and one array, none of which
 * is a thing a customer says out loud.
 */
export function stringArgumentsOf(tool: string, rawArguments: unknown): ToolCallArgument[] {
  const parsed =
    typeof rawArguments === "string" ? record(parseJson(rawArguments)) : record(rawArguments);
  if (!parsed) return [];
  const out: ToolCallArgument[] = [];
  for (const [name, value] of Object.entries(parsed)) {
    if (typeof value === "string" && value.trim()) out.push({ tool, name, value });
  }
  return out;
}
