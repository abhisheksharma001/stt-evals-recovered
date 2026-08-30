// T-26: offline judge contract tests. Runs in CI with no OpenAI key and no
// database. See judge-contract.ts for the design; the short version:
//
//   * the committed fixture must have been recorded for THIS prompt + model
//     (hash match) -- a prompt edit without `pnpm run judge:contract:record`
//     fails here, on purpose;
//   * the recorded numbers must clear the floors below -- a re-record that
//     shows the new prompt doing worse fails here, on purpose;
//   * the floors live in this file, not in the fixture, so a re-record
//     cannot lower them.
import { existsSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { JUDGE_MODEL, judgeCandidates } from "./agent";
import {
  fixturePath,
  judgePromptHash,
  summarizeJudgeContract,
  JUDGE_CONTRACT_FIXTURE_RELATIVE,
  type JudgeContractFixture,
} from "./judge-contract";

// ---- floors ---------------------------------------------------------------
// T-86: the human half of the contract is gone with the human judge. What
// remains is the shape floor: a real pick from the candidate set, every time.
// Scans: the T-25 acceptance ("a full bulk judged through BAML with zero
// null picks") made permanent.
const MIN_SCAN_SAMPLE = 20;
const MAX_SCAN_NULL_PICKS = 0;

const RECORD_HINT = `Re-record with: pnpm --filter @workspace/api-server run judge:contract:record (spends OpenAI money; commit ${JUDGE_CONTRACT_FIXTURE_RELATIVE} with the prompt change).`;

function loadFixture(): JudgeContractFixture {
  const path = fixturePath();
  if (!existsSync(path)) throw new Error(`judge contract fixture missing at ${path}. ${RECORD_HINT}`);
  return JSON.parse(readFileSync(path, "utf8")) as JudgeContractFixture;
}

describe("judge contract fixture", () => {
  const fixture = loadFixture();
  const summary = summarizeJudgeContract(fixture);

  it("was recorded for the current prompt and model", () => {
    expect(fixture.version).toBe(1);
    expect(fixture.model, `fixture model ${fixture.model} != JUDGE_MODEL ${JUDGE_MODEL}. ${RECORD_HINT}`).toBe(JUDGE_MODEL);
    expect(fixture.promptHash, `baml_src prompt changed since the fixture was recorded. ${RECORD_HINT}`).toBe(judgePromptHash(JUDGE_MODEL));
  });

  it("has a large enough scan sample and every pick is a real candidate", () => {
    expect(summary.scanTotal).toBeGreaterThanOrEqual(MIN_SCAN_SAMPLE);
    expect(summary.scanNullPicks, `judge returned no pick on ${summary.scanNullPicks}/${summary.scanTotal} scans`).toBeLessThanOrEqual(MAX_SCAN_NULL_PICKS);
    expect(summary.scanPicksOutsideCandidates).toBe(0);
    expect(summary.scanEmptyReasoning).toBe(0);
    for (const s of fixture.scans) {
      expect(new Set(s.candidateProviderIds).size).toBe(s.candidateProviderIds.length);
      expect(s.promptTokens).not.toBeNull();
      expect(s.completionTokens).not.toBeNull();
    }
  });

});

describe("judgeCandidates shape (no network)", () => {
  it("returns a null pick and no cost when there are no candidates", async () => {
    const result = await judgeCandidates({ originalTranscript: "x", flags: [], candidates: [] });
    expect(result.pickedProviderId).toBeNull();
    expect(result.costMicrocents).toBeNull();
    expect(result.promptTokens).toBeNull();
  });

  it("refuses to run without OPENAI_API_KEY rather than guessing", async () => {
    const saved = process.env.OPENAI_API_KEY;
    delete process.env.OPENAI_API_KEY;
    try {
      await expect(
        judgeCandidates({ originalTranscript: "x", flags: [], candidates: [{ providerId: "p1", providerName: "P1", transcript: "hello" }] }),
      ).rejects.toThrow(/OPENAI_API_KEY/);
    } finally {
      if (saved !== undefined) process.env.OPENAI_API_KEY = saved;
    }
  });
});

describe("summarizeJudgeContract", () => {
  it("computes rates from cases, never from stored totals, and null from an empty sample", () => {
    const s = summarizeJudgeContract({
      scans: [
        { scanId: "s1", callId: "c", runId: "r", candidateProviderIds: ["p1", "p2"], storedPickProviderId: "p1", judgeProviderId: "p1", reasoningChars: 10, promptTokens: 1, completionTokens: 1 },
        { scanId: "s2", callId: "c", runId: "r", candidateProviderIds: ["p1", "p2"], storedPickProviderId: "p1", judgeProviderId: null, reasoningChars: 0, promptTokens: 1, completionTokens: 1 },
        { scanId: "s3", callId: "c", runId: "r", candidateProviderIds: ["p1", "p2"], storedPickProviderId: null, judgeProviderId: "p9", reasoningChars: 3, promptTokens: 1, completionTokens: 1 },
      ],
    });
    expect(s).toEqual({
      scanTotal: 3,
      scanNullPicks: 1,
      scanPicksOutsideCandidates: 1,
      scanEmptyReasoning: 1,
      scanPickMatchesStored: 1,
      scanPickMatchesStoredRate: 0.5,
    });
    expect(summarizeJudgeContract({ scans: [] }).scanPickMatchesStoredRate).toBeNull();
  });
});
