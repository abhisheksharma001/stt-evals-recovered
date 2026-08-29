// 2026-08-27, per Abhishek ("bulk calls will also do the agent system
// working, remove the agent thing, just keep bulk which will do the work"):
// the standalone Agent page (manual, on-demand scanning) is retired. This
// file is the shared "hybrid flags -> judge -> write a scan row" logic that
// used to live inline in routes/agent.ts's POST /scans handler -- now called
// automatically by run-executor.ts once per completed run (bulk or ad-hoc),
// right after computeHybridFlagsForRun. No code path here spends money that
// the old manual Scan button didn't already spend for a flagged call; the
// only change is WHO calls it (the executor, not a human's click).
import { and, desc, eq, inArray, isNotNull, ne, or } from "drizzle-orm";
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
import { drainWithConcurrency, envInt } from "./concurrency";

/** T-37: an audit row is a record OF the scan, not the scan. If it cannot
 * be written, the scan still landed and the money is still accounted for,
 * so this must not throw into the executor's "verification crashed" catch
 * -- that text would be a lie. Third failure meaning, own log line. */
async function auditOrLog(entry: Parameters<typeof writeAudit>[0], callId: string): Promise<void> {
  try {
    await writeAudit(entry);
  } catch (err) {
    logger.error({ err, callId, action: entry.action, scanId: entry.entityId }, "audit_write_failed: scan row landed, audit row did not");
  }
}

/** T-36: the last-resort log below carries the judge's reasoning, which
 * quotes transcript spans and therefore caller names. Fine while logs stay
 * on this machine; set REDACT_TRANSCRIPT_TEXT_IN_LOGS=1 before shipping
 * logs anywhere and only the length is logged. */
