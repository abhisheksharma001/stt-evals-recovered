import { describe, expect, it } from "vitest";
import { buildDisagreementSpans, type TimedWord } from "./spans";

function timed(text: string, startSec = 0, step = 0.5): TimedWord[] {
  return text.split(" ").map((word, i) => ({
    word,
    start: startSec + i * step,
    end: startSec + (i + 1) * step,
  }));
}

describe("buildDisagreementSpans", () => {
  it("finds the one disputed stretch and times it off the reference", () => {
    const result = buildDisagreementSpans([
      { providerId: "a", timedWords: timed("the number is three six six eight thanks", 10) },
      { providerId: "b", transcript: "the number is three six six eight thanks" },
      { providerId: "c", transcript: "the number is thirty six sixty eight thanks" },
    ]);
    expect(result.unavailableReason).toBeNull();
    expect(result.referenceProviderId).toBe("a");
    // Normalized (numbers become digits), one entry per reference token.
    expect(result.referenceWords).toHaveLength(8);
    expect(result.referenceWords.slice(0, 3)).toEqual(["the", "number", "is"]);
    expect(result.spans).toHaveLength(1);
    const span = result.spans[0]!;
    // T-22: the span's positions index straight into referenceWords.
    expect(result.referenceWords.slice(span.referencePositions[0], span.referencePositions[1] + 1).join(" ")).toBe(
      span.readings.find((r) => r.providerId === "a")!.text,
    );
    // "three six six eight" starts at position 3 -> 10 + 3*0.5 = 11.5s. Where
    // it ends depends on how the diff chooses to align "36 68" against
    // "3 6 6 8" (either is a valid minimum-edit alignment), so only bound it.
    expect(span.startMs).toBe(11500);
    expect(span.endMs).toBeGreaterThanOrEqual(13000);
    expect(span.endMs).toBeLessThanOrEqual(13500);
    expect(span.contextBefore).toBe("the number is");
    expect(span.contextAfter.endsWith("thanks")).toBe(true);
    const byProvider = Object.fromEntries(span.readings.map((r) => [r.providerId, r]));
    expect(byProvider.a!.agreesWithReference).toBe(true);
    expect(byProvider.b!.agreesWithReference).toBe(true);
    expect(byProvider.c!.agreesWithReference).toBe(false);
    expect(byProvider.c!.text).not.toBe(byProvider.a!.text);
  });

  // T-47: the reference is one vote, not the truth.
  it("names the plurality reading even when the reference is the outlier", () => {
    const result = buildDisagreementSpans([
      { providerId: "ref", timedWords: timed("they were here") },
      { providerId: "b", transcript: "they are here" },
      { providerId: "c", transcript: "they are here" },
      { providerId: "d", transcript: "they are here" },
    ]);
    expect(result.spans).toHaveLength(1);
    const span = result.spans[0]!;
    expect(span.majorityText).toBe("are");
    const byProvider = Object.fromEntries(span.readings.map((r) => [r.providerId, r]));
    expect(byProvider.ref!.agreesWithReference).toBe(true);
    expect(byProvider.ref!.agreesWithMajority).toBe(false);
    expect(byProvider.b!.agreesWithMajority).toBe(true);
  });

  it("has no majority on a tie", () => {
    const result = buildDisagreementSpans([
      { providerId: "ref", timedWords: timed("they were here") },
      { providerId: "b", transcript: "they are here" },
    ]);
    expect(result.spans[0]!.majorityText).toBeNull();
    expect(result.spans[0]!.readings.every((r) => !r.agreesWithMajority)).toBe(true);
  });

  it("returns no spans when everyone agrees", () => {
    const result = buildDisagreementSpans([
      { providerId: "a", timedWords: timed("hello there friend") },
      { providerId: "b", transcript: "Hello, there friend." },
    ]);
    expect(result.spans).toEqual([]);
    expect(result.unavailableReason).toBeNull();
  });

  it("says why when no provider returned timings", () => {
    const result = buildDisagreementSpans([
      { providerId: "a", transcript: "one two three" },
      { providerId: "b", transcript: "one two free" },
    ]);
    expect(result.spans).toEqual([]);
    expect(result.unavailableReason).toBe("no_word_timings");
    expect(result.referenceProviderId).toBeNull();
  });

  it("needs at least two candidates", () => {
    const result = buildDisagreementSpans([{ providerId: "a", timedWords: timed("only me") }]);
    expect(result.unavailableReason).toBe("fewer_than_two_candidates");
  });

  it("surfaces a word one provider dropped, and a word another added", () => {
    const result = buildDisagreementSpans([
      { providerId: "ref", timedWords: timed("please send the invoice today") },
      { providerId: "dropper", transcript: "please send invoice today" },
      { providerId: "adder", transcript: "please send the invoice today okay" },
    ]);
    expect(result.spans.length).toBeGreaterThanOrEqual(1);
    const readings = result.spans.flatMap((s) => s.readings);
    // The dropper has nothing where the reference has "the", so no reading
    // of its own ever contains that word.
    expect(readings.filter((r) => r.providerId === "dropper").every((r) => !r.text.split(" ").includes("the"))).toBe(true);
    // The adder's extra word attaches to the last reference position.
    expect(readings.some((r) => r.providerId === "adder" && r.text.endsWith("okay"))).toBe(true);
    // Both are flagged as disagreeing somewhere; the reference never is.
    expect(readings.some((r) => r.providerId === "dropper" && !r.agreesWithReference)).toBe(true);
    expect(readings.some((r) => r.providerId === "adder" && !r.agreesWithReference)).toBe(true);
    expect(readings.filter((r) => r.providerId === "ref").every((r) => r.agreesWithReference)).toBe(true);
  });

  it("merges nearby disagreements into one span but splits very long runs", () => {
    const refText = Array.from({ length: 30 }, (_, i) => `w${i}`).join(" ");
    const otherText = Array.from({ length: 30 }, (_, i) => `x${i}`).join(" ");
    const result = buildDisagreementSpans([
      { providerId: "a", timedWords: timed(refText) },
      { providerId: "b", transcript: otherText },
    ]);
    expect(result.spans.length).toBeGreaterThan(1);
    for (const span of result.spans) {
      expect(span.referencePositions[1] - span.referencePositions[0]).toBeLessThan(12);
    }
    // Spans come back in time order and do not overlap.
    for (let i = 1; i < result.spans.length; i += 1) {
      expect(result.spans[i]!.startMs).toBeGreaterThanOrEqual(result.spans[i - 1]!.endMs);
    }
  });

  it("prefers the longest timed candidate as the reference", () => {
    const result = buildDisagreementSpans([
      { providerId: "short", timedWords: timed("a b c") },
      { providerId: "long", timedWords: timed("a b c d e") },
    ]);
    expect(result.referenceProviderId).toBe("long");
  });
});
