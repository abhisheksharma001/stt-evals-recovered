// The transcript-quality agent (requested by Abhishek 2026-08-25, reworked
// 2026-08-27: "we don't need a gold transcript any more ... make agent
// system better ... use a hybrid system"). A scan now runs the same
// gold-free hybrid pipeline every bundle run gets automatically
// (hybrid-flagging.ts / lib/scoring/src/hybrid.ts: cross-provider
// disagreement + provider confidence + entity cross-check), reusing
// whichever candidate transcripts the call already has instead of always
// paying to re-transcribe. An LLM explanation only runs when the hybrid
// pass actually found something -- see lib/agent.ts's judgeCandidates.
import { and, desc, eq, inArray } from "drizzle-orm";
import { Router, type IRouter } from "express";
import {
  APP_SETTINGS_ID,
  appSettingsTable,
  benchmarkAgentScansTable,
  benchmarkCallsTable,
  benchmarkProviderCallResultsTable,
  benchmarkProvidersTable,
  benchmarkRunsTable,
  db,
  type BenchmarkAgentFlag,
  type BenchmarkAgentScanRow,
  type BenchmarkHybridFlagSummary,
} from "@workspace/db";
import {
  ApproveAgentScanBody,
  ApproveAgentScanParams,
  ApproveAgentScanResponse,
  CreateAgentScanBody,
  CreateAgentScanResponse,
  ListAgentScansQueryParams,
  ListAgentScansResponse,
  RejectAgentScanBody,
  RejectAgentScanParams,
  RejectAgentScanResponse,
} from "@workspace/api-zod";
import { AgentConfigError, AgentRequestError, judgeCandidates } from "../lib/agent";
import { computeHybridFlagsForCandidates } from "../lib/hybrid-flagging";
import { executeBenchmarkRun } from "../lib/run-executor";
import { actorFromRequest, writeAudit } from "../lib/audit";
import { syncProviderReadiness } from "./benchmark";

const router: IRouter = Router();

async function serializeScan(scan: BenchmarkAgentScanRow) {
  // 2026-08-27: candidates are keyed by CALL, not by scan.runId -- most
  // scans now reuse a call's existing results instead of spawning a fresh
  // run (see POST .../scans), so runId is routinely null even for a
  // perfectly real, fully-candidated scan. Looking up by callId (latest ok
  // result per provider, same query the scan route itself uses) works
  // whether or not this particular scan spawned a run. Found live: the
  // runId-only version silently returned zero candidates for every reused
  // scan despite the flags/hybridFlags being real.
  const rows = await db
    .select({ result: benchmarkProviderCallResultsTable, provider: benchmarkProvidersTable })
    .from(benchmarkProviderCallResultsTable)
    .innerJoin(
      benchmarkProvidersTable,
      eq(benchmarkProvidersTable.id, benchmarkProviderCallResultsTable.providerId),
    )
    .where(
      and(
        eq(benchmarkProviderCallResultsTable.callId, scan.callId),
        // skipped_pending_review/cancelled are bookkeeping placeholders for
        // cells never actually attempted -- not real candidates, and not a
        // status AgentScanCandidate's schema even allows (found live: this
        // 400'd the whole scans list once a call had any bulk-shard history).
        inArray(benchmarkProviderCallResultsTable.status, ["ok", "failed", "pending"]),
      ),
    )
    .orderBy(desc(benchmarkProviderCallResultsTable.createdAt));

  const latestByProvider = new Map<string, (typeof rows)[number]>();
  for (const row of rows) {
    if (!latestByProvider.has(row.provider.id)) latestByProvider.set(row.provider.id, row);
  }
  const candidateRows = [...latestByProvider.values()];

  const candidates = candidateRows.map(({ result, provider }) => ({
    providerId: provider.id,
    providerName: provider.name,
    status: result.status as "pending" | "ok" | "failed",
    transcript: result.hypothesisTranscript,
  }));

  const agentPickProviderId = scan.agentPickResultId
    ? (candidateRows.find((r) => r.result.id === scan.agentPickResultId)?.provider.id ?? null)
    : null;

  return {
    id: scan.id,
    callId: scan.callId,
    sourceLabel: scan.sourceLabel as "draft" | "gold" | null,
    sourceTranscript: scan.sourceTranscript,
    status: scan.status as "scanning" | "clean" | "flagged" | "error" | "approved" | "rejected",
    flags: scan.flags,
    hybridFlags: scan.hybridFlags,
    runId: scan.runId,
    candidates,
    agentPickProviderId,
    agentPickReasoning: scan.agentPickReasoning,
    errorMessage: scan.errorMessage,
    requestedByLabel: scan.requestedByLabel,
    decidedByLabel: scan.decidedByLabel,
    decidedAt: scan.decidedAt?.toISOString() ?? null,
    createdAt: scan.createdAt.toISOString(),
  };
}

