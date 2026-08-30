/**
 * T-26: record the judge contract fixture. LIVE -- spends OpenAI money.
 *
 * Re-judges, with the CURRENT prompt (baml_src/judge.baml) and JUDGE_MODEL:
 *   a fixed, deterministic sample of saved flagged scans (latest scan per
 *      call, ordered by call id, first --scans N), rebuilt from the same
 *      inputs agent-verify.ts gave the judge the first time.
 *
 * Writes src/lib/__fixtures__/judge-contract.json -- ids, provider ids,
 * picks and booleans only; no transcript text, no reasoning (caller names).
 * Commit the fixture with the prompt change it was recorded for; the
 * offline test (src/lib/judge-contract.test.ts) refuses any prompt whose
 * hash the fixture does not match.
 *
 * Usage (from artifacts/api-server, .env supplies DATABASE_URL + OPENAI_API_KEY):
 *   pnpm run judge:contract:record [--scans 30] [--dry-run]
 *
 * --dry-run selects the cases and prints the count/cost shape without
 * calling OpenAI or writing the fixture.
 */
import { writeFileSync } from "node:fs";
import { and, desc, eq } from "drizzle-orm";

const args = process.argv.slice(2);
function argValue(flag: string, fallback: number): number {
  const i = args.indexOf(flag);
  return i >= 0 && args[i + 1] ? Number.parseInt(args[i + 1], 10) || fallback : fallback;
}
const SCAN_SAMPLE = argValue("--scans", 30);
const DRY_RUN = args.includes("--dry-run");

async function main() {
  const {
    benchmarkAgentScansTable,
    benchmarkProviderCallResultsTable,
    benchmarkProvidersTable,
    db,
    pool,
  } = await import("@workspace/db");
  const { JUDGE_MODEL, judgeCandidates } = await import("./lib/agent");
  const { fixturePath, judgePromptHash, summarizeJudgeContract } = await import("./lib/judge-contract");
  type Fixture = import("./lib/judge-contract").JudgeContractFixture;

  const providerRows = await db.select({ id: benchmarkProvidersTable.id, name: benchmarkProvidersTable.name }).from(benchmarkProvidersTable);
  const providerNames = new Map(providerRows.map((p) => [p.id, p.name]));

  // ---- saved flagged scans: latest per call, deterministic sample -------
  const flaggedScans = await db
    .select({
      id: benchmarkAgentScansTable.id,
      callId: benchmarkAgentScansTable.callId,
      runId: benchmarkAgentScansTable.runId,
      sourceTranscript: benchmarkAgentScansTable.sourceTranscript,
      flags: benchmarkAgentScansTable.flags,
      agentPickResultId: benchmarkAgentScansTable.agentPickResultId,
      createdAt: benchmarkAgentScansTable.createdAt,
    })
    .from(benchmarkAgentScansTable)
    .where(eq(benchmarkAgentScansTable.status, "flagged"))
    .orderBy(desc(benchmarkAgentScansTable.createdAt));
  const latestPerCall = new Map<string, (typeof flaggedScans)[number]>();
  for (const s of flaggedScans) {
    if (s.runId && s.flags.length > 0 && !latestPerCall.has(s.callId)) latestPerCall.set(s.callId, s);
  }
  // Ordered by call id, so the same N calls are chosen on every re-record;
  // scans whose run has no ok result left (legacy 2026-08-24 agent_scan
  // runs with every cell failed) are skipped and the next call fills in.
  const scanCandidates = [...latestPerCall.values()].sort((a, b) => a.callId.localeCompare(b.callId));

  console.log(`flagged scans (latest per call, with a run and flags): ${latestPerCall.size}; sampling up to ${SCAN_SAMPLE}`);
  console.log(`model: ${JUDGE_MODEL}; prompt hash: ${judgePromptHash(JUDGE_MODEL)}`);
  if (DRY_RUN) {
    console.log("--dry-run: nothing judged, nothing written");
    await pool.end();
    return;
  }
  if (!process.env.OPENAI_API_KEY) throw new Error("OPENAI_API_KEY is not set -- the recorder calls the judge live");

  const fixture: Fixture = {
    version: 1,
    recordedAt: new Date().toISOString(),
    model: JUDGE_MODEL,
    promptHash: judgePromptHash(JUDGE_MODEL),
    costMicrocents: 0,
    scans: [],
  };

  for (const scan of scanCandidates) {
    if (fixture.scans.length >= SCAN_SAMPLE) break;
    const results = await db
      .select({ id: benchmarkProviderCallResultsTable.id, providerId: benchmarkProviderCallResultsTable.providerId, transcript: benchmarkProviderCallResultsTable.hypothesisTranscript })
      .from(benchmarkProviderCallResultsTable)
      .where(and(eq(benchmarkProviderCallResultsTable.runId, scan.runId!), eq(benchmarkProviderCallResultsTable.callId, scan.callId), eq(benchmarkProviderCallResultsTable.status, "ok")));
    const candidates = results
      .filter((r) => r.transcript)
      .map((r) => ({ providerId: r.providerId, providerName: providerNames.get(r.providerId) ?? r.providerId, transcript: r.transcript! }));
    if (candidates.length === 0) {
      console.warn(`scan ${scan.id}: no ok results left for its run -- skipped`);
      continue;
    }
    // The stored pick's provider, via the linked result row wherever it
    // lives: agent-verify.ts links the latest ok row for (call, provider)
    // across ALL runs, so 106/178 links point outside the scan's own run
    // (T-26 finding) -- the provider id is still the answer.
    let storedPick: string | null = null;
    if (scan.agentPickResultId) {
      const [linked] = await db
        .select({ providerId: benchmarkProviderCallResultsTable.providerId })
        .from(benchmarkProviderCallResultsTable)
        .where(eq(benchmarkProviderCallResultsTable.id, scan.agentPickResultId))
        .limit(1);
      storedPick = linked?.providerId ?? null;
    }
    // Same inputs agent-verify.ts built for the original scan.
    const result = await judgeCandidates({
      originalTranscript: scan.sourceTranscript?.trim() || "(no draft transcript on file)",
      flags: scan.flags,
      candidates,
    });
    fixture.costMicrocents += result.costMicrocents ?? 0;
    fixture.scans.push({
      scanId: scan.id, callId: scan.callId, runId: scan.runId!,
      candidateProviderIds: candidates.map((c) => c.providerId),
      storedPickProviderId: storedPick,
      judgeProviderId: result.pickedProviderId,
      reasoningChars: result.reasoning.length,
      promptTokens: result.promptTokens,
      completionTokens: result.completionTokens,
    });
    console.log(`scan ${scan.id.slice(0, 8)}: stored=${storedPick} fresh=${result.pickedProviderId}`);
  }

  writeFileSync(fixturePath(), JSON.stringify(fixture, null, 2) + "\n");
  console.log(`wrote ${fixturePath()}`);
  console.log(JSON.stringify(summarizeJudgeContract(fixture), null, 2));
  console.log(`spent ${fixture.costMicrocents} microcents (~$${(fixture.costMicrocents / 1_000_000).toFixed(3)})`);
  await pool.end();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
