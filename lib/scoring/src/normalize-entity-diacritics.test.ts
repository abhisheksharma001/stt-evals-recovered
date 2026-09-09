import { describe, expect, it } from "vitest";
import { normalizeEntity, scoreEntities } from "./core";

// R-30 (ox-alpha B-19). NFKC keeps an accented letter as ONE precomposed
// codepoint, and the [^A-Z0-9] strip then removed the whole character -- so an
// accented word silently lost a letter. Entities and hypotheses both run
// through normalizeEntity, so the damage lands on the hypothesis side: a
// provider that transcribes the accented word correctly produced a normalised
// form that no longer contained the ASCII entity.
describe("normalizeEntity and diacritics", () => {
  it("folds an accent onto its base letter instead of deleting the letter", () => {
    expect(normalizeEntity("CAFÉ")).toBe("CAFE");
  });

  it("folds a lowercase accented word the same way", () => {
    expect(normalizeEntity("café")).toBe("CAFE");
  });

  it("handles an umlaut, which used to lose the vowel entirely", () => {
    // "MÜLLER" normalised to "MLLER", so the correct transcription
    // "MULLER" did not contain it and a right answer scored wrong.
    expect(normalizeEntity("MÜLLER")).toBe("MULLER");
  });

  it("treats a decomposed sequence and a precomposed character identically", () => {
    expect(normalizeEntity("É")).toBe(normalizeEntity("É"));
  });

  it("leaves a plain ASCII entity exactly as it was", () => {
    expect(normalizeEntity("ABC-123")).toBe("ABC123");
    expect(normalizeEntity("acme corp")).toBe("ACMECORP");
  });

  // Unchanged on purpose: a script with no A-Z0-9 form still normalises to
  // "", and scoreEntities guards that with `normalized.length > 0`.
  it("still yields an empty string for a value with no latin form", () => {
    expect(normalizeEntity("中文")).toBe("");
    expect(normalizeEntity("Здравствуй")).toBe("");
  });
});

describe("scoreEntities across an accent", () => {
  it("scores a correctly-transcribed accented word as correct", () => {
    const result = scoreEntities(
      [{ kind: "name", value: "Muller" } as never],
      "the caller said Müller twice",
    );
    expect(result.results[0].exactMatch).toBe(true);
  });

  it("matches an accented entity against an unaccented transcription too", () => {
    const result = scoreEntities(
      [{ kind: "name", value: "Müller" } as never],
      "the caller said Muller twice",
    );
    expect(result.results[0].exactMatch).toBe(true);
  });

  it("never counts an entity with no latin form as correct", () => {
    const result = scoreEntities(
      [{ kind: "name", value: "中文" } as never],
      "anything at all",
    );
    expect(result.results[0].exactMatch).toBe(false);
  });
});
