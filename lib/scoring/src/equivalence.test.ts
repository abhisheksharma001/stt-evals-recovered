import { describe, expect, it } from "vitest";
import { canonicalTranscript, markConventionOps, sameOnceCanonical } from "./equivalence";
import { diffWords, normalizeTranscript, type WordDiffOp } from "./index";

// Every pair here is a real one from the corpus (2026-08-30 mining run) or
// one Abhishek named. Left column: what one provider wrote; right: another.
describe("canonicalTranscript (T-101)", () => {
  it.each([
    ["1-bedroom", "1 bedroom"],
    ["one-bedroom", "1 bedroom"],
    ["1 -bedroom", "1-bedroom"],
    ["two-bedroom one-bath", "2 bedroom 1 bath"],
    ["highpriority", "highpriority"],
    ["high-priority", "high priority"],
    ["after -hours", "after-hours"],
    ["in -person", "in person"],
    ["his wi-fi", "his wi fi"],
    ["you um", "you"],
    ["um what's", "what's"],
    ["earlier um", "earlier"],
    ["all right", "alright"],
    ["ok", "okay"],
    ["yeah", "yes"],
    ["i'm going to", "i'm gonna"],
    ["saint louis", "st louis"],
    ["you ma 'am", "you ma'am"],
    ["fortyc", "40c"],
    ["fortyc", "forty c"],
    ["forty", "40"],
    ["twenty two", "22"],
    ["26th at 10am", "2 6 at 1 0 a m"],
    ["26th at 10am", "26 at 1 0 am"],
    ["3rd", "3"],
    ["27th", "2 7"],
    ["tour 2 4", "tour24"],
  ])("%s == %s", (a, b) => {
    expect(canonicalTranscript(a)).toBe(canonicalTranscript(b));
    expect(sameOnceCanonical([a, b])).toBe(true);
  });

  it.each([
    ["4", "forty"],
    ["2", "twenty"],
    ["lessee", "lissy"],
    ["you", "you'd"],
    ["1 8 5 9", "1 0 8 5 0 9"],
    ["", "in person"],
    ["sweet", ""],
    ["hills", "hill's"],
    ["apartment", "apartments"],
    ["are", "were"],
  ])("%s != %s (a real disagreement stays one)", (a, b) => {
    expect(canonicalTranscript(a)).not.toBe(canonicalTranscript(b));
  });

  it("is stable on already-canonical text and empty on filler-only text", () => {
    const c = canonicalTranscript("1 bedroom at 1 0 am");
    expect(canonicalTranscript(c)).toBe(c);
    expect(canonicalTranscript("um uh")).toBe("");
    expect(canonicalTranscript("")).toBe("");
  });
});

// R-6: the same list again, but through the word alignment the comparison
// view actually renders. The register's first wording marked ops one at a
// time; that misses the two commonest pairs in the mining above, because
// "1 bedroom" against "1-bedroom" is one word on one side and two on the
// other, so it arrives as a sub AND a del and neither op alone equals
// anything. markConventionOps marks runs for that reason.
const words = (text: string): string[] => normalizeTranscript(text).split(" ").filter(Boolean);
const marked = (reference: string, hypothesis: string): WordDiffOp[] =>
  markConventionOps(diffWords(words(reference), words(hypothesis)));
const differences = (ops: WordDiffOp[]) => ops.filter((op) => op.op !== "ok");

describe("markConventionOps (R-6)", () => {
  it.each([
    ["a 1 bedroom unit", "a 1-bedroom unit"],
    ["a one-bedroom unit", "a 1 bedroom unit"],
    ["i'm going to call", "i'm gonna call"],
    ["that is okay", "that is ok"],
    ["all right then", "alright then"],
    ["call me back", "call um me back"],
    ["call um me back", "call me back"],
    ["saint louis office", "st louis office"],
  ])("%s / %s -- every difference is a convention", (reference, hypothesis) => {
    const ops = marked(reference, hypothesis);
    const diffs = differences(ops);
    expect(diffs.length).toBeGreaterThan(0);
    for (const op of diffs) expect(op.convention).toBe(true);
    // Never on an "ok" op: an agreement was never a "difference that is
    // only a convention", and a view that hides on this flag alone would
    // otherwise be handed nothing to render.
    for (const op of ops.filter((o) => o.op === "ok")) expect(op.convention).toBeUndefined();
  });

  it.each([
    ["unit 4", "unit forty"],
    ["the apartment", "the apartments"],
    ["the lessee", "the lissy"],
  ])("%s / %s -- a real difference stays a difference", (reference, hypothesis) => {
    const diffs = differences(marked(reference, hypothesis));
    expect(diffs.length).toBeGreaterThan(0);
    for (const op of diffs) expect(op.convention).toBeUndefined();
  });

  it("hides nothing in a run that also holds a real error", () => {
    // The hyphen convention and a genuine plural land in ONE run of
    // consecutive non-ok ops. Marking the run would hide the plural behind
    // the hyphen, so the run is not marked at all -- err towards showing.
    const diffs = differences(marked("a 1 bedroom apartment", "a 1-bedroom apartments"));
    expect(diffs.length).toBeGreaterThan(0);
    for (const op of diffs) expect(op.convention).toBeUndefined();
  });

  it("changes no count and no word, only the mark", () => {
    const raw = diffWords(words("a 1 bedroom unit"), words("a 1-bedroom unit"));
    const ops = markConventionOps(raw);
    expect(ops.map((o) => [o.op, o.ref, o.hyp])).toEqual(raw.map((o) => [o.op, o.ref, o.hyp]));
    expect(differences(ops).length).toBe(differences(raw).length);
    // And the input is untouched -- the caller's array is still the raw
    // alignment, so nothing upstream of the mark can be changed by it.
    for (const op of raw) expect(op.convention).toBeUndefined();
  });
});
