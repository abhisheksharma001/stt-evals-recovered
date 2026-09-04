import { describe, expect, it } from "vitest";
import {
  compositeScore,
  diffWords,
  editCounts,
  normalizeEntity,
  normalizeTranscript,
  score,
  scoreEntities,
} from "./index";

// AC-MVP-5 requires the scoring pipeline to have unit tests covering >= 10
// documented edge cases for WER, normalization, and entity matching. Each
// `it()` below is one of those documented cases.

describe("normalizeTranscript", () => {
  it("1. lowercases and strips punctuation", () => {
    expect(normalizeTranscript("Hello, World!")).toBe("hello world");
  });

  it("2. collapses repeated whitespace", () => {
    expect(normalizeTranscript("hello   world\n\tfoo")).toBe("hello world foo");
  });

  it("3. keeps apostrophes and hyphens inside words", () => {
    expect(normalizeTranscript("It's a well-known VIN")).toBe("it's a well-known vin");
  });

  it("4. handles empty string", () => {
    expect(normalizeTranscript("")).toBe("");
  });

  // T-5 (base-solidity fix): a spelled-out digit-by-digit phone number and
  // a formatted one must normalize to the identical token stream --
  // otherwise providers are penalized for a formatting choice, not a
  // transcription error.
  it("5b. folds spoken digits and a formatted number to the same tokens", () => {
    const spelled = normalizeTranscript("call five five five one two three one two one two");
    const formatted = normalizeTranscript("call 555-123-1212");
    expect(spelled).toBe(formatted);
    expect(spelled).toBe("call 5 5 5 1 2 3 1 2 1 2");
  });

  // M-2: Vapi writes its transcripts as speaker-labelled lines. The labels
  // are not words anybody said -- left in, they cost a provider one deletion
  // per line of the reference.
  it("5c. drops a line-leading AI: / User: speaker label", () => {
    expect(normalizeTranscript("AI: hello there\nUser: hi")).toBe("hello there hi");
    // only the label goes: a "user" the label was standing in front of stays.
    expect(normalizeTranscript("AI: the user said no")).toBe("the user said no");
    // the acceptance sentence itself: a provider that heard every spoken
    // word scores 0, not two deletions for the two labels.
    const result = score({
      callId: "c1",
      vertical: "rush",
      providerId: "p1",
      goldTranscript: "AI: hello there\nUser: hi",
      hypothesisTranscript: "hello there hi",
      entities: [],
    });
    expect(result.wer).toBe(0);
  });

  it("5d. keeps the word 'user' when it is not a line-leading label", () => {
    expect(normalizeTranscript("the user said no")).toBe("the user said no");
    expect(normalizeTranscript("ask the AI: it knows")).toBe("ask the ai it knows");
  });
});

describe("editCounts (WER building block)", () => {
  it("5. identical sequences produce zero edits", () => {
    const edits = editCounts(["a", "b", "c"], ["a", "b", "c"]);
    expect(edits).toEqual({ substitutions: 0, deletions: 0, insertions: 0, referenceWords: 3 });
  });

  it("6. one substitution", () => {
    const edits = editCounts(["a", "b", "c"], ["a", "x", "c"]);
    expect(edits.substitutions).toBe(1);
    expect(edits.deletions).toBe(0);
    expect(edits.insertions).toBe(0);
  });

  it("7. one deletion (hypothesis missing a reference word)", () => {
    const edits = editCounts(["a", "b", "c"], ["a", "c"]);
    expect(edits.deletions).toBe(1);
  });

  it("8. one insertion (hypothesis has an extra word)", () => {
    const edits = editCounts(["a", "b"], ["a", "b", "c"]);
    expect(edits.insertions).toBe(1);
  });

  it("9. empty reference against non-empty hypothesis is all insertions", () => {
    const edits = editCounts([], ["a", "b"]);
    expect(edits).toEqual({ substitutions: 0, deletions: 0, insertions: 2, referenceWords: 0 });
  });

  it("10. empty hypothesis against non-empty reference is all deletions", () => {
    const edits = editCounts(["a", "b"], []);
    expect(edits).toEqual({ substitutions: 0, deletions: 2, insertions: 0, referenceWords: 2 });
  });
});

