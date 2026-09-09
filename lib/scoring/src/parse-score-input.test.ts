import { describe, expect, it } from "vitest";
import { parseScoreInput } from "./parse-score-input";
import { score } from "./core";

// R-43 (ox-alpha B-63). The CLI cast its input blindly, so a bad row exploded
// inside score() with a TypeError naming neither the file, the row, nor the
// field. The person running it has a JSON file in front of them and no way to
// find the one bad row in four hundred.
const good = {
  callId: "c1",
  vertical: "trucking",
  providerId: "deepgram-nova-3",
  goldTranscript: "load twelve",
  hypothesisTranscript: "load 12",
  entities: [{ kind: "number", value: "12" }],
};

describe("parseScoreInput", () => {
  it("accepts a single object and wraps it", () => {
    expect(parseScoreInput(good, "in.json")).toHaveLength(1);
  });

  it("accepts an array", () => {
    expect(parseScoreInput([good, good], "in.json")).toHaveLength(2);
  });

  it("names the file, the row and the missing field", () => {
    const { entities: _drop, ...noEntities } = good;
    expect(() => parseScoreInput([good, noEntities], "in.json")).toThrow(/in\.json/);
    expect(() => parseScoreInput([good, noEntities], "in.json")).toThrow(/row 1/);
    expect(() => parseScoreInput([good, noEntities], "in.json")).toThrow(/entities/);
  });

  it("suggests the empty array rather than only complaining", () => {
    const { entities: _drop, ...noEntities } = good;
    expect(() => parseScoreInput(noEntities, "in.json")).toThrow(/use \[\] when there are none/);
  });

  // Someone fixing a generated file wants the list, not one round trip per row.
  it("reports every bad row, not just the first", () => {
    let message = "";
    try {
      parseScoreInput([{ ...good, callId: 7 }, { ...good, vertical: "aviation" }], "in.json");
    } catch (e) {
      message = e instanceof Error ? e.message : String(e);
    }
    expect(message).toContain("row 0");
    expect(message).toContain("row 1");
    expect(message).toContain("2 problem(s)");
  });

  it("says what a wrong type actually was", () => {
    expect(() => parseScoreInput({ ...good, goldTranscript: 12 }, "in.json")).toThrow(
      /"goldTranscript" must be a string, got number/,
    );
  });

  it("names the bad vertical instead of listing only the legal ones", () => {
    expect(() => parseScoreInput({ ...good, vertical: "aviation" }, "in.json")).toThrow(
      /got "aviation"/,
    );
  });

  it("points at the entity index inside a row", () => {
    expect(() => parseScoreInput({ ...good, entities: [{ kind: "number" }] }, "in.json")).toThrow(
      /entities\[0\]/,
    );
  });

  it("rejects a scalar or an array-of-scalars rather than casting it", () => {
    expect(() => parseScoreInput("just a string", "in.json")).toThrow(/expected an object/);
    expect(() => parseScoreInput([1, 2], "in.json")).toThrow(/expected an object, got number/);
  });

  it("refuses an empty file rather than writing an empty result", () => {
    expect(() => parseScoreInput([], "in.json")).toThrow(/no rows to score/);
  });

  // The point of the whole exercise: what survives the gate must be scoreable.
  it("what it returns can be scored without throwing", () => {
    const rows = parseScoreInput([good], "in.json");
    expect(() => rows.map(score)).not.toThrow();
  });
});
