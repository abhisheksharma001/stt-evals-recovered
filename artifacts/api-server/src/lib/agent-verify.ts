// 2026-08-27, per Abhishek ("bulk calls will also do the agent system
// working, remove the agent thing, just keep bulk which will do the work"):
// the standalone Agent page (manual, on-demand scanning) is retired. This
// file is the shared "hybrid flags -> judge -> write a scan row" logic that
// used to live inline in routes/agent.ts's POST /scans handler -- now called
// automatically by run-executor.ts once per completed run (bulk or ad-hoc),
// right after computeHybridFlagsForRun. No code path here spends money that
// the old manual Scan button didn't already spend for a flagged call; the
// only change is WHO calls it (the executor, not a human's click).
import { and, desc, eq, inArray } from "drizzle-orm";
import {
  APP_SETTINGS_ID,
  appSettingsTable,
  benchmarkAgentScansTable,
  benchmarkCallsTable,
  benchmarkProviderCallResultsTable,
  benchmarkProvidersTable,
  db,
  type BenchmarkAgentFlag,
  type BenchmarkHybridFlagSummary,
} from "@workspace/db";
import { judgeCandidates } from "./agent";
import { computeHybridFlagsForCandidates } from "./hybrid-flagging";
import { logger } from "./logger";
import { writeAudit } from "./audit";

/** Human-readable {text, reason} restatements of the hybrid flags, for the
 * `flags` column the UI already knows how to render. Kept separate from the
 * structured `hybridFlags` (the real data) so a caller that only understands
 * the old shape still gets something useful. Moved from routes/agent.ts
 * unchanged -- this is pure text formatting, not orchestration. */
function deriveFlagTexts(
  candidatesByProvider: Map<string, { providerName: string; transcript: string }>,
  hybridByProvider: ReturnType<typeof computeHybridFlagsForCandidates>,
): BenchmarkAgentFlag[] {
  const flags: BenchmarkAgentFlag[] = [];
  const seenEntityMismatches = new Set<string>();

  for (const [providerId, result] of hybridByProvider) {
    const name = candidatesByProvider.get(providerId)?.providerName ?? providerId;
    if (result.crossProviderDisagreement && result.crossProviderDisagreement.disagreementRate > 0.15) {
      flags.push({
        text: name,
        reason: `Disagrees with the other candidate(s) on ${Math.round(result.crossProviderDisagreement.disagreementRate * 100)}% of its words.`,
      });
    }
    for (const span of result.lowConfidenceSpans) {
      flags.push({
        text: span.words.join(" "),
        reason: `${name} reported low confidence here (avg ${(span.avgConfidence * 100).toFixed(0)}%).`,
      });
    }
    for (const mismatch of result.entityMismatches) {
      const key = `${mismatch.type}:${JSON.stringify(mismatch.valuesByProvider)}:${mismatch.missingProviderIds.join(",")}`;
      if (seenEntityMismatches.has(key)) continue;
      seenEntityMismatches.add(key);
      const byProviderText = Object.entries(mismatch.valuesByProvider)
        .map(([pid, values]) => `${candidatesByProvider.get(pid)?.providerName ?? pid}: ${values.join(", ")}`)
        .join(" vs. ");
      const missingText = mismatch.missingProviderIds.length
        ? ` -- ${mismatch.missingProviderIds.map((pid) => candidatesByProvider.get(pid)?.providerName ?? pid).join(", ")} mentioned nothing of this type at all.`
        : "";
      flags.push({
        text: mismatch.type.replace(/_/g, " "),
        reason: `Candidates disagree on the ${mismatch.type.replace(/_/g, " ")} itself -- ${byProviderText}.${missingText}`,
      });
    }
  }
  return flags;
}

/** One call's worth of candidate transcripts, already resolved by the
 * caller -- run-executor has these in hand from the run it just finished, so
 * this never re-derives "latest ok result per provider" the way the old
 * manual-scan route had to (it didn't have a specific run to scope to). */
export type VerifyCallCandidate = { providerId: string; providerName: string; transcript: string; rawOutputJson: string | null };

/** Runs the hybrid pass + (if anything was flagged) the OpenAI judge call
 * for one call, and writes the resulting benchmark_agent_scans row. Reused
 * by both the automatic per-run pass below and anything else that ever
 * needs the same check (kept as a real function, not inlined, precisely so
 * it isn't duplicated a second time). */
