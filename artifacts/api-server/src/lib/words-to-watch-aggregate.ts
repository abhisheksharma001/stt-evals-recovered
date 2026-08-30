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
 *  meaning of a call). `filler`: every reading is empty or a filler word
 *  ("um", "uh", "yeah"...) -- real disagreement, no meaning at stake.
 *  `word`: everything else. */
export type WatchKind = "number" | "word" | "filler";

const FILLERS = new Set(["", "um", "uh", "umm", "uhh", "hmm", "mm", "mhm", "yeah", "yep", "okay", "ok", "oh", "ah", "like", "so", "well", "right", "huh"]);
const isFillerText = (t: string) => t.split(/\s+/).every((w) => FILLERS.has(w.replace(/[^a-z0-9']/g, "")));

export function classifyWatchKind(texts: readonly string[]): WatchKind {
  if (texts.some((t) => /\d/.test(t))) return "number";
  if (texts.every(isFillerText)) return "filler";
  return "word";
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

export function aggregateWordsToWatch(spans: WatchSpanInput[], limit = DEFAULT_LIMIT): WatchWord[] {
  type Entry = {
    heardAs: string;
    noMajorityAll: boolean;
    calls: Map<string, number>;
    spans: number;
    alternatives: Map<string, { count: number; providerIds: Set<string> }>;
  };
  const byText = new Map<string, Entry>();
  for (const span of spans) {
    if (span.readings.length === 0) continue;
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
    // Fillers last whatever their count: "um" vs "" in every call is not
    // what anyone opens this list for. Numbers and words rank together.
    .sort((a, b) => Number(a.kind === "filler") - Number(b.kind === "filler") || b.calls - a.calls || b.spans - a.spans || a.heardAs.localeCompare(b.heardAs))
    .slice(0, limit);
}
