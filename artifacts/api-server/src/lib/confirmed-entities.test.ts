// M-15: the rules the grill script rests on, proved against synthetic
// fixtures rather than the corpus -- the real artifacts hold a caller's
// phone number and their words, and a test that has to read PII to prove
// itself is a test nobody can run twice.
//
// The shapes below are the shapes actually counted on the 100 saved
// artifacts on 2026-09-08: an MCP content block whose `text` is itself JSON
// carrying `{ successful, data, error }` (34 of 119), a nodemailer object
// with `accepted`/`rejected` (8), and free text with no status at all (77).
import { describe, expect, it } from "vitest";
import {
  FRAGILE_MAX_LENGTH,
  customerTurnsOf,
  mentionsEntity,
  stringArgumentsOf,
  tallyToolCall,
  toolOutcome,
} from "./confirmed-entities";

/** The corpus's own wrapper: a content block whose text is another JSON doc. */
const mcp = (payload: unknown) => JSON.stringify([{ type: "text", text: JSON.stringify(payload) }]);

describe("toolOutcome", () => {
  it("reads the boolean status out of the MCP content block", () => {
    expect(toolOutcome(mcp({ successful: true, data: { id: "x" }, error: null }))).toBe("succeeded");
    expect(toolOutcome(mcp({ successful: false, data: null, error: "nope" }))).toBe("failed");
  });

  // The register's original rule was "result text without `error`". Every
  // reliably-succeeded result in this corpus contains that substring,
  // because `error` is one of its key names -- so the word rule marked the
  // only honestly-reported rows as failures. This is that case.
  it("does not fail a succeeded result just because the word error appears in it", () => {
    const raw = mcp({ successful: true, data: { note: "ok" }, error: null });
    expect(raw).toContain("error");
    expect(toolOutcome(raw)).toBe("succeeded");
  });

  // The other half of the same inversion: 77 results carry no status, and
  // some of them say "success" in prose. Absent is not success.
  it("calls a result with no status field unknown, even when it says success", () => {
    expect(toolOutcome("Transfer to the leasing office was a success.")).toBe("unknown");
    expect(toolOutcome("Call ended.")).toBe("unknown");
  });

  it("reads nodemailer's accepted and rejected arrays", () => {
    expect(toolOutcome(JSON.stringify({ accepted: ["a@b.c"], rejected: [], response: "250 OK" }))).toBe(
      "succeeded",
    );
    expect(toolOutcome(JSON.stringify({ accepted: [], rejected: ["a@b.c"], response: "550" }))).toBe(
      "failed",
    );
  });

  it("is unknown for anything it cannot read, and never throws", () => {
    expect(toolOutcome(undefined)).toBe("unknown");
    expect(toolOutcome(null)).toBe("unknown");
    expect(toolOutcome(42)).toBe("unknown");
    expect(toolOutcome("{ not json")).toBe("unknown");
    expect(toolOutcome(JSON.stringify([{ type: "text", text: "not json either" }]))).toBe("unknown");
    expect(toolOutcome(JSON.stringify({ data: {}, error: null }))).toBe("unknown");
  });

  it("takes the first decisive payload when a result carries several", () => {
    const raw = JSON.stringify([
      { type: "text", text: JSON.stringify({ note: "no status here" }) },
      { type: "text", text: JSON.stringify({ successful: false, error: "boom" }) },
    ]);
    expect(toolOutcome(raw)).toBe("failed");
  });
});

describe("customerTurnsOf", () => {
  const draft = ["AI: Thanks for calling.", "User: my number is 555-123-4567", "AI: Got it.", "User: yes"].join(
    "\n",
  );

  it("keeps the customer's lines only, without the label", () => {
    expect(customerTurnsOf(draft)).toBe("my number is 555-123-4567 yes");
  });

  // 14 of the 161 drafts that carry an AI: label carry no User: line at all.
  // A call where the customer never appears cannot confirm a reference and
  // cannot deny one either, so it must be distinguishable from "not found".
  it("returns empty for an assistant-only draft, and for no draft", () => {
    expect(customerTurnsOf("AI: Hello?\nAI: Anyone there?")).toBe("");
    expect(customerTurnsOf(null)).toBe("");
    expect(customerTurnsOf(undefined)).toBe("");
    expect(customerTurnsOf("")).toBe("");
  });
});

