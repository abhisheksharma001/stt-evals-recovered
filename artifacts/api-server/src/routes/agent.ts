// The transcript-quality agent (requested by Abhishek 2026-08-25). See
// lib/agent.ts for the two OpenAI calls (flag, judge) and
// benchmark-agent-scans.ts for why this table's pick is a suggestion, never
// a direct write to goldTranscript.
import { desc, eq } from "drizzle-orm";
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
  type BenchmarkAgentScanRow,
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
import { AgentConfigError, AgentRequestError, flagTranscript, judgeCandidates } from "../lib/agent";
import { executeBenchmarkRun } from "../lib/run-executor";
import { actorFromRequest, writeAudit } from "../lib/audit";
import { syncProviderReadiness } from "./benchmark";

const router: IRouter = Router();

async function serializeScan(scan: BenchmarkAgentScanRow) {
  let candidates: {
    providerId: string;
    providerName: string;
    status: "pending" | "ok" | "failed";
    transcript: string | null;
  }[] = [];
  let agentPickProviderId: string | null = null;

  if (scan.runId) {
    const rows = await db
      .select({ result: benchmarkProviderCallResultsTable, provider: benchmarkProvidersTable })
      .from(benchmarkProviderCallResultsTable)
      .innerJoin(
        benchmarkProvidersTable,
        eq(benchmarkProvidersTable.id, benchmarkProviderCallResultsTable.providerId),
      )
      .where(eq(benchmarkProviderCallResultsTable.runId, scan.runId));

    candidates = rows.map(({ result, provider }) => ({
      providerId: provider.id,
      providerName: provider.name,
      status: result.status as "pending" | "ok" | "failed",
      transcript: result.hypothesisTranscript,
    }));

    if (scan.agentPickResultId) {
      agentPickProviderId =
        rows.find((r) => r.result.id === scan.agentPickResultId)?.provider.id ?? null;
    }
  }

  return {
    id: scan.id,
    callId: scan.callId,
    sourceLabel: scan.sourceLabel as "gold" | "draft",
    // 2026-08-26, per Abhishek: the Agent page should show a word-level
    // diff between the real transcript and each candidate, not just the
    // raw candidate text. This column already existed (verbatim copy at
    // scan time, for reproducibility) but was never returned over the API.
    sourceTranscript: scan.sourceTranscript,
    status: scan.status as "scanning" | "clean" | "flagged" | "error" | "approved" | "rejected",
    flags: scan.flags,
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

  // Prefer the reviewed gold transcript when it exists; fall back to the
  // provider draft for a call still mid-review -- either way, record which
  // one was actually read (sourceLabel) so the scan stays reproducible.
  const sourceLabel = call.goldTranscript?.trim() ? "gold" : "draft";
  const sourceTranscript = call.goldTranscript?.trim() || call.draftTranscript?.trim() || null;
  if (!sourceTranscript) {
    res.status(409).json({ error: "This call has no gold or draft transcript to scan yet." });
    return;
  }

  const actorLabel = actorFromRequest(req);
  const [scan] = await db
    .insert(benchmarkAgentScansTable)
    .values({
      callId: call.id,
      sourceLabel,
      sourceTranscript,
      status: "scanning",
      requestedByLabel: actorLabel,
    })
    .returning();

  try {
    const flags = await flagTranscript(sourceTranscript, call.vertical);

    if (flags.length === 0) {
      const [clean] = await db
        .update(benchmarkAgentScansTable)
        .set({ status: "clean", flags: [] })
        .where(eq(benchmarkAgentScansTable.id, scan.id))
        .returning();
      res.status(201).json(CreateAgentScanResponse.parse(await serializeScan(clean)));
      return;
    }

    await syncProviderReadiness();
    const readyProviders = await db
      .select()
      .from(benchmarkProvidersTable)
      .where(eq(benchmarkProvidersTable.status, "ready"));
    // Best-effort: don't ask the provider that already produced the
    // transcript being flagged to "confirm itself" -- see
    // sourceTranscriberProvider's own comment in benchmark-calls.ts for why
    // this field is best-effort, not guaranteed populated.
    const candidateProviders = readyProviders.filter(
      (p) => p.id !== call.sourceTranscriberProvider,
    );

    if (candidateProviders.length === 0) {
      const [errored] = await db
        .update(benchmarkAgentScansTable)
        .set({
          status: "error",
          flags,
          errorMessage: "No configured providers are available to re-transcribe this call against.",
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
        providerIds: candidateProviders.map((p) => p.id),
        callIds: [call.id],
        callCount: 1,
        notes: `Spawned by agent scan ${scan.id} for call ${call.id}.`,
      })
      .returning();

    await db
      .update(benchmarkAgentScansTable)
      .set({ flags, runId: run.id })
      .where(eq(benchmarkAgentScansTable.id, scan.id));

    // Awaited, not fire-and-forget: unlike a batch run this is bounded to
    // one call across a handful of providers, and "scan this call" is a
    // deliberate on-demand click a human is waiting on -- see lib/agent.ts's
    // header comment for why this is a v1 tradeoff, not the batch pattern.
    await executeBenchmarkRun(run.id, actorLabel);

    const resultRows = await db
      .select({ result: benchmarkProviderCallResultsTable, provider: benchmarkProvidersTable })
      .from(benchmarkProviderCallResultsTable)
      .innerJoin(
        benchmarkProvidersTable,
        eq(benchmarkProvidersTable.id, benchmarkProviderCallResultsTable.providerId),
      )
      .where(eq(benchmarkProviderCallResultsTable.runId, run.id));

    const okCandidates = resultRows.filter((r) => r.result.status === "ok" && r.result.hypothesisTranscript);
    // 2026-08-26: system-wide, changeable judge model (falls back to
    // lib/agent.ts's own JUDGE_MODEL constant when unset).
    const [settings] = await db
      .select({ agentModel: appSettingsTable.agentModel })
      .from(appSettingsTable)
      .where(eq(appSettingsTable.id, APP_SETTINGS_ID))
      .limit(1);
    const judgeResult = await judgeCandidates({
      originalTranscript: sourceTranscript,
      flags,
      candidates: okCandidates.map((r) => ({
        providerId: r.provider.id,
        providerName: r.provider.name,
        transcript: r.result.hypothesisTranscript as string,
      })),
      model: settings?.agentModel,
    });

    const pickedResultId =
      okCandidates.find((r) => r.provider.id === judgeResult.pickedProviderId)?.result.id ?? null;

    const [flagged] = await db
      .update(benchmarkAgentScansTable)
      .set({
        status: "flagged",
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
      afterState: { callId: call.id, flagCount: flags.length, pickedResultId },
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
  if (scan.status !== "flagged" || !scan.agentPickResultId) {
    res.status(409).json({ error: "This scan has no pick to approve, or is not awaiting a decision." });
    return;
  }

  const [pickedResult] = await db
    .select()
    .from(benchmarkProviderCallResultsTable)
    .where(eq(benchmarkProviderCallResultsTable.id, scan.agentPickResultId))
    .limit(1);
  if (!pickedResult?.hypothesisTranscript) {
    res.status(409).json({ error: "The picked result no longer has a usable transcript." });
    return;
  }

  const [call] = await db
    .select()
    .from(benchmarkCallsTable)
    .where(eq(benchmarkCallsTable.id, scan.callId))
    .limit(1);
  if (!call) {
    res.status(404).json({ error: "Benchmark call not found" });
    return;
  }

  const approver = body.data.approverLabel.trim();
  // Same rule as PATCH /benchmark/calls: only advance status to
  // ready_to_run if de-id is already cleared -- approving an agent's pick
  // never bypasses that gate, it only ever sets goldTranscript.
  const canAdvanceStatus = Boolean(call.deIdAttestedByLabel && call.deIdSecondApproverLabel);
  const [updatedCall] = await db
    .update(benchmarkCallsTable)
    .set({
      goldTranscript: pickedResult.hypothesisTranscript,
      status: canAdvanceStatus ? "ready_to_run" : call.status,
      updatedAt: new Date(),
    })
    .where(eq(benchmarkCallsTable.id, call.id))
    .returning();

  const [approved] = await db
    .update(benchmarkAgentScansTable)
    .set({ status: "approved", decidedByLabel: approver, decidedAt: new Date() })
    .where(eq(benchmarkAgentScansTable.id, scan.id))
    .returning();

  await writeAudit({
    entityType: "call",
    entityId: call.id,
    actorLabel: approver,
    action: "agent_pick_approved",
    beforeState: { goldTranscript: call.goldTranscript },
    afterState: { goldTranscript: updatedCall.goldTranscript, scanId: scan.id },
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
