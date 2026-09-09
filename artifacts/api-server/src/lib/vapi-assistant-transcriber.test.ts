// U-2. The mapping from Vapi's assistant JSON to the shape this project
// reads. It exists as its own function because a break test that emptied
// `keyterms` changed no result: every test built the shape by hand and
// nothing exercised the mapping. A field nobody proves you read is a field
// you are not reading.
import { describe, expect, it } from "vitest";
import { assistantTranscriberFrom } from "./vapi";

const from = (transcriber: unknown, name = "Parkville leasing") =>
  assistantTranscriberFrom(
    { id: "asst-1", name, transcriber: transcriber as never },
    "acct-1",
    "Land And Apartment",
  );

describe("assistantTranscriberFrom", () => {
  it("reads the boosted words themselves, not only how many there are", () => {
    const c = from({ provider: "deepgram", model: "flux-general-en", keyterm: ["Edison Hills", "Parkville"] });
    expect(c.keyterms).toEqual(["Edison Hills", "Parkville"]);
    expect(c.keytermCount).toBe(2);
  });

  it("drops entries that are not strings rather than carrying them into a diff", () => {
    // `keyterm` is typed `unknown` because Vapi's schema does not promise a
    // string array; a number in there would otherwise reach the preview.
    const c = from({ keyterm: ["Edison Hills", 42, null, "Parkville"] });
    expect(c.keyterms).toEqual(["Edison Hills", "Parkville"]);
    // The count stays the raw length: it is what the vendor holds, and the
    // two numbers disagreeing is itself the signal.
    expect(c.keytermCount).toBe(4);
  });

  it("an assistant with no transcriber block reads as empty, never as unknown-shaped", () => {
    const c = from(undefined);
    expect(c.keyterms).toEqual([]);
    expect(c.keytermCount).toBe(0);
    expect(c.primary).toBeNull();
    expect(c.fallback).toEqual([]);
    expect(c.numerals).toBeNull();
  });

  it("numerals is three-valued: on, off, and never set", () => {
    expect(from({ numerals: true }).numerals).toBe(true);
    expect(from({ numerals: false }).numerals).toBe(false);
    expect(from({}).numerals).toBeNull();
  });

  it("keeps the fallback chain in order and drops entries with no provider", () => {
    const c = from({
      provider: "deepgram",
      model: "flux-general-en",
      fallbackPlan: { transcribers: [{ provider: "assembly-ai" }, { model: "orphan" }, { provider: "gladia", model: " solaria " }] },
    });
    expect(c.fallback).toEqual([
      { provider: "assembly-ai", model: null },
      { provider: "gladia", model: "solaria" },
    ]);
  });

  it("falls back to the id when the assistant has no usable name", () => {
    expect(from({}, "   ").name).toBe("asst-1");
  });
});
