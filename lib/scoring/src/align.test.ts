import { describe, expect, it } from "vitest";
import { diffWords, editCounts, type WordDiffOp } from "./index";

// T-33: the typed-array alignWords must produce EXACTLY the ops the original
// array-of-arrays version did -- same tie-break (sub > del > ins), same
// backtrace -- or every stored hybrid flag, span key and correlation would
// silently change meaning. This is a verbatim copy of the original.
function legacyDiff(reference: string[], hypothesis: string[]): WordDiffOp[] {
  const rows = reference.length + 1;
  const cols = hypothesis.length + 1;
  const distance = Array.from({ length: rows }, () => Array<number>(cols).fill(0));
  const operation = Array.from({ length: rows }, () => Array<"ok" | "sub" | "del" | "ins">(cols).fill("ok"));
  for (let row = 1; row < rows; row += 1) {
    distance[row]![0] = row;
    operation[row]![0] = "del";
  }
  for (let col = 1; col < cols; col += 1) {
    distance[0]![col] = col;
    operation[0]![col] = "ins";
  }
  for (let row = 1; row < rows; row += 1) {
    for (let col = 1; col < cols; col += 1) {
      if (reference[row - 1] === hypothesis[col - 1]) {
        distance[row]![col] = distance[row - 1]![col - 1]!;
        operation[row]![col] = "ok";
        continue;
      }
      const candidates = [
        { cost: distance[row - 1]![col - 1]! + 1, op: "sub" as const, priority: 0 },
        { cost: distance[row - 1]![col]! + 1, op: "del" as const, priority: 1 },
        { cost: distance[row]![col - 1]! + 1, op: "ins" as const, priority: 2 },
      ].sort((l, r) => (l.cost === r.cost ? l.priority - r.priority : l.cost - r.cost));
      distance[row]![col] = candidates[0]!.cost;
      operation[row]![col] = candidates[0]!.op;
    }
  }
  let row = reference.length;
  let col = hypothesis.length;
  const out: WordDiffOp[] = [];
  while (row > 0 || col > 0) {
    const op = operation[row]![col]!;
    if (op === "ok" || op === "sub") {
      out.push({ op, ref: reference[row - 1]!, hyp: hypothesis[col - 1]! });
      row -= 1;
      col -= 1;
    } else if (op === "del") {
      out.push({ op, ref: reference[row - 1]!, hyp: null });
      row -= 1;
    } else {
      out.push({ op, ref: null, hyp: hypothesis[col - 1]! });
      col -= 1;
    }
  }
  return out.reverse();
}

// Deterministic LCG so a failure is reproducible from the seed alone.
function rng(seed: number) {
  let s = seed >>> 0;
  return () => ((s = (s * 1664525 + 1013904223) >>> 0) / 2 ** 32);
}

describe("alignWords (T-33 typed-array rewrite)", () => {
  it("matches the legacy implementation op-for-op on random inputs, ties included", () => {
    const next = rng(33);
    // Tiny vocabulary on purpose: forces equal-cost cells so the tie-break
    // is exercised constantly, not just the happy path.
    const vocab = ["a", "b", "c", "3", "6"];
    for (let i = 0; i < 400; i += 1) {
      const n = Math.floor(next() * 25);
      const m = Math.floor(next() * 25);
      const ref = Array.from({ length: n }, () => vocab[Math.floor(next() * vocab.length)]!);
      const hyp = Array.from({ length: m }, () => vocab[Math.floor(next() * vocab.length)]!);
      expect(diffWords(ref, hyp), `seed 33 case ${i}`).toEqual(legacyDiff(ref, hyp));
    }
  });

  it("handles the empty edges", () => {
    expect(diffWords([], [])).toEqual([]);
    expect(diffWords(["x"], [])).toEqual([{ op: "del", ref: "x", hyp: null }]);
    expect(diffWords([], ["x"])).toEqual([{ op: "ins", ref: null, hyp: "x" }]);
    expect(editCounts(["a", "b"], ["a", "b"])).toEqual({ substitutions: 0, deletions: 0, insertions: 0, referenceWords: 2 });
  });
});
