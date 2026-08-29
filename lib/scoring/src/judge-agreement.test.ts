import { describe, expect, it } from "vitest";
import { computeJudgeAgreement, picksAgree, type JudgeAgreementRow } from "./judge-agreement";

const readings = [
  { providerId: "a", text: "are" },
  { providerId: "b", text: "are" },
  { providerId: "c", text: "were" },
];

function row(partial: Partial<JudgeAgreementRow>): JudgeAgreementRow {
  return { readings, humanProviderId: "a", judgeProviderId: "a", adjudicatedByLabel: "Abhishek", ...partial };
}

describe("computeJudgeAgreement", () => {
  it("reports a null rate, not 0%, from an empty sample", () => {
    const r = computeJudgeAgreement([]);
    expect(r.totalVerdicts).toBe(0);
    expect(r.agreementRate).toBeNull();
    expect(r.byAdjudicator).toEqual([]);
  });

  it("counts un-replayed rows as pending and leaves them out of the rate", () => {
    const r = computeJudgeAgreement([row({ judgeProviderId: undefined }), row({})]);
    expect(r.pending).toBe(1);
    expect(r.replayed).toBe(1);
    expect(r.comparable).toBe(1);
    expect(r.agreementRate).toBe(1);
  });

  // T-47: majority-vs-human is free, so it counts pending rows too.
  it("scores a plain majority vote against the human, replayed or not", () => {
    const r = computeJudgeAgreement([
      row({ humanProviderId: "a", judgeProviderId: undefined }), // majority "are" = human
      row({ humanProviderId: "c", judgeProviderId: "a" }), // majority "are" != human "were"
      row({ humanProviderId: null }), // no human pick: excluded
      row({ humanProviderId: "a", readings: [{ providerId: "a", text: "x" }, { providerId: "b", text: "y" }] }), // tie: excluded
    ]);
    expect(r.majorityComparable).toBe(2);
    expect(r.majorityAgreements).toBe(1);
    expect(r.majorityAgreementRate).toBe(0.5);
  });

  it("agrees on identical text even when the provider ids differ", () => {
    expect(picksAgree(row({ humanProviderId: "a", judgeProviderId: "b" }))).toBe(true);
    expect(picksAgree(row({ humanProviderId: "a", judgeProviderId: "c" }))).toBe(false);
  });

  it("keeps 'none of them' and judge-no-pick out of the denominator, but visible", () => {
    const r = computeJudgeAgreement([
      row({ humanProviderId: null, judgeProviderId: "a" }),
      row({ humanProviderId: "a", judgeProviderId: null }),
      row({ humanProviderId: "c", judgeProviderId: "a" }),
    ]);
    expect(r.humanSaidNone).toBe(1);
    expect(r.judgeNoPick).toBe(1);
    expect(r.comparable).toBe(1);
    expect(r.agreements).toBe(0);
    expect(r.agreementRate).toBe(0);
  });

  it("breaks the rate down per human, largest sample first", () => {
    const r = computeJudgeAgreement([
      row({ adjudicatedByLabel: "unknown" }),
      row({ adjudicatedByLabel: "unknown", humanProviderId: "c" }),
      row({ adjudicatedByLabel: "Abhishek" }),
    ]);
    expect(r.byAdjudicator).toEqual([
      { label: "unknown", comparable: 2, agreements: 1, agreementRate: 0.5 },
      { label: "Abhishek", comparable: 1, agreements: 1, agreementRate: 1 },
    ]);
  });

  it("treats a pick that names no reading as a judge failure, not a disagreement", () => {
    const r = computeJudgeAgreement([row({ judgeProviderId: "zzz" })]);
    expect(r.judgeNoPick).toBe(1);
    expect(r.comparable).toBe(0);
  });
});