router.get("/benchmark/agent/scans", async (req, res): Promise<void> => {
  const parsed = ListAgentScansQueryParams.safeParse(req.query);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }

  const rows = parsed.data.callId
    ? await db
        .select()
        .from(benchmarkAgentScansTable)
        .where(eq(benchmarkAgentScansTable.callId, parsed.data.callId))
        .orderBy(desc(benchmarkAgentScansTable.createdAt))
    : await db
        .select()
        .from(benchmarkAgentScansTable)
        .orderBy(desc(benchmarkAgentScansTable.createdAt));

  res.json(ListAgentScansResponse.parse(await Promise.all(rows.map(serializeScan))));
});

/** Human-readable {text, reason} restatements of the hybrid flags, for the
 * legacy `flags` column the UI already knows how to render. Kept separate
 * from the structured `hybridFlags` (the real data) so a caller that only
 * understands the old shape still gets something useful. */
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
      const key = `${mismatch.type}:${JSON.stringify(mismatch.valuesByProvider)}`;
      if (seenEntityMismatches.has(key)) continue;
      seenEntityMismatches.add(key);
      const byProviderText = Object.entries(mismatch.valuesByProvider)
        .map(([pid, values]) => `${candidatesByProvider.get(pid)?.providerName ?? pid}: ${values.join(", ")}`)
        .join(" vs. ");
      flags.push({
        text: mismatch.type.replace(/_/g, " "),
        reason: `Candidates disagree on the ${mismatch.type.replace(/_/g, " ")} itself -- ${byProviderText}.`,
      });
    }
  }
  return flags;
}

