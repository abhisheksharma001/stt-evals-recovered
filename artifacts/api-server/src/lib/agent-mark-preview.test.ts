// U-2. The diff is a pure function so it can be exercised against a fixture
// assistant without a Vapi call -- and so the screen and (later) U-3's apply
// can never compute a different answer from the same inputs.
import { describe, expect, it } from "vitest";
import type { AgentMarkRow } from "@workspace/db";
import { buildMarkPreview, KEYTERM_LIMIT } from "./agent-mark-preview";
import type { VapiAssistantTranscriber } from "./vapi";

const config = (over: Partial<VapiAssistantTranscriber> = {}): VapiAssistantTranscriber => ({
  assistantId: "asst-1",
  name: "Parkville leasing",
  accountId: "acct-1",
  accountLabel: "Land And Apartment",
  primary: { provider: "deepgram", model: "flux-general-en" },
  fallback: [],
  keytermCount: 0,
  keyterms: [],
  numerals: null,
  language: "en",
  fetchedAt: "2026-09-09T00:00:00.000Z",
  ...over,
});

let n = 0;
const mark = (over: Partial<AgentMarkRow> = {}): AgentMarkRow =>
  ({
    id: `m-${++n}`,
    assistantId: "asst-1",
    callId: null,
    span: null,
    note: "a note",
    actionType: null,
    actionValue: null,
    status: "open",
    createdByLabel: "abhishek",
    createdAt: new Date("2026-09-09T00:00:00.000Z"),
    updatedAt: new Date("2026-09-09T00:00:00.000Z"),
    ...over,
  }) as AgentMarkRow;

describe("buildMarkPreview", () => {
  it("says nothing about a field no mark touches", () => {
    const p = buildMarkPreview(config(), [mark({ note: "just noting" })]);
    expect(p.fields).toEqual([]);
    expect(p.notesOnlyCount).toBe(1);
  });

  it("lists the words it would add and the words already there, separately", () => {
    const p = buildMarkPreview(config({ keyterms: ["Edison Hills", "Mary"], keytermCount: 2 }), [
      mark({ actionType: "keyterm", actionValue: "Parkville" }),
      mark({ actionType: "keyterm", actionValue: "edison hills" }),
    ]);
    const f = p.fields.find((x) => x.field === "keyterm")!;
    expect(f.added).toEqual(["Parkville"]);
    // Case and spacing do not make a second boost of the same word.
    expect(f.alreadyPresent).toEqual(["edison hills"]);
    expect(f.current).toBe("2 words");
    expect(f.after).toBe("3 words");
    expect(f.overLimit).toBe(false);
  });

  it("two people marking the same word is one addition, not two", () => {
    const p = buildMarkPreview(config(), [
      mark({ actionType: "keyterm", actionValue: "Parkville" }),
      mark({ actionType: "keyterm", actionValue: " parkville " }),
    ]);
    const f = p.fields.find((x) => x.field === "keyterm")!;
    expect(f.added).toEqual(["Parkville"]);
    expect(f.alreadyPresent).toEqual(["parkville"]);
    expect(f.markIds.length).toBe(2);
  });

  it("says the vendor cap would be passed instead of quietly cutting the list", () => {
    const existing = Array.from({ length: KEYTERM_LIMIT }, (_, i) => `term-${i}`);
    const p = buildMarkPreview(config({ keyterms: existing, keytermCount: existing.length }), [
      mark({ actionType: "keyterm", actionValue: "one too many" }),
    ]);
    const f = p.fields.find((x) => x.field === "keyterm")!;
    expect(f.overLimit).toBe(true);
    expect(f.limit).toBe(KEYTERM_LIMIT);
    // The term stays in `added`: the screen has to show what would be lost.
    expect(f.added).toEqual(["one too many"]);
  });

  it("offers to turn digits on only while they are off", () => {
    const off = buildMarkPreview(config({ numerals: false }), [mark({ actionType: "numerals" })]);
    expect(off.fields.find((x) => x.field === "numerals")).toMatchObject({ current: "off", after: "on" });

    const unset = buildMarkPreview(config({ numerals: null }), [mark({ actionType: "numerals" })]);
    expect(unset.fields.find((x) => x.field === "numerals")).toMatchObject({ current: "not set", after: "on" });

    // Already on: a row reading "on -> on" is a change that is not one.
    const on = buildMarkPreview(config({ numerals: true }), [mark({ actionType: "numerals" })]);
    expect(on.fields.find((x) => x.field === "numerals")).toBeUndefined();
  });

  it("hands a prompt mark back as words, never as a field to apply", () => {
    const p = buildMarkPreview(config(), [
      mark({ actionType: "prompt", actionValue: "read the unit number back", note: "it never confirms" }),
    ]);
    expect(p.fields).toEqual([]);
    expect(p.manualMarks).toEqual([
      { id: expect.any(String), note: "it never confirms", actionValue: "read the unit number back" },
    ]);
  });

  it("ignores marks that are not open", () => {
    const p = buildMarkPreview(config(), [
      mark({ actionType: "keyterm", actionValue: "Parkville", status: "dismissed" }),
      mark({ actionType: "numerals", status: "applied" }),
    ]);
    expect(p.fields).toEqual([]);
    expect(p.notesOnlyCount).toBe(0);
  });

  it("carries the moment of the read, because a stale preview is the hazard", () => {
    const p = buildMarkPreview(config({ fetchedAt: "2026-09-09T12:34:56.000Z" }), []);
    expect(p.fetchedAt).toBe("2026-09-09T12:34:56.000Z");
    expect(p.assistantName).toBe("Parkville leasing");
  });
});
