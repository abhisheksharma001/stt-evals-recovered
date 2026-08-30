import { describe, expect, it } from "vitest";
import { canonicalTranscript, sameOnceCanonical } from "./equivalence";

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
