// T-87: the pure half of words-to-watch.ts. No db import so it is
// unit-tested without DATABASE_URL.
//
// Question this answers, per assistant: "which words keep coming out
// differently across providers?" -- a part number, a street name, a
// caller's surname. Each disagreement span (lib/scoring spans.ts) already
// carries every provider's reading and the plurality text (T-47). This
// groups spans by that plurality text across every call in a bulk and
// counts in how many calls it happened, so a word that trips providers on
// one call in fifty is separated from one that trips them on thirty.
//
// Nobody here decides which reading is right (T-86: no human judge). The
// list says where the providers split; a person listens if they care.
export type WatchSpanInput = {
  callId: string;
  majorityText: string | null;
  readings: { providerId: string; text: string }[];
};

export type WatchAlternative = { text: string; count: number; providerIds: string[] };

/** What kind of split this is. `number`: a digit is involved on any side
 *  (phone numbers, dates, amounts, unit numbers -- the ones that change the
 *  meaning of a call). `format`: the readings differ only in spelling
 *  convention -- "1-bedroom" / "one-bedroom", "in -person" / "in person",
 *  "wi fi" / "wifi", "you um" / "you" -- same words once hyphens, spaces,
 *  small number words and disfluencies are normalised (T-98, from the first
 *  live lists). `filler`: every reading is empty or a filler word ("um",
 *  "uh", "yeah"...) -- real disagreement, no meaning at stake. `word`:
 *  everything else. */
export type WatchKind = "number" | "word" | "format" | "filler";