describe("mentionsEntity", () => {
  const turns = "my number is 555-123-4567 and my name is Rodriguez";

  it("matches across separators, which is the whole reason for normalizeEntity", () => {
    expect(mentionsEntity(turns, "(555) 123-4567").present).toBe(true);
    expect(mentionsEntity(turns, "+15551234567").present).toBe(false);
    expect(mentionsEntity(turns, "Rodriguez").present).toBe(true);
  });

  it("does not report a value the customer never said", () => {
    expect(mentionsEntity(turns, "555-999-0000").present).toBe(false);
    expect(mentionsEntity("", "Rodriguez").present).toBe(false);
  });

  // An empty or punctuation-only value normalizes to "", and "".includes()
  // is true for every string -- it would report a match on every call.
  it("never matches on a value that normalizes to nothing", () => {
    expect(mentionsEntity(turns, "   ").present).toBe(false);
    expect(mentionsEntity(turns, "-- ...").present).toBe(false);
  });

  // "ANN" is inside "CANNOT". Reported, but flagged, so the headline count
  // can be read with and without the accident-prone matches.
  it("flags a short match as fragile rather than dropping or trusting it", () => {
    const said = "I cannot come in today";
    const short = mentionsEntity(said, "Ann");
    expect(short.present).toBe(true);
    expect(short.fragile).toBe(true);

    const long = mentionsEntity("my name is Rodriguez", "Rodriguez");
    expect(long.present).toBe(true);
    expect(long.fragile).toBe(false);
  });

  it("draws the fragile line at FRAGILE_MAX_LENGTH normalized characters", () => {
    const value = "a".repeat(FRAGILE_MAX_LENGTH);
    expect(mentionsEntity(value, value).fragile).toBe(true);
    const longer = "a".repeat(FRAGILE_MAX_LENGTH + 1);
    expect(mentionsEntity(longer, longer).fragile).toBe(false);
  });

  it("is never fragile when it is not present", () => {
    expect(mentionsEntity("nothing here", "Ann").fragile).toBe(false);
  });
});

describe("stringArgumentsOf", () => {
  it("keeps string arguments and drops every other type", () => {
    const raw = JSON.stringify({
      phoneNumber: "555-123-4567",
      firstName: "Dana",
      max_results: 5,
      autoSelectUnit: true,
      knowledgeBaseNames: ["a"],
    });
    expect(stringArgumentsOf("fly-APPFOLIO_FIND_TENANT", raw)).toEqual([
      { tool: "fly-APPFOLIO_FIND_TENANT", name: "phoneNumber", value: "555-123-4567" },
      { tool: "fly-APPFOLIO_FIND_TENANT", name: "firstName", value: "Dana" },
    ]);
  });

  it("drops a blank string, which would otherwise be a candidate that can never confirm", () => {
    expect(stringArgumentsOf("t", JSON.stringify({ notes: "   ", body: "" }))).toEqual([]);
  });

  it("returns nothing for arguments it cannot read", () => {
    expect(stringArgumentsOf("t", "{ not json")).toEqual([]);
    expect(stringArgumentsOf("t", undefined)).toEqual([]);
    expect(stringArgumentsOf("t", JSON.stringify(["a", "b"]))).toEqual([]);
  });
});

// tallyToolCall is what the runner calls, and the reason it exists is that
// the runner must never hold an argument value -- a console.log of one in
// the runner's loop was caught by nothing. These assert the counting, and
// that a value is never returned to a caller that could print it.
describe("tallyToolCall", () => {
  const args = JSON.stringify({ lastName: "Rodriguez", firstName: "Ann", propertyId: 12 });
  const turns = "this is Ann Rodriguez calling";

  it("counts a succeeded call's arguments, flagging the fragile match", () => {
    expect(tallyToolCall("t", args, "succeeded", turns)).toEqual([
      { name: "lastName", tally: { candidates: 1, fromSucceeded: 1, present: 1, fragile: 0 } },
      { name: "firstName", tally: { candidates: 1, fromSucceeded: 1, present: 1, fragile: 1 } },
    ]);
  });

  it("never runs the mention check on a result that reported no status", () => {
    for (const outcome of ["unknown", "failed"] as const) {
      expect(tallyToolCall("t", args, outcome, turns)).toEqual([
        { name: "lastName", tally: { candidates: 1, fromSucceeded: 0, present: 0, fragile: 0 } },
        { name: "firstName", tally: { candidates: 1, fromSucceeded: 0, present: 0, fragile: 0 } },
      ]);
    }
  });

  it("hands back names and numbers only, never a value", () => {
    const counted = tallyToolCall("t", args, "succeeded", turns);
    expect(JSON.stringify(counted)).not.toContain("Rodriguez");
    for (const entry of counted) expect(Object.keys(entry).sort()).toEqual(["name", "tally"]);
  });

  it("counts nothing for a tool call with no string arguments", () => {
    expect(tallyToolCall("t", JSON.stringify({ max_results: 5 }), "succeeded", turns)).toEqual([]);
    expect(tallyToolCall("t", "{ not json", "succeeded", turns)).toEqual([]);
  });
});
