// T-26: the judge's CONTRACT, as a committed fixture that CI can check
// without an OpenAI key.
//
// The problem this solves: the judge is a prompt (baml_src/judge.baml) plus
// a model (JUDGE_MODEL). Either can be edited in a one-line diff that
// typechecks, builds, and quietly makes every future verdict worse. CI has
// no OpenAI key (and should not: keys are ephemeral env-vars only), so it
// cannot re-run the judge itself. What it CAN do is hold the prompt to a
// fixture that was recorded by running the judge, on a developer machine,
// against the saved evidence -- and refuse a prompt that has no fixture.
//
// Two halves, deliberately split so neither can lie for the other:
//
//   src/judge-contract-record.ts  -- LIVE. Spends OpenAI money. Re-judges
//                                    a fixed sample of saved flagged scans
//                                    (T-86: no human verdicts exist in this
//                                    product any more), with the
//                                    CURRENT prompt + model, and writes
//                                    src/lib/__fixtures__/judge-contract.json.
//   src/lib/judge-contract.test.ts -- OFFLINE, in CI. Asserts the fixture
//                                    was recorded for exactly this prompt
//                                    hash and model, and that the numbers
//                                    in it clear the floors in this file.
//
// So: a prompt change without a re-record fails the build (hash mismatch);
// a re-record whose accuracy fell below the floor fails the build (floor
// in THIS file, not in the fixture, so a bad re-record cannot move it).
//
// What the fixture does NOT contain: any transcript text, any reading
// text, any judge reasoning. Those quote calls and carry caller names
// (see T-36). The fixture holds ids, provider ids, picks and booleans only.
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

export const JUDGE_CONTRACT_FIXTURE_RELATIVE = "src/lib/__fixtures__/judge-contract.json";

/** The files whose bytes define "the prompt". clients.baml is included
 *  because it names the default client/model the generated code binds to;
 *  generators.baml is not (it only shapes the generated TS). */
const PROMPT_FILES = ["baml_src/judge.baml", "baml_src/clients.baml"] as const;

function apiServerRoot(): string {
  // src/lib/judge-contract.ts -> artifacts/api-server
  return join(dirname(fileURLToPath(import.meta.url)), "..", "..");
}

export function fixturePath(): string {
  return join(apiServerRoot(), JUDGE_CONTRACT_FIXTURE_RELATIVE);
}

/** sha256 over the prompt files + the model name. Any byte change in the
 *  prompt, or a different JUDGE_MODEL, is a different contract. */
export function judgePromptHash(model: string): string {
  const h = createHash("sha256");
  for (const rel of PROMPT_FILES) {
    h.update(`--- ${rel}\n`);
    h.update(readFileSync(join(apiServerRoot(), rel)));
  }
  h.update(`--- model\n${model}\n`);
  return h.digest("hex");
}

/** One saved flagged scan re-judged with the current prompt. There is no
 *  ground truth for a whole-call pick (no gold transcript, by design), so
 *  this half checks the contract's SHAPE -- a real pick from the candidate
 *  set, every time -- and records how often the fresh pick matches the one
 *  stored on the scan, for information only. */
export type ContractScanCase = {
  scanId: string;
  callId: string;
  runId: string;
  candidateProviderIds: string[];
  storedPickProviderId: string | null;
  judgeProviderId: string | null;
  reasoningChars: number;
  promptTokens: number | null;
  completionTokens: number | null;
};

export type JudgeContractFixture = {
  version: 1;
  recordedAt: string;
  model: string;
  promptHash: string;
  costMicrocents: number;
  scans: ContractScanCase[];
};

export type JudgeContractSummary = {
  scanTotal: number;
  scanNullPicks: number;
  scanPicksOutsideCandidates: number;
  scanEmptyReasoning: number;
  scanPickMatchesStored: number;
  scanPickMatchesStoredRate: number | null;
};

/** Pure arithmetic over a fixture. The test recomputes this from the
 *  cases rather than trusting any total written into the file. */
export function summarizeJudgeContract(fixture: Pick<JudgeContractFixture, "scans">): JudgeContractSummary {
  let nullPicks = 0;
  let outside = 0;
  let emptyReasoning = 0;
  let matchesStored = 0;
  let withStored = 0;
  for (const s of fixture.scans) {
    if (s.judgeProviderId === null) nullPicks += 1;
    else if (!s.candidateProviderIds.includes(s.judgeProviderId)) outside += 1;
    if (s.reasoningChars === 0) emptyReasoning += 1;
    if (s.storedPickProviderId !== null) {
      withStored += 1;
      if (s.judgeProviderId === s.storedPickProviderId) matchesStored += 1;
    }
  }
  return {
    scanTotal: fixture.scans.length,
    scanNullPicks: nullPicks,
    scanPicksOutsideCandidates: outside,
    scanEmptyReasoning: emptyReasoning,
    scanPickMatchesStored: matchesStored,
    scanPickMatchesStoredRate: withStored === 0 ? null : matchesStored / withStored,
  };
}
