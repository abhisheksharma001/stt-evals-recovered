import { describe, expect, it } from "vitest";
import {
  cellKey,
  isCellDone,
  staleResultIdsToClear,
  type ResumableCellRow,
} from "./cell-resumption";

const row = (over: Partial<ResumableCellRow> = {}): ResumableCellRow => ({
  id: "r1",
  providerId: "deepgram-nova-3",
  callId: "c1",
  status: "ok",
  ...over,
});

describe("isCellDone", () => {
  it("counts a scored ok row as done", () => {
    expect(isCellDone(row(), new Set(["r1"]))).toBe(true);
  });

  // B-6. The whole point: paid for, never scored, and skipped forever.
  it("does NOT count an ok row with no score as done", () => {
    expect(isCellDone(row(), new Set())).toBe(false);
  });

  it("does not count a failed row as done even if some score row exists", () => {
    expect(isCellDone(row({ status: "failed" }), new Set(["r1"]))).toBe(false);
  });
});

describe("staleResultIdsToClear", () => {
  const noneFailed = new Set<string>();

  it("clears an unscored ok row so the retry inserts fresh", () => {
    // Load-bearing: upsertResult's default setWhere refuses to update a
    // surviving ok row, so leaving it here means paying for an answer that
    // is then thrown away.
    expect(staleResultIdsToClear([row()], new Set(), noneFailed)).toEqual(["r1"]);
  });

  it("leaves a scored ok row alone", () => {
    expect(staleResultIdsToClear([row()], new Set(["r1"]), noneFailed)).toEqual([]);
  });

  it("still clears an ordinary failed row", () => {
    expect(
      staleResultIdsToClear([row({ status: "failed" })], new Set(), noneFailed),
    ).toEqual(["r1"]);
  });

  // T-43: a permanently-failed row is the only record the cell was tried.
  it("keeps a permanently-failed row", () => {
    const r = row({ status: "failed" });
    const perm = new Set([cellKey(r.providerId, r.callId)]);
    expect(staleResultIdsToClear([r], new Set(), perm)).toEqual([]);
  });

  it("does not let a permanently-failed key protect an unscored ok row of a different cell", () => {
    const stuck = row({ id: "r2", callId: "c2" });
    const perm = new Set([cellKey("deepgram-nova-3", "c1")]);
    expect(staleResultIdsToClear([row({ status: "failed" }), stuck], new Set(), perm)).toEqual([
      "r2",
    ]);
  });

  it("mixed set: clears the unscored ok and the failed, keeps the scored ok", () => {
    const rows = [
      row({ id: "a", callId: "c1" }),
      row({ id: "b", callId: "c2" }),
      row({ id: "c", callId: "c3", status: "failed" }),
    ];
    expect(staleResultIdsToClear(rows, new Set(["a"]), noneFailed)).toEqual(["b", "c"]);
  });
});
