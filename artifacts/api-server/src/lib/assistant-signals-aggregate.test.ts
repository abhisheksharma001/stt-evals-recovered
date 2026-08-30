import { describe, expect, it } from "vitest";
import { aggregateHardCases, aggregateJudgeConfidence, latestScanPerCall } from "./assistant-signals-aggregate";

const t = (s: number) => new Date(1_700_000_000_000 + s * 1000);

describe("aggregateJudgeConfidence (T-112)", () => {
  it("counts one scan per call, the latest, and buckets confidence", () => {
    const out = aggregateJudgeConfidence([
      { callId: "a", createdAt: t(1), status: "flagged", judgeConfidence: null, agentPickReasoning: "old" },
      { callId: "a", createdAt: t(2), status: "flagged", judgeConfidence: "high", agentPickReasoning: "new" },
      { callId: "b", createdAt: t(1), status: "approved", judgeConfidence: "low", agentPickReasoning: "r" },
      { callId: "c", createdAt: t(1), status: "flagged", judgeConfidence: null, agentPickReasoning: "pre-T-108" },
      { callId: "d", createdAt: t(1), status: "clean", judgeConfidence: null, agentPickReasoning: null },
      { callId: "e", createdAt: t(1), status: "error", judgeConfidence: null, agentPickReasoning: null },
      // flagged but the judge never answered: not judged, not clean.
      { callId: "f", createdAt: t(1), status: "flagged", judgeConfidence: null, agentPickReasoning: null },
    ]);
    expect(out).toEqual({ checked: 6, judged: 3, high: 1, medium: 0, low: 1, notRecorded: 1, clean: 1, errored: 1 });
  });

  it("is all zeros on no scans", () => {
    expect(aggregateJudgeConfidence([])).toEqual({ checked: 0, judged: 0, high: 0, medium: 0, low: 0, notRecorded: 0, clean: 0, errored: 0 });
  });

  it("latestScanPerCall keeps the newest row per call", () => {
    const rows = latestScanPerCall([
      { callId: "a", createdAt: t(5), v: 1 },
      { callId: "a", createdAt: t(9), v: 2 },
      { callId: "b", createdAt: t(1), v: 3 },
    ]);
    expect(rows.map((r) => r.v).sort()).toEqual([2, 3]);
  });
});

describe("aggregateHardCases (T-113)", () => {
  it("counts a tag once per call and orders by calls then name", () => {
    const out = aggregateHardCases([
      { id: "1", label: "one", hardCases: ["accent", "accent", " numbers "] },
      { id: "2", label: "two", hardCases: ["numbers"] },
      { id: "3", label: "three", hardCases: [] },
    ]);
    expect(out.calls).toBe(2);
    expect(out.tags).toEqual([
      { tag: "numbers", calls: 2 },
      { tag: "accent", calls: 1 },
    ]);
    expect(out.examples.map((e) => e.callId)).toEqual(["1", "2"]);
  });

  it("empty when nobody flagged anything", () => {
    expect(aggregateHardCases([{ id: "1", label: "x", hardCases: [] }])).toEqual({ calls: 0, tags: [], examples: [] });
  });
});