router.post("/benchmark/agent/scans", async (req, res): Promise<void> => {
  const parsed = CreateAgentScanBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }

  const [call] = await db
    .select()
    .from(benchmarkCallsTable)
    .where(eq(benchmarkCallsTable.id, parsed.data.callId))
    .limit(1);
  if (!call) {
    res.status(404).json({ error: "Benchmark call not found" });
    return;
  }

  const actorLabel = actorFromRequest(req);
  const [scan] = await db
    .insert(benchmarkAgentScansTable)
    .values({
      callId: call.id,
      sourceLabel: call.draftTranscript?.trim() ? "draft" : null,
      sourceTranscript: call.draftTranscript?.trim() || null,
      status: "scanning",
      requestedByLabel: actorLabel,
    })
    .returning();

  try {
    // 2026-08-27: reuse whatever this call has already been transcribed by
    // (its most recent successful run per provider) instead of always
    // paying to re-transcribe -- with bundles as the primary pipeline now, a
    // call almost always already has candidates by the time someone scans
    // it here.
    const existingOkResults = await db
      .select({ result: benchmarkProviderCallResultsTable, provider: benchmarkProvidersTable })
      .from(benchmarkProviderCallResultsTable)
      .innerJoin(
        benchmarkProvidersTable,
        eq(benchmarkProvidersTable.id, benchmarkProviderCallResultsTable.providerId),
      )
      .where(
        eq(benchmarkProviderCallResultsTable.callId, call.id),
      )
      .orderBy(desc(benchmarkProviderCallResultsTable.createdAt));

    const latestOkByProvider = new Map<string, (typeof existingOkResults)[number]>();
    for (const row of existingOkResults) {
      if (row.result.status !== "ok" || !row.result.hypothesisTranscript) continue;
      if (!latestOkByProvider.has(row.provider.id)) latestOkByProvider.set(row.provider.id, row);
    }

    let scanRunId: string | null = null;
    let candidateRows = [...latestOkByProvider.values()];

    if (candidateRows.length < 2) {
      // Not enough existing candidates to compare -- spawn a bounded,
      // single-call run against every ready provider, same as before.
      await syncProviderReadiness();
      const readyProviders = await db
        .select()
        .from(benchmarkProvidersTable)
        .where(eq(benchmarkProvidersTable.status, "ready"));

      if (readyProviders.length === 0) {
        const [errored] = await db
          .update(benchmarkAgentScansTable)
          .set({
            status: "error",
            errorMessage: "No configured providers are available to transcribe this call against.",
          })
          .where(eq(benchmarkAgentScansTable.id, scan.id))
          .returning();
        res.status(201).json(CreateAgentScanResponse.parse(await serializeScan(errored)));
        return;
      }

      const [run] = await db
        .insert(benchmarkRunsTable)
        .values({
          status: "queued",
          purpose: "agent_scan",
          providerIds: readyProviders.map((p) => p.id),
          callIds: [call.id],
          callCount: 1,
          notes: `Spawned by agent scan ${scan.id} for call ${call.id}.`,
        })
        .returning();
      scanRunId = run.id;

      await db
        .update(benchmarkAgentScansTable)
        .set({ runId: run.id })
        .where(eq(benchmarkAgentScansTable.id, scan.id));

      // Awaited, not fire-and-forget: this is bounded to one call across a
      // handful of providers, and "scan this call" is a deliberate on-demand
      // click a human is waiting on.
      await executeBenchmarkRun(run.id, actorLabel);

      const freshResults = await db
        .select({ result: benchmarkProviderCallResultsTable, provider: benchmarkProvidersTable })
        .from(benchmarkProviderCallResultsTable)
        .innerJoin(
          benchmarkProvidersTable,
          eq(benchmarkProvidersTable.id, benchmarkProviderCallResultsTable.providerId),
        )
        .where(eq(benchmarkProviderCallResultsTable.runId, run.id));
      const merged = new Map(latestOkByProvider);
      for (const row of freshResults) {
        if (row.result.status === "ok" && row.result.hypothesisTranscript) {
          merged.set(row.provider.id, row);
        }
      }
      candidateRows = [...merged.values()];
    }

    if (candidateRows.length === 0) {
      const [errored] = await db
        .update(benchmarkAgentScansTable)
        .set({
          status: "error",
          errorMessage: "No provider has ever successfully transcribed this call -- nothing to compare.",
          runId: scanRunId,
        })
        .where(eq(benchmarkAgentScansTable.id, scan.id))
        .returning();
      res.status(201).json(CreateAgentScanResponse.parse(await serializeScan(errored)));
      return;
    }

    const candidatesByProvider = new Map(
      candidateRows.map((r) => [r.provider.id, { providerName: r.provider.name, transcript: r.result.hypothesisTranscript! }]),
    );
    const hybridByProvider = computeHybridFlagsForCandidates(
      candidateRows.map((r) => ({
        providerId: r.provider.id,
        transcript: r.result.hypothesisTranscript!,
        rawOutputJson: r.result.rawOutput,
      })),
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
        .map((m) => ({ type: m.type, valuesByProvider: m.valuesByProvider })),
    };

    if (totalFlagCount === 0) {
      const [clean] = await db
        .update(benchmarkAgentScansTable)
        .set({ status: "clean", flags: [], hybridFlags: hybridFlagsSummary, runId: scanRunId })
        .where(eq(benchmarkAgentScansTable.id, scan.id))
        .returning();
      res.status(201).json(CreateAgentScanResponse.parse(await serializeScan(clean)));
      return;
    }

    const flags = deriveFlagTexts(candidatesByProvider, hybridByProvider);

    // 2026-08-26: system-wide, changeable judge model.
    const [settings] = await db
      .select({ agentModel: appSettingsTable.agentModel })
      .from(appSettingsTable)
      .where(eq(appSettingsTable.id, APP_SETTINGS_ID))
      .limit(1);
    const judgeResult = await judgeCandidates({
      originalTranscript: call.draftTranscript?.trim() || "(no draft transcript on file)",
      flags,
      candidates: candidateRows.map((r) => ({
        providerId: r.provider.id,
        providerName: r.provider.name,
        transcript: r.result.hypothesisTranscript!,
      })),
      model: settings?.agentModel,
    });

    const pickedResultId =
      candidateRows.find((r) => r.provider.id === judgeResult.pickedProviderId)?.result.id ?? null;

    const [flagged] = await db
      .update(benchmarkAgentScansTable)
      .set({
        status: "flagged",
        flags,
        hybridFlags: hybridFlagsSummary,
        runId: scanRunId,
        agentPickResultId: pickedResultId,
        agentPickReasoning: judgeResult.reasoning,
      })
      .where(eq(benchmarkAgentScansTable.id, scan.id))
      .returning();

    await writeAudit({
      entityType: "agent_scan",
      entityId: scan.id,
      actorLabel,
      action: "flagged",
      afterState: { callId: call.id, flagCount: totalFlagCount, pickedResultId },
    });

    res.status(201).json(CreateAgentScanResponse.parse(await serializeScan(flagged)));
  } catch (err) {
    const message =
      err instanceof AgentConfigError || err instanceof AgentRequestError
        ? err.message
        : err instanceof Error
          ? err.message
          : String(err);
    const [errored] = await db
      .update(benchmarkAgentScansTable)
      .set({ status: "error", errorMessage: message })
      .where(eq(benchmarkAgentScansTable.id, scan.id))
      .returning();
    req.log.error({ err, scanId: scan.id }, "Agent scan failed");
    res.status(201).json(CreateAgentScanResponse.parse(await serializeScan(errored)));
  }
});