const REDACT_TRANSCRIPT_TEXT_IN_LOGS = process.env.REDACT_TRANSCRIPT_TEXT_IN_LOGS === "1";

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
    await auditOrLog(
      {
        entityType: "agent_scan",
        entityId: clean.id,
        actorLabel: params.requestedByLabel,
        action: "auto_verify_clean",
        afterState: { callId: params.callId },
      },
      params.callId,
    );
    return;
  }

  const flags = deriveFlagTexts(candidatesByProvider, hybridByProvider);

  const [settings] = await db
    .select({ agentModel: appSettingsTable.agentModel })
    .from(appSettingsTable)
    .where(eq(appSettingsTable.id, APP_SETTINGS_ID))
    .limit(1);

  // T-02 (2026-08-28). These used to share one `try`, and that is exactly
  // how T-01's bug hid for as long as it did: Postgres rejected the
  // fractional cost column, the catch below wrote `status: "error"`, and the
  // system reported "the judge failed" for 63/63 calls whose judge had in
  // fact answered perfectly -- after we had already paid OpenAI for every
  // one of them. Two different failures, two different meanings, two
  // different catches, forever:
  //
  //   judge_failed:      the OpenAI call itself did not produce an answer.
  //                      Nothing to keep. A real "error" scan row.
  //   scan_write_failed: the judge answered and we paid for it; only our
  //                      storage of that answer failed. Never an "error"
  //                      row, never discarded -- degrade and keep going.
  let judgeResult: Awaited<ReturnType<typeof judgeCandidates>>;
  try {
    judgeResult = await judgeCandidates({
      originalTranscript: params.draftTranscript?.trim() || "(no draft transcript on file)",
      flags,
      candidates: params.candidates.map((c) => ({ providerId: c.providerId, providerName: c.providerName, transcript: c.transcript })),
      model: settings?.agentModel,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    try {
      const [errored] = await db
        .insert(benchmarkAgentScansTable)
        .values({
          callId: params.callId,
          sourceLabel: params.draftTranscript?.trim() ? "draft" : null,
          sourceTranscript: params.draftTranscript?.trim() || null,
          status: "error",
          flags: [],
          hybridFlags: hybridFlagsSummary,
          errorMessage: `judge_failed: ${message}`,
          requestedByLabel: params.requestedByLabel,
          runId: params.runId,
        })
        .returning();
      logger.error({ err, callId: params.callId, scanId: errored.id }, "judge_failed: the OpenAI judge call did not return an answer");
    } catch (writeErr) {
      logger.error({ err: writeErr, callId: params.callId, judgeError: message }, "scan_write_failed: could not even record the judge failure");
    }
    return;
  }

  // Past this line the money is spent and the answer is in hand. Nothing
  // below may throw it away, and nothing below may be blamed on the judge.

  // Which of this call's result rows the judge picked. Best-effort on
  // purpose: losing this lookup loses the LINK to a row, not the answer --
  // the reasoning and the token/cost record still get stored below.
  let agentPickResultId: string | null = null;
  if (judgeResult.pickedProviderId) {
    try {
      const picked = await db
        .select({ id: benchmarkProviderCallResultsTable.id })
        .from(benchmarkProviderCallResultsTable)
        .where(
          and(
            eq(benchmarkProviderCallResultsTable.callId, params.callId),
            eq(benchmarkProviderCallResultsTable.providerId, judgeResult.pickedProviderId),
            eq(benchmarkProviderCallResultsTable.status, "ok"),
            // T-65: the candidates came from THIS run, so the link must
            // point into this run. Unscoped, 106/178 links pointed at a
            // newer run's row for the same provider (found recording the
            // T-26 fixture). Null runId (old manual path) keeps the
            // latest-anywhere behaviour, which is all it ever had.
            ...(params.runId ? [eq(benchmarkProviderCallResultsTable.runId, params.runId)] : []),
          ),
        )
        .orderBy(desc(benchmarkProviderCallResultsTable.createdAt))
        .limit(1);
      agentPickResultId = picked[0]?.id ?? null;
    } catch (err) {
      logger.error(
        { err, callId: params.callId, pickedProviderId: judgeResult.pickedProviderId },
        "scan_write_failed: could not resolve the picked result row -- storing the judge's reasoning without the link",
      );
    }
  }

  const scanRow = {
    callId: params.callId,
    sourceLabel: params.draftTranscript?.trim() ? "draft" : null,
    sourceTranscript: params.draftTranscript?.trim() || null,
    status: "flagged" as const,
    flags,
    hybridFlags: hybridFlagsSummary,
    agentPickResultId,
    agentPickReasoning: judgeResult.reasoning,
    judgePromptTokens: judgeResult.promptTokens,
    judgeCompletionTokens: judgeResult.completionTokens,
    judgeCostMicrocents: judgeResult.costMicrocents,
    requestedByLabel: params.requestedByLabel,
    runId: params.runId,
  };

  let scanId: string;
  let degraded = false;
  try {
    const [flagged] = await db.insert(benchmarkAgentScansTable).values(scanRow).returning();
    scanId = flagged.id;
  } catch (err) {
    // The cost/token columns are the only numeric ones here and therefore
    // the only plausible source of a type/range rejection -- exactly what
    // broke before. Drop them and keep the judgement itself. The row stays
    // "flagged" (the judge succeeded), with errorMessage naming the WRITE.
    const message = err instanceof Error ? err.message : String(err);
    logger.error({ err, callId: params.callId }, "scan_write_failed: full insert rejected, retrying without the cost columns");
    const { judgePromptTokens, judgeCompletionTokens, judgeCostMicrocents, ...withoutCost } = scanRow;
    try {
      const [retried] = await db
        .insert(benchmarkAgentScansTable)
        .values({ ...withoutCost, errorMessage: `scan_write_failed: ${message}` })
        .returning();
      scanId = retried.id;
      degraded = true;
    } catch (retryErr) {
      // Both writes failed. The judgement is unrecoverable from the DB, so
      // put the whole paid-for payload in the log -- that is the last place
      // it can be read back from.
      logger.error(
        {
          err: retryErr,
          firstError: message,
          callId: params.callId,
          pickedProviderId: judgeResult.pickedProviderId,
          reasoning: REDACT_TRANSCRIPT_TEXT_IN_LOGS ? `[redacted, ${judgeResult.reasoning.length} chars]` : judgeResult.reasoning,
          promptTokens: judgeResult.promptTokens,
          completionTokens: judgeResult.completionTokens,
          costMicrocents: judgeResult.costMicrocents,
        },
        "scan_write_failed: could not store a successful judgement at all -- payload logged so the spend is not silently lost",
      );
      return;
    }
  }

  await auditOrLog(
    {
      entityType: "agent_scan",
      entityId: scanId,
      actorLabel: params.requestedByLabel,
      action: degraded ? "auto_verify_flagged_degraded" : "auto_verify_flagged",
      afterState: { callId: params.callId, flagCount: totalFlagCount, pickedResultId: agentPickResultId, costRecorded: !degraded },
    },
    params.callId,
  );
}

/** Called once per completed run (run-executor.ts, after
 * computeHybridFlagsForRun) -- verifies every call that got at least one
 * "ok" cell in THIS run. Never re-verifies work another run already covered
 * (each run's own results are the only scope), so a bulk's shards each pay
 * for their own calls exactly once. */
export async function runAutoAgentVerificationForRun(
  runId: string,
  requestedByLabel: string,
  options: {
    /**
     * T-45. Calls that gained a new ok cell during the execution that is
     * calling us. A call NOT in this set whose scan for this run already
     * finished is skipped: its candidate set is unchanged since that scan,
     * so re-judging it would be a second OpenAI bill for the same answer.
     * Before this, every re-execution -- including one that did nothing at
     * all (T-43 makes that routine) -- re-judged every ok call in the run.
     *
     * A scan that ended in "error" (the judge itself failed) or is still
     * "scanning" (crashed mid-write) does not count as finished and is
     * redone. "clean", "flagged", "approved", "rejected" all count.
     */
    callIdsWithNewEvidence?: ReadonlySet<string>;
  } = {},
): Promise<void> {
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

  const finishedScans = await db
    .select({ callId: benchmarkAgentScansTable.callId })
    .from(benchmarkAgentScansTable)
    .where(
      and(
        eq(benchmarkAgentScansTable.runId, runId),
        inArray(benchmarkAgentScansTable.callId, [...byCallId.keys()]),
        inArray(benchmarkAgentScansTable.status, ["clean", "flagged", "approved", "rejected"]),
        // T-63: a `flagged` scan whose judge named nothing (pre-BAML strict-
        // schema era) is not finished -- there is no pick to show and nothing
        // for judge-accuracy to replay -- so re-executing the run re-judges it.
        // A new scan row is written; the null-pick row stays as history.
        or(ne(benchmarkAgentScansTable.status, "flagged"), isNotNull(benchmarkAgentScansTable.agentPickResultId)),
      ),
    );
  const alreadyVerified = new Set(finishedScans.map((s) => s.callId));
  let skipped = 0;
  for (const callId of [...byCallId.keys()]) {
    if (alreadyVerified.has(callId) && !options.callIdsWithNewEvidence?.has(callId)) {
      byCallId.delete(callId);
      skipped += 1;
    }
  }
  if (skipped > 0) {
    logger.info({ runId, skipped, remaining: byCallId.size }, "T-45: skipping calls already verified for this run with unchanged evidence");
  }
  if (byCallId.size === 0) return;

  const calls = await db
    .select({ id: benchmarkCallsTable.id, draftTranscript: benchmarkCallsTable.draftTranscript })
    .from(benchmarkCallsTable)
    .where(inArray(benchmarkCallsTable.id, [...byCallId.keys()]));
  const draftByCallId = new Map(calls.map((c) => [c.id, c.draftTranscript]));

  // T-15: the calls have no ordering constraint and each is one OpenAI
  // round-trip, so they run through the same fixed-size worker pool the
  // provider cells did. byCallId is a Map, so each call is one item -- no
  // call can be picked up twice.
  const concurrency = envInt("AGENT_CONCURRENCY", 4, 16);
  const started = Date.now();
  await drainWithConcurrency([...byCallId.entries()], concurrency, async ([callId, callRows]) => {
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
  });
  logger.info(
    { runId, calls: byCallId.size, concurrency, wallClockMs: Date.now() - started },
    "auto agent verification pass finished",
  );
}
