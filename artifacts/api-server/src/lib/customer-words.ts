/**
 * M-16: how many words the CUSTOMER said on a call, from its draft
 * transcript. `bulks.ts` opens the database at import time, so this lives on
 * its own and stays db-free -- same split as `empty-selection.ts` and
 * `audio-attempt.ts`.
 *
 * Order of operations is the whole trick. `normalizeTranscript` strips the
 * line-leading `AI:` / `User:` labels (v3, `lib/scoring/src/index.ts`), so
 * normalising first destroys the labels the count depends on and leaves you
 * counting the assistant's words too. Pull the customer's lines out FIRST,
 * then normalise the result.
 *
 * `customerTurnsOf` is M-15's, reused rather than copied: two extractors that
 * disagree about what counts as a customer turn is a bug waiting for the day
 * one of them is fixed.
 */
import { normalizeTranscript } from "@workspace/scoring";

import { customerTurnsOf } from "./confirmed-entities";

/**
 * Whitespace tokens of the customer's own speech, after normalisation
 * (punctuation folded away, number words folded to digits). A call with no
 * draft, or a draft where the customer never appears, is 0 -- not unknown:
 * 15 of the 176 calls on file have a draft that carries no `User:` line at
 * all, and every one of them is a call the customer really did not speak on.
 */
export function countCustomerWords(draft: string | null | undefined): number {
  const turns = customerTurnsOf(draft);
  if (!turns) return 0;
  const normalized = normalizeTranscript(turns);
  return normalized ? normalized.split(" ").length : 0;
}
