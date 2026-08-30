import { describe, expect, it } from "vitest";
import { judgeChipFor } from "./judge-chip";

describe("judgeChipFor", () => {
  it("no scan, no chip -- an unscanned call shows nothing, not 'clean'", () => {
    expect(judgeChipFor(null)).toBeNull();
  });

  it("a scan in flight reads 'checking'", () => {
    expect(judgeChipFor({ status: "scanning" })).toMatchObject({ label: "checking", tone: "muted" });
  });

  it("clean is muted -- agreement is the quiet case, not a green badge", () => {
    expect(judgeChipFor({ status: "clean" })).toMatchObject({ label: "clean", tone: "muted" });
  });

  it("a failed check is destructive and says the CHECK failed, not the call", () => {
    const chip = judgeChipFor({ status: "error" });
    expect(chip).toMatchObject({ label: "check failed", tone: "destructive" });
    expect(chip?.title).toContain("check itself failed");
  });

  it("flagged with no reasoning = the judge never answered", () => {
    expect(judgeChipFor({ status: "flagged", agentPickReasoning: null })).toMatchObject({
      label: "flagged, no verdict",
      tone: "muted",
    });
  });

  it.each([
    ["high", "success"],
    ["medium", "warning"],
    ["low", "destructive"],
  ] as const)("a verdict with %s confidence gets the %s tone", (confidence, tone) => {
    expect(judgeChipFor({ status: "flagged", agentPickReasoning: "picked X", judgeConfidence: confidence })).toEqual({
      label: `judge: ${confidence}`,
      tone,
      title: `The AI judge ruled on this call and was ${confidence} on it. Expand the row for its pick and reasoning.`,
    });
  });

  it("a pre-batch-8 verdict (reasoning, no confidence) is 'not recorded', never invented", () => {
    const chip = judgeChipFor({ status: "approved", agentPickReasoning: "picked X", judgeConfidence: null });
    expect(chip).toMatchObject({ label: "judge: not recorded", tone: "muted" });
    expect(chip?.title).toContain("before confidence was recorded");
  });

  it("an unknown confidence value falls back to muted, not a wrong colour", () => {
    expect(judgeChipFor({ status: "flagged", agentPickReasoning: "r", judgeConfidence: "certain" })).toMatchObject({
      label: "judge: certain",
      tone: "muted",
    });
  });
});
