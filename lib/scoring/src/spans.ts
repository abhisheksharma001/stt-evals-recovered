// T-08: disagreement spans -- "where exactly do the providers hear this call
// differently, and when in the audio is that?"
//
// The hybrid pass (hybrid.ts) already knows THAT providers disagree and how
// much; it works on normalized word positions and never touches time. This
// module turns those positions into something a human can adjudicate by
// ear: a list of short spans, each with a start/end in seconds taken from a
// provider that returned word-level timings, and every provider's reading
// of that stretch side by side.
//
// Deliberately gold-free, like everything in hybrid.ts: the reference
// provider here is only an alignment anchor and a clock, never "the right
// answer". Its own words appear as one reading among the others.

import { diffWords, normalizeTranscript } from "./index";

export type TimedWord = { word: string; start: number; end: number };

/** One provider's transcript, as raw words with timings when the provider
 *  returned them, or as plain text when it did not. Both shapes are
 *  tokenized the same way (per word, through normalizeTranscript) so that
 *  alignment is not skewed by which providers happen to have timings. */
export type SpanCandidate =
  | { providerId: string; timedWords: TimedWord[] }
  | { providerId: string; transcript: string };

type Token = { text: string; start: number | null; end: number | null };

export type SpanReading = {
  providerId: string;
  /** This provider's words aligned to the span, normalized. Empty string
   *  when the provider produced nothing here. */
  text: string;
  /** True when this reading is identical to the reference's. */
  agreesWithReference: boolean;
  /** T-47: true when this reading is the span's plurality text (see
   *  `DisagreementSpan.majorityText`). False for everyone when there is
   *  no plurality. */
  agreesWithMajority: boolean;
};

export type DisagreementSpan = {
  /** Start/end of the disputed words, in milliseconds, from the reference
   *  provider's timings. Integers so they can key an adjudication row. */
  startMs: number;
  endMs: number;
  /** A couple of reference words either side, for reading in context. */
  contextBefore: string;
  contextAfter: string;
  /** Normalized reference positions covered, inclusive. Diagnostic only. */
  referencePositions: [number, number];
  readings: SpanReading[];
  /** T-47: the text most providers gave for this span, when one text has
   *  strictly more votes than any other -- consensus-relative, the same
   *  idea hybrid.ts uses per position. Null on a tie (2 vs 2, 1-1-1). The
   *  reference is just one vote here: when four say "are" and the
   *  reference alone says "were", the majority is "are". */
  majorityText: string | null;
};

export type DisagreementSpansResult = {
  /** Which provider supplied the clock and alignment anchor. */
  referenceProviderId: string | null;
  /** The reference provider's normalized words, in order. T-22: lets a UI
   *  show one flowing reading of the call with each span's
   *  `referencePositions` swapped for the disputed readings, instead of
   *  every provider's full transcript side by side. Empty when there is
   *  no reference. */
  referenceWords: string[];
  spans: DisagreementSpan[];
  /** Why there are no spans, when the reason is structural rather than
   *  "everyone agreed": nothing to build from. */
  unavailableReason: "no_word_timings" | "fewer_than_two_candidates" | null;
};

/** Positions this far apart or closer are merged into one span, so a
 *  disputed phone number read as "36 68" vs "3668" does not become four
 *  one-word spans that each need their own listen. */
const MERGE_GAP_POSITIONS = 2;
/** A run of disagreement longer than this is almost always a diff that
 *  lost alignment (one provider dropped a whole turn), not one disputed
 *  phrase. Split so each piece is still a 3-5 second listen. */
const MAX_SPAN_POSITIONS = 12;
const CONTEXT_WORDS = 3;

function tokenizeWord(word: string): string[] {
  return normalizeTranscript(word).split(" ").filter(Boolean);
}

function tokenize(candidate: SpanCandidate): Token[] {
  if ("timedWords" in candidate) {
    const tokens: Token[] = [];
    for (const w of candidate.timedWords) {
      // A raw word that normalizes to several tokens ("3668" -> "3 6 6 8")
      // shares its timing across all of them -- the audio does not know
      // where one digit ends.
      for (const text of tokenizeWord(w.word)) tokens.push({ text, start: w.start, end: w.end });
    }
    return tokens;
  }
  return candidate.transcript
    .split(/\s+/)
    .flatMap(tokenizeWord)
    .map((text) => ({ text, start: null, end: null }));
}

/**
 * T-47: plurality text across readings, or null when no single text has
 * strictly the most votes. Shared with judge-agreement.ts so "majority vs
 * human" is computed by exactly the rule the span UI shows.
 */