export async function verifyCallWithAgent(params: {
  callId: string;
  draftTranscript: string | null;
  candidates: VerifyCallCandidate[];
  requestedByLabel: string;
  // The run whose "ok" cells produced these candidates -- stored on the scan
  // row so a bulk's actual-cost breakdown (routes/bulks.ts GetBulk) can
  // attribute agent spend to the run/bulk that caused it, the same way
  // benchmark_scores rows are already scoped by runId. Null only for the
  // (now-removed) old manual on-demand path, never for the automatic one.
  runId: string | null;
}): Promise<void> {
  if (params.candidates.length === 0) return; // nothing to compare -- no scan row without evidence

  const candidatesByProvider = new Map(
    params.candidates.map((c) => [c.providerId, { providerName: c.providerName, transcript: c.transcript }]),
  );
  const hybridByProvider = computeHybridFlagsForCandidates(
    params.candidates.map((c) => ({ providerId: c.providerId, transcript: c.transcript, rawOutputJson: c.rawOutputJson })),
  );

  const totalFlagCount = [...hybridByProvider.values()].reduce((sum, r) => sum + r.flagCount, 0);
  const maxSeverity = [...hybridByProvider.values()].reduce<"none" | "low" | "medium" | "high">(
    (max, r) => ({ none: 0, low: 1, medium: 2, high: 3 }[r.flagSeverity] > { none: 0, low: 1, medium: 2, high: 3 }[max] ? r.flagSeverity : max),
    "none",
  );

  const hybridFlagsSummary: BenchmarkHybridFlagSummary = {
    flagCount: totalFlagCount,
    flagSeverity: maxSeverity,
    crossProviderDisagreements: [...hybridByProvider.values()]
      .filter((r) => r.crossProviderDisagreement)
      .map((r) => ({ providerId: r.providerId, disagreementRate: r.crossProviderDisagreement!.disagreementRate })),
    lowConfidenceSpans: Object.fromEntries(
      [...hybridByProvider.entries()].map(([providerId, r]) => [
        providerId,
        r.lowConfidenceSpans.map((s) => ({ words: s.words, avgConfidence: s.avgConfidence, severity: s.severity })),
      ]),
    ),
    entityMismatches: [...hybridByProvider.values()]
      .flatMap((r) => r.entityMismatches)
      .filter((m, i, arr) => arr.findIndex((o) => JSON.stringify(o) === JSON.stringify(m)) === i)
      .map((m) => ({ type: m.type, valuesByProvider: m.valuesByProvider, missingProviderIds: m.missingProviderIds })),
  };

  if (totalFlagCount === 0) {
    // Still write a row -- "checked, found nothing" is real coverage
    // evidence, not nothing (Results/Corpus want to show "N/M calls
    // verified" honestly, which needs a row for the clean ones too).
    const [clean] = await db
      .insert(benchmarkAgentScansTable)
      .values({
        callId: params.callId,
        sourceLabel: params.draftTranscript?.trim() ? "draft" : null,
        sourceTranscript: params.draftTranscript?.trim() || null,
        status: "clean",
        flags: [],
        hybridFlags: hybridFlagsSummary,
        requestedByLabel: params.requestedByLabel,
        runId: params.runId,
      })
      .returning();
    await writeAudit({
      entityType: "agent_scan",
      entityId: clean.id,
      actorLabel: params.requestedByLabel,
      action: "auto_verify_clean",
      afterState: { callId: params.callId },
    });
    return;
  }

  const flags = deriveFlagTexts(candidatesByProvider, hybridByProvider);

  const [settings] = await db
    .select({ agentModel: appSettingsTable.agentModel })
    .from(appSettingsTable)
    .where(eq(appSettingsTable.id, APP_SETTINGS_ID))
    .limit(1);

  try {
    const judgeResult = await judgeCandidates({
      originalTranscript: params.draftTranscript?.trim() || "(no draft transcript on file)",
      flags,
      candidates: params.candidates.map((c) => ({ providerId: c.providerId, providerName: c.providerName, transcript: c.transcript })),
      model: settings?.agentModel,
    });

    const pickedResult = judgeResult.pickedProviderId
      ? await db
          .select({ id: benchmarkProviderCallResultsTable.id })
          .from(benchmarkProviderCallResultsTable)
          .where(
            and(
              eq(benchmarkProviderCallResultsTable.callId, params.callId),
              eq(benchmarkProviderCallResultsTable.providerId, judgeResult.pickedProviderId),
              eq(benchmarkProviderCallResultsTable.status, "ok"),
            ),
          )
          .orderBy(desc(benchmarkProviderCallResultsTable.createdAt))
          .limit(1)
      : [];

    const [flagged] = await db
      .insert(benchmarkAgentScansTable)
      .values({
        callId: params.callId,
        sourceLabel: params.draftTranscript?.trim() ? "draft" : null,
        sourceTranscript: params.draftTranscript?.trim() || null,
        status: "flagged",
        flags,
        hybridFlags: hybridFlagsSummary,
        agentPickResultId: pickedResult[0]?.id ?? null,
        agentPickReasoning: judgeResult.reasoning,
        judgePromptTokens: judgeResult.promptTokens,
        judgeCompletionTokens: judgeResult.completionTokens,
        judgeCostCents: judgeResult.costCents,
        requestedByLabel: params.requestedByLabel,
        runId: params.runId,
      })
      .returning();

    await writeAudit({
      entityType: "agent_scan",
      entityId: flagged.id,
      actorLabel: params.requestedByLabel,
      action: "auto_verify_flagged",
      afterState: { callId: params.callId, flagCount: totalFlagCount, pickedResultId: pickedResult[0]?.id ?? null },
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    const [errored] = await db
      .insert(benchmarkAgentScansTable)
      .values({
        callId: params.callId,
        sourceLabel: params.draftTranscript?.trim() ? "draft" : null,
        sourceTranscript: params.draftTranscript?.trim() || null,
        status: "error",
        flags: [],
        hybridFlags: hybridFlagsSummary,
        errorMessage: message,
        requestedByLabel: params.requestedByLabel,
        runId: params.runId,
      })
      .returning();
    logger.error({ err, callId: params.callId, scanId: errored.id }, "auto agent verification failed");
  }
}

/** Called once per completed run (run-executor.ts, after
 * computeHybridFlagsForRun) -- verifies every call that got at least one
 * "ok" cell in THIS run. Never re-verifies work another run already covered
 * (each run's own results are the only scope), so a bulk's shards each pay
 * for their own calls exactly once. */
export async function runAutoAgentVerificationForRun(runId: string, requestedByLabel: string): Promise<void> {
  const rows = await db
    .select({ result: benchmarkProviderCallResultsTable, provider: benchmarkProvidersTable })
    .from(benchmarkProviderCallResultsTable)
    .innerJoin(benchmarkProvidersTable, eq(benchmarkProvidersTable.id, benchmarkProviderCallResultsTable.providerId))
    .where(and(eq(benchmarkProviderCallResultsTable.runId, runId), eq(benchmarkProviderCallResultsTable.status, "ok")));

  const byCallId = new Map<string, typeof rows>();
  for (const row of rows) {
    if (!row.result.hypothesisTranscript) continue;
    if (!byCallId.has(row.result.callId)) byCallId.set(row.result.callId, []);
    byCallId.get(row.result.callId)!.push(row);
  }
  if (byCallId.size === 0) return;

  const calls = await db
    .select({ id: benchmarkCallsTable.id, draftTranscript: benchmarkCallsTable.draftTranscript })
    .from(benchmarkCallsTable)
    .where(inArray(benchmarkCallsTable.id, [...byCallId.keys()]));
  const draftByCallId = new Map(calls.map((c) => [c.id, c.draftTranscript]));

  for (const [callId, callRows] of byCallId) {
    try {
      await verifyCallWithAgent({
        callId,
        draftTranscript: draftByCallId.get(callId) ?? null,
        candidates: callRows.map((r) => ({
          providerId: r.provider.id,
          providerName: r.provider.name,
          transcript: r.result.hypothesisTranscript!,
          rawOutputJson: r.result.rawOutput,
        })),
        requestedByLabel,
        runId,
      });
    } catch (err) {
      // One call's verification must never take the whole run down --
      // the STT results themselves already landed regardless.
      logger.error({ err, runId, callId }, "auto agent verification crashed for a call");
    }
  }
}
