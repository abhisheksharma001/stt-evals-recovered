// U-2: what the open marks WOULD change on an assistant, before anything is
// sent. A pure function over (live config, open marks) so it can be tested
// against a fixture assistant without a Vapi call -- and so U-3's apply and
// this screen can never compute a different answer from the same inputs.
//
// Nothing here writes. Nothing here is allowed to decide anything either: a
// prompt mark is returned as words for a person to act on, never as a
// machine-applicable edit.
import type { AgentMarkRow } from "@workspace/db";
import type { VapiAssistantTranscriber } from "./vapi";

/** Deepgram's cap on `keyterm` (M-19a). Past it the request is not partially
 *  honoured, so the preview says so rather than silently truncating. */
export const KEYTERM_LIMIT = 100;

export type MarkPreviewField = {
  /** The wire field on the Vapi transcriber this row would change. */
  field: "keyterm" | "numerals";
  /** What it is called on screen -- never the vendor's word for it. */
  label: string;
  /** The live value, in words. */
  current: string;
  /** The value after these marks, in words. */
  after: string;
  /** keyterm only: terms these marks add, and terms already on the assistant. */
  added: string[];
  alreadyPresent: string[];
  /** True when applying would push the list past the vendor's cap. */
  overLimit: boolean;
  limit: number | null;
  /** The marks that produced this row, so the screen can select per item. */
  markIds: string[];
};

export type MarkPreview = {
  assistantId: string;
  assistantName: string;
  accountLabel: string;
  /** When the live read happened. A preview older than the apply is exactly
   *  the hazard U-3's 409 exists for, so the moment is part of the answer. */
  fetchedAt: string;
  fields: MarkPreviewField[];
  /** Prompt marks: text for a person. Never applied by anything. */
  manualMarks: Array<{ id: string; note: string; actionValue: string | null }>;
  /** Marks with no action yet -- counted so the screen can say the list is
   *  bigger than the change is. */
  notesOnlyCount: number;
};

/** Case- and whitespace-insensitive, because "edison hills" and "Edison
 *  Hills" are the same boost to Deepgram and two rows to a naive diff. */
function sameTerm(a: string, b: string): boolean {
  return a.trim().toLowerCase() === b.trim().toLowerCase();
}

export function buildMarkPreview(config: VapiAssistantTranscriber, marks: AgentMarkRow[]): MarkPreview {
  const open = marks.filter((m) => m.status === "open");
  const fields: MarkPreviewField[] = [];

  const keytermMarks = open.filter((m) => m.actionType === "keyterm" && (m.actionValue ?? "").trim().length > 0);
  if (keytermMarks.length > 0) {
    const added: string[] = [];
    const alreadyPresent: string[] = [];
    const ids: string[] = [];
    for (const m of keytermMarks) {
      const term = m.actionValue!.trim();
      ids.push(m.id);
      // Already on the assistant, or already added by an earlier mark in
      // this same basket -- two people marking the same word is the normal
      // case, not an error, and it must not become a duplicate boost.
      if (config.keyterms.some((k) => sameTerm(k, term)) || added.some((k) => sameTerm(k, term))) {
        if (!alreadyPresent.some((k) => sameTerm(k, term))) alreadyPresent.push(term);
        continue;
      }
      added.push(term);
    }
    const after = [...config.keyterms, ...added];
    fields.push({
      field: "keyterm",
      label: "Words the agent is taught",
      current: `${config.keyterms.length} word${config.keyterms.length === 1 ? "" : "s"}`,
      after: `${after.length} word${after.length === 1 ? "" : "s"}`,
      added,
      alreadyPresent,
      overLimit: after.length > KEYTERM_LIMIT,
      limit: KEYTERM_LIMIT,
      markIds: ids,
    });
  }

  const numeralsMarks = open.filter((m) => m.actionType === "numerals");
  // Nothing to show when it is already on: a row reading "on -> on" is a
  // change that is not one.
  if (numeralsMarks.length > 0 && config.numerals !== true) {
    fields.push({
      field: "numerals",
      label: "Numbers written as digits",
      current: config.numerals === false ? "off" : "not set",
      after: "on",
      added: [],
      alreadyPresent: [],
      overLimit: false,
      limit: null,
      markIds: numeralsMarks.map((m) => m.id),
    });
  }

  return {
    assistantId: config.assistantId,
    assistantName: config.name,
    accountLabel: config.accountLabel,
    fetchedAt: config.fetchedAt,
    fields,
    manualMarks: open
      .filter((m) => m.actionType === "prompt")
      .map((m) => ({ id: m.id, note: m.note, actionValue: m.actionValue })),
    notesOnlyCount: open.filter((m) => m.actionType === null).length,
  };
}
