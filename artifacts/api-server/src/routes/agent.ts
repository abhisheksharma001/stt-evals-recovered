// The transcript-quality agent (requested by Abhishek 2026-08-25, reworked
// 2026-08-27: "we don't need a gold transcript any more ... make agent
// system better ... use a hybrid system", then same day: "bulk calls will
// also do the agent system working, remove the agent thing, just keep bulk
// which will do the work"). What used to be a manual, on-demand Scan button
// on a standalone Agent page now runs automatically -- every completed run
// (bulk or ad-hoc) verifies its own calls via
// lib/agent-verify.ts's runAutoAgentVerificationForRun, called from
// run-executor.ts right after the free hybrid pass. This file is now just
// the read side: list scan results (for Results/Corpus to display) and the
// approve/reject audit-trail actions, kept from the old manual flow since
// they never did anything besides record that a human looked.
import { and, desc, eq, inArray } from "drizzle-orm";
import { Router, type IRouter } from "express";
import {
  benchmarkAgentScansTable,
  benchmarkProviderCallResultsTable,
  benchmarkProvidersTable,
  db,
  type BenchmarkAgentScanRow,
} from "@workspace/db";
import {
  ApproveAgentScanBody,
  ApproveAgentScanParams,
  ApproveAgentScanResponse,
  ListAgentScansQueryParams,
  ListAgentScansResponse,
  RejectAgentScanBody,
  RejectAgentScanParams,
  RejectAgentScanResponse,
} from "@workspace/api-zod";
import { actorFromRequest, writeAudit } from "../lib/audit";

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
    judgePromptTokens: scan.judgePromptTokens,
    judgeCompletionTokens: scan.judgeCompletionTokens,
    judgeCostCents: scan.judgeCostCents,
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