const FILLERS = new Set(["", "um", "uh", "umm", "uhh", "hmm", "mm", "mhm", "yeah", "yep", "okay", "ok", "oh", "ah", "like", "so", "well", "right", "huh"]);
const isFillerText = (t: string) => t.split(/\s+/).every((w) => FILLERS.has(w.replace(/[^a-z0-9']/g, "")));

/** Disfluencies dropped before comparing readings for `format`. Narrower
 *  than FILLERS on purpose: "yeah" / "okay" / "right" carry an answer. */
const DISFLUENCIES = new Set(["um", "uh", "umm", "uhh", "hmm", "mm", "mhm", "ah"]);
const NUMBER_WORDS: Record<string, string> = {
  zero: "0", one: "1", two: "2", three: "3", four: "4", five: "5", six: "6", seven: "7", eight: "8", nine: "9", ten: "10",
  eleven: "11", twelve: "12", thirteen: "13", fourteen: "14", fifteen: "15", sixteen: "16", seventeen: "17", eighteen: "18", nineteen: "19",
  twenty: "20", thirty: "30", forty: "40", fifty: "50", sixty: "60", seventy: "70", eighty: "80", ninety: "90",
};

/** One reading reduced to what it says: lower-case, hyphens and stray
 *  hyphen spacing become plain spaces, apostrophe spacing closed ("ma 'am"),
 *  punctuation dropped, disfluencies dropped, "one".."ninety" as digits.
 *  Two readings with the same canonical form differ in convention only. */
export function canonicalReading(text: string): string {
  return text
    .toLowerCase()
    .replace(/\s*-+\s*/g, " ")
    .replace(/\s*'\s*/g, "'")
    .split(/\s+/)
    .map((w) => w.replace(/[^a-z0-9']/g, ""))
    .filter((w) => w !== "" && !DISFLUENCIES.has(w))
    .map((w) => NUMBER_WORDS[w] ?? w)
    .join(" ");
}

export function classifyWatchKind(texts: readonly string[]): WatchKind {
  if (texts.some((t) => /\d/.test(t))) {
    // "1-bedroom" vs "one-bedroom" is a digit on one side, but nothing is at
    // stake: it is the same number written two ways. Check format first.
    return sameOnceNormalised(texts) ? "format" : "number";
  }
  if (texts.every(isFillerText)) return "filler";
  return sameOnceNormalised(texts) ? "format" : "word";
}

function sameOnceNormalised(texts: readonly string[]): boolean {
  const distinct = new Set(texts);
  if (distinct.size < 2) return false;
  const canon = new Set([...distinct].map(canonicalReading));
  if (canon.has("")) return false;
  if (canon.size === 1) return true;
  // "wi fi" / "wifi", "1 0 8" / "108": same characters, different spacing.
  return new Set([...canon].map((c) => c.replace(/ /g, ""))).size === 1;
}

/** Long spans are usually a short disagreement wrapped in words every
 *  provider agreed on ("you can you forward me TO corporate do you mean" vs
 *  "... THE corporate ..."). Drop the tokens shared by every reading at the
 *  start and at the end so the row is about the split, not the sentence.
 *  Readings that share nothing are returned untouched, and so are short
 *  spans (any reading under four words): "main street" / "main st" is a
 *  better row than "street" / "st". */
export function trimCommonEdges(texts: readonly string[]): string[] {
  if (texts.length < 2) return [...texts];
  const toks = texts.map((t) => t.split(/\s+/).filter(Boolean));
  const shortest = Math.min(...toks.map((t) => t.length));
  if (shortest < 4) return [...texts];
  let p = 0;
  while (p < shortest && toks.every((t) => t[p]!.toLowerCase() === toks[0]![p]!.toLowerCase())) p++;
  let q = 0;
  while (p + q < shortest && toks.every((t) => t[t.length - 1 - q]!.toLowerCase() === toks[0]![toks[0]!.length - 1 - q]!.toLowerCase())) q++;
  if (p === 0 && q === 0) return [...texts];
  return toks.map((t) => t.slice(p, t.length - q).join(" "));
}

export type WatchWord = {
  /** The plurality reading (T-47), or -- on a tie -- the alphabetically first reading. */
  heardAs: string;
  kind: WatchKind;
  /** True when no reading had a plurality on any span behind this row. */
  noMajority: boolean;
  /** Distinct calls where providers split on this text. */
  calls: number;
  /** Spans (a call can carry several). */
  spans: number;
  /** The other readings, most frequent first, with who said them. */
  alternatives: WatchAlternative[];
  /** Up to three call ids, most spans first, for the "listen" link. */
  exampleCallIds: string[];
};

const DEFAULT_LIMIT = 30;
const SINK: Record<WatchKind, number> = { number: 0, word: 0, format: 1, filler: 2 };

function trimSpan(span: WatchSpanInput): WatchSpanInput {
  const texts = span.readings.map((r) => r.text);
  const trimmed = trimCommonEdges(texts);
  if (trimmed.every((t, i) => t === texts[i])) return span;
  const majorityIdx = span.majorityText === null ? -1 : texts.indexOf(span.majorityText);
  return {
    callId: span.callId,
    majorityText: majorityIdx === -1 ? span.majorityText : trimmed[majorityIdx]!,
    readings: span.readings.map((r, i) => ({ providerId: r.providerId, text: trimmed[i]! })),
  };
}

export function aggregateWordsToWatch(spans: WatchSpanInput[], limit = DEFAULT_LIMIT): WatchWord[] {
  type Entry = {
    heardAs: string;
    noMajorityAll: boolean;
    calls: Map<string, number>;
    spans: number;
    alternatives: Map<string, { count: number; providerIds: Set<string> }>;
  };
  const byText = new Map<string, Entry>();
  for (const raw of spans) {
    if (raw.readings.length === 0) continue;
    const span = trimSpan(raw);
    const tie = span.majorityText === null;
    const heardAs = tie ? [...span.readings].map((r) => r.text).sort()[0]! : span.majorityText!;
    // "Most heard nothing" spans are grouped by what the odd provider DID
    // hear, not lumped into one "(nothing)" row: "Deepgram hears 0 where
    // the others hear nothing" is a finding; "(nothing) vs 22 different
    // things" is not.
    const groupKey = heardAs === "" ? `\u0000${[...span.readings].map((r) => r.text).filter((t) => t !== "").sort()[0] ?? ""}` : heardAs;
    const entry = byText.get(groupKey) ?? { heardAs, noMajorityAll: true, calls: new Map(), spans: 0, alternatives: new Map() };
    if (!tie) entry.noMajorityAll = false;
    entry.calls.set(span.callId, (entry.calls.get(span.callId) ?? 0) + 1);
    entry.spans += 1;
    for (const r of span.readings) {
      if (r.text === heardAs) continue;
      const alt = entry.alternatives.get(r.text) ?? { count: 0, providerIds: new Set<string>() };
      alt.count += 1;
      alt.providerIds.add(r.providerId);
      entry.alternatives.set(r.text, alt);
    }
    byText.set(groupKey, entry);
  }
  return [...byText.entries()]
    .map(([, e]) => ({
      heardAs: e.heardAs,
      kind: classifyWatchKind([e.heardAs, ...e.alternatives.keys()]),
      noMajority: e.noMajorityAll,
      calls: e.calls.size,
      spans: e.spans,
      alternatives: [...e.alternatives.entries()]
        .map(([text, a]) => ({ text, count: a.count, providerIds: [...a.providerIds].sort() }))
        .sort((a, b) => b.count - a.count || a.text.localeCompare(b.text)),
      exampleCallIds: [...e.calls.entries()]
        .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
        .slice(0, 3)
        .map(([id]) => id),
    }))
    // Format-only splits, then fillers, last whatever their count: "um" vs
    // "" in every call is not what anyone opens this list for. Numbers and
    // words rank together.
    .sort((a, b) => SINK[a.kind] - SINK[b.kind] || b.calls - a.calls || b.spans - a.spans || a.heardAs.localeCompare(b.heardAs))
    .slice(0, limit);
}