describe("diffWords (word-level alignment for the diff view)", () => {
  it("11. counts still agree with editCounts on the same input", () => {
    const ref = ["a", "b", "c"];
    const hyp = ["a", "x", "c", "d"];
    const ops = diffWords(ref, hyp);
    const counts = editCounts(ref, hyp);
    expect(ops.filter((o) => o.op === "sub")).toHaveLength(counts.substitutions);
    expect(ops.filter((o) => o.op === "del")).toHaveLength(counts.deletions);
    expect(ops.filter((o) => o.op === "ins")).toHaveLength(counts.insertions);
  });

  it("12. reports the exact substituted word pair, in order", () => {
    const ops = diffWords(["a", "b", "c"], ["a", "x", "c"]);
    expect(ops).toEqual([
      { op: "ok", ref: "a", hyp: "a" },
      { op: "sub", ref: "b", hyp: "x" },
      { op: "ok", ref: "c", hyp: "c" },
    ]);
  });

  it("13. a deletion carries the missed gold word with a null hyp", () => {
    const ops = diffWords(["a", "b", "c"], ["a", "c"]);
    expect(ops).toContainEqual({ op: "del", ref: "b", hyp: null });
  });

  it("14. an insertion carries the extra provider word with a null ref", () => {
    const ops = diffWords(["a", "b"], ["a", "b", "c"]);
    expect(ops).toContainEqual({ op: "ins", ref: null, hyp: "c" });
  });
});

describe("score (end-to-end WER)", () => {
  it("11. perfect transcript scores wer = 0", () => {
    const result = score({
      callId: "c1",
      vertical: "rush",
      providerId: "p1",
      goldTranscript: "the truck needs an oil change",
      hypothesisTranscript: "The truck needs an oil change.",
      entities: [],
    });
    expect(result.wer).toBe(0);
  });

  it("12. wer is null when the gold transcript is empty (undefined, not divide-by-zero)", () => {
    const result = score({
      callId: "c1",
      vertical: "rush",
      providerId: "p1",
      goldTranscript: "",
      hypothesisTranscript: "anything",
      entities: [],
    });
    expect(result.wer).toBeNull();
  });

  it("13. wer counts errors proportional to reference length", () => {
    const result = score({
      callId: "c1",
      vertical: "trucking",
      providerId: "p1",
      goldTranscript: "one two three four",
      hypothesisTranscript: "one two three five",
      entities: [],
    });
    expect(result.wer).toBeCloseTo(0.25);
  });
});

describe("normalizeEntity / scoreEntities", () => {
  it("14. entity normalization strips separators and casing for VIN-style ids", () => {
    expect(normalizeEntity("1hgcm82 633a-004352")).toBe("1HGCM82633A004352");
  });

  it("15. exact match is found even if hypothesis phrasing differs around it", () => {
    const { results, accuracy } = scoreEntities(
      [{ type: "vin", value: "1HGCM82633A004352" }],
      "the vin is 1 h g c m 8 2 6 3 3 a 0 0 4 3 5 2 confirmed",
    );
    expect(results[0].exactMatch).toBe(true);
    expect(accuracy).toBe(1);
  });

  it("16. missing entity is scored as a miss, not skipped", () => {
    const { accuracy } = scoreEntities(
      [{ type: "phone_number", value: "555-123-4567" }],
      "call back later",
    );
    expect(accuracy).toBe(0);
  });

  it("17. empty entity list yields null accuracy (no evidence), not zero", () => {
    const { accuracy, alphanumericAccuracy } = scoreEntities([], "some transcript");
    expect(accuracy).toBeNull();
    expect(alphanumericAccuracy).toBeNull();
  });

  it("18. alphanumeric accuracy is scored separately from plain-name entities", () => {
    const { accuracy, alphanumericAccuracy } = scoreEntities(
      [
        { type: "name", value: "John Smith" },
        { type: "unit_number", value: "12B" },
      ],
      "spoke with john smith about unit 12b",
    );
    expect(accuracy).toBe(1);
    expect(alphanumericAccuracy).toBe(1); // only "12B" counts toward this sub-metric
  });
});

describe("compositeScore", () => {
  it("19. returns null when WER or entity accuracy evidence is missing", () => {
    expect(
      compositeScore({
        wer: null,
        entityAccuracy: 0.9,
        alphanumericAccuracy: 0.9,
        latencyFinalMs: 500,
        costPerMinute: 0.01,
        maxLatencyFinalMs: 1000,
        maxCostPerMinute: 0.02,
      }),
    ).toBeNull();
  });

  it("20. a provider with zero WER and perfect entity accuracy scores higher than one with errors", () => {
    const perfect = compositeScore({
      wer: 0,
      entityAccuracy: 1,
      alphanumericAccuracy: 1,
      latencyFinalMs: 500,
      costPerMinute: 0.01,
      maxLatencyFinalMs: 1000,
      maxCostPerMinute: 0.02,
    });
    const flawed = compositeScore({
      wer: 0.3,
      entityAccuracy: 0.5,
      alphanumericAccuracy: 0.5,
      latencyFinalMs: 500,
      costPerMinute: 0.01,
      maxLatencyFinalMs: 1000,
      maxCostPerMinute: 0.02,
    });
    expect(perfect).not.toBeNull();
    expect(flawed).not.toBeNull();
    expect(perfect as number).toBeGreaterThan(flawed as number);
  });
});