router.post("/benchmark/agent/scans/:scanId/approve", async (req, res): Promise<void> => {
  const params = ApproveAgentScanParams.safeParse(req.params);
  const body = ApproveAgentScanBody.safeParse(req.body);
  if (!params.success || !body.success) {
    res.status(400).json({ error: (params.error ?? body.error)?.message });
    return;
  }

  const [scan] = await db
    .select()
    .from(benchmarkAgentScansTable)
    .where(eq(benchmarkAgentScansTable.id, params.data.scanId))
    .limit(1);
  if (!scan) {
    res.status(404).json({ error: "Agent scan not found" });
    return;
  }
  if (scan.status !== "flagged") {
    res.status(409).json({ error: "This scan is not awaiting a decision." });
    return;
  }

  const approver = body.data.approverLabel.trim();
  // 2026-08-27: gold-free -- there is nothing left to write. Approve is now
  // purely an audit-trail acknowledgment that a human looked at the flags
  // and the agent's pick and agreed with it (or at least isn't disputing
  // it) -- it no longer touches benchmarkCallsTable at all.
  const [approved] = await db
    .update(benchmarkAgentScansTable)
    .set({ status: "approved", decidedByLabel: approver, decidedAt: new Date() })
    .where(eq(benchmarkAgentScansTable.id, scan.id))
    .returning();

  await writeAudit({
    entityType: "agent_scan",
    entityId: scan.id,
    actorLabel: approver,
    action: "approved",
    afterState: { callId: scan.callId, agentPickResultId: scan.agentPickResultId },
  });

  res.json(ApproveAgentScanResponse.parse(await serializeScan(approved)));
});

router.post("/benchmark/agent/scans/:scanId/reject", async (req, res): Promise<void> => {
  const params = RejectAgentScanParams.safeParse(req.params);
  const body = RejectAgentScanBody.safeParse(req.body);
  if (!params.success || !body.success) {
    res.status(400).json({ error: (params.error ?? body.error)?.message });
    return;
  }

  const [scan] = await db
    .select()
    .from(benchmarkAgentScansTable)
    .where(eq(benchmarkAgentScansTable.id, params.data.scanId))
    .limit(1);
  if (!scan) {
    res.status(404).json({ error: "Agent scan not found" });
    return;
  }
  if (scan.status === "approved" || scan.status === "rejected") {
    res.status(409).json({ error: "This scan was already decided." });
    return;
  }

  const approver = body.data.approverLabel.trim();
  const [rejected] = await db
    .update(benchmarkAgentScansTable)
    .set({ status: "rejected", decidedByLabel: approver, decidedAt: new Date() })
    .where(eq(benchmarkAgentScansTable.id, scan.id))
    .returning();

  await writeAudit({
    entityType: "agent_scan",
    entityId: scan.id,
    actorLabel: approver,
    action: "rejected",
    afterState: { callId: scan.callId },
  });

  res.json(RejectAgentScanResponse.parse(await serializeScan(rejected)));
});

export default router;