export function majorityReadingText(readings: readonly { text: string }[]): string | null {
  const votes = new Map<string, number>();
  for (const r of readings) votes.set(r.text, (votes.get(r.text) ?? 0) + 1);
  let best: string | null = null;
  let bestVotes = 0;
  let tied = false;
  for (const [text, n] of votes) {
    if (n > bestVotes) {
      best = text;
      bestVotes = n;
      tied = false;
    } else if (n === bestVotes) {
      tied = true;
    }
  }
  return tied ? null : best;
}

/**
 * Builds disagreement spans for one call from every provider's reading of
 * it. Returns spans in time order.
 */
export function buildDisagreementSpans(candidates: SpanCandidate[]): DisagreementSpansResult {
  if (candidates.length < 2) {
    return { referenceProviderId: null, referenceWords: [], spans: [], unavailableReason: "fewer_than_two_candidates" };
  }
  const tokenized = candidates.map((c) => ({ providerId: c.providerId, tokens: tokenize(c) }));

  // The reference must have timings (it is the clock). Among those that do,
  // prefer the longest: alignment against the fullest transcript loses the
  // fewest words to unanchored insertions.
  const timed = tokenized.filter((t) => t.tokens.length > 0 && t.tokens.every((tok) => tok.start !== null));
  if (timed.length === 0) {
    return { referenceProviderId: null, referenceWords: [], spans: [], unavailableReason: "no_word_timings" };
  }
  const reference = [...timed].sort((a, b) => b.tokens.length - a.tokens.length)[0]!;
  const refWords = reference.tokens.map((t) => t.text);
  const positionCount = refWords.length;

  // Per candidate, per reference position: the words that candidate has
  // there. Insertions (words with no reference slot) attach to the position
  // just before them, so they surface as a disagreement at that position
  // instead of vanishing.
  const alignedByProvider = new Map<string, string[][]>();
  for (const t of tokenized) {
    const aligned: string[][] = Array.from({ length: positionCount }, () => []);
    if (t.providerId === reference.providerId) {
      refWords.forEach((w, i) => aligned[i]!.push(w));
    } else {
      let pos = 0;
      for (const op of diffWords(refWords, t.tokens.map((tok) => tok.text))) {
        if (op.op === "ok" || op.op === "sub") {
          aligned[pos]!.push(op.hyp!);
          pos += 1;
        } else if (op.op === "del") {
          pos += 1;
        } else {
          aligned[Math.max(0, Math.min(pos, positionCount) - 1)]!.push(op.hyp!);
        }
      }
    }
    alignedByProvider.set(t.providerId, aligned);
  }

  const disagreeing: boolean[] = Array.from({ length: positionCount }, (_, p) => {
    const refText = refWords[p]!;
    for (const t of tokenized) {
      const words = alignedByProvider.get(t.providerId)![p]!;
      if (words.join(" ") !== refText) return true;
    }
    return false;
  });

  // Group disagreeing positions into runs, merging across small gaps and
  // splitting runs that grew too long to be one listen.
  const runs: Array<[number, number]> = [];
  let current: [number, number] | null = null;
  for (let p = 0; p < positionCount; p += 1) {
    if (!disagreeing[p]) continue;
    if (current && p - current[1] <= MERGE_GAP_POSITIONS && p - current[0] < MAX_SPAN_POSITIONS) {
      current[1] = p;
    } else {
      current = [p, p];
      runs.push(current);
    }
  }

  const spans: DisagreementSpan[] = runs.map(([first, last]) => {
    const startMs = Math.round(reference.tokens[first]!.start! * 1000);
    const endMs = Math.round(reference.tokens[last]!.end! * 1000);
    const texts = tokenized.map((t) => ({
      providerId: t.providerId,
      text: alignedByProvider
        .get(t.providerId)!
        .slice(first, last + 1)
        .flat()
        .join(" "),
    }));
    const majorityText = majorityReadingText(texts);
    const refText = refWords.slice(first, last + 1).join(" ");
    const readings: SpanReading[] = texts.map(({ providerId, text }) => ({
      providerId,
      text,
      agreesWithReference: text === refText,
      agreesWithMajority: majorityText !== null && text === majorityText,
    }));
    return {
      startMs,
      endMs: Math.max(endMs, startMs),
      contextBefore: refWords.slice(Math.max(0, first - CONTEXT_WORDS), first).join(" "),
      contextAfter: refWords.slice(last + 1, last + 1 + CONTEXT_WORDS).join(" "),
      referencePositions: [first, last],
      readings,
      majorityText,
    };
  });

  return { referenceProviderId: reference.providerId, referenceWords: refWords, spans, unavailableReason: null };
}
