import { and, desc, eq, isNull, or } from "drizzle-orm";
// T-153: each serializer declares the shape it produces as the contract's own
// input type, so a required field cannot fall out of a serializer without
// failing tsc -- the error lands at the source, not at 20 call sites. The
// annotation names one operation's schema; the operations share the spec
// component, so structural typing makes it hold for every call site. Dates
// travel as Date here: the schemas are zod.coerce.date(), and res.json
// writes a Date as the same ISO string toISOString produced.
import type { ZodInput } from "@workspace/api-zod";
import { Router, type IRouter, type Response } from "express";
import {
  APP_SETTINGS_ID,
  appSettingsTable,
  auditLogTable,
  benchmarkBulksTable,
  benchmarkCallsTable,
  benchmarkProviderCallResultsTable,
  benchmarkProvidersTable,
  benchmarkRankingsTable,
  benchmarkRunsTable,
  benchmarkScoresTable,
  db,
  type BenchmarkRunRow,
} from "@workspace/db";
import { getProviderAdapter, listProviderAdapters, providerIdForModel, vendorOf, type ProviderModelOption } from "@workspace/stt-providers";
import { latestFinishedBulk, monthSpend, needsHuman, runningBulk } from "../lib/overview";
import { wordsToWatch } from "../lib/words-to-watch";
import { assistantSignals } from "../lib/assistant-signals";
import { proxyAgreement } from "../lib/proxy-agreement";
import { isUniqueViolation } from "../lib/bulks";
import { assistantTranscriberConfig } from "../lib/assistant-transcriber";
import { respondVapiError } from "../lib/vapi-error-response";
import { BLANK_APPROVER_MESSAGE, trimmedApproverLabel } from "../lib/approver-label";
import { listOpenAiJudgeModels, OpenAiModelsError, PINNED_AGENT_MODELS } from "../lib/openai-models";
import { callComparison, cellRetryable } from "../lib/call-comparison";
import { callDisagreement } from "../lib/call-disagreement";
import {
  AttestBenchmarkCallDeidBody,
  AttestBenchmarkCallDeidParams,
  AttestBenchmarkCallDeidResponse,
  CreateBenchmarkCallBody,
  CreateBenchmarkCallResponse,
  CreateBenchmarkProviderBody,
  CreateBenchmarkProviderResponse,
  CreateBenchmarkRunBody,
  CreateBenchmarkRunResponse,
  ExecuteBenchmarkRunParams,
  ExecuteBenchmarkRunResponse,
  GetBenchmarkDashboardResponse,
  GetBenchmarkPlanResponse,
  GetBenchmarkRunManifestParams,
  GetBenchmarkRunManifestResponse,
  ImportVapiCallsBody,
  CacheCorpusAudioResponse,
  SetRunArchivedBody,
  SetRunArchivedParams,
  SetRunArchivedResponse,
  ImportVapiCallsResponse,
  ListAuditLogQueryParams,
  ListAuditLogResponse,
  ListBenchmarkCallsQueryParams,
  GetCallDisagreementQueryParams,
  GetCallDisagreementResponse,
  GetWordsToWatchQueryParams,
  GetWordsToWatchResponse,
  GetAssistantSignalsQueryParams,
  GetAssistantSignalsResponse,
  GetProxyAgreementResponse,
  ListBenchmarkCallsResponse,
  ListBenchmarkProvidersResponse,
  ListBenchmarkRankingsQueryParams,
  ListBenchmarkRankingsResponse,
  ListBenchmarkRunResultsParams,
  ListBenchmarkRunResultsResponse,
  ListBenchmarkRunsResponse,
  ListVapiAccountsResponse,
  PreviewVapiCallsBody,
  PreviewVapiCallsResponse,
  UpdateBenchmarkCallBody,
  GetBenchmarkCallParams,
  GetBenchmarkCallResponse,
  GetBulkCallComparisonParams,
  GetBulkCallComparisonResponse,
  GetBenchmarkCallAudioParams,
  GetCallComparisonParams,
  GetCallComparisonResponse,
  UpdateBenchmarkCallParams,
  UpdateBenchmarkCallResponse,
  UpdateBenchmarkProviderBody,
  UpdateBenchmarkProviderParams,
  UpdateBenchmarkProviderResponse,
  GetAppSettingsResponse,
  UpdateAppSettingsBody,
  UpdateAppSettingsResponse,
  ListVapiAssistantsQueryParams,
  ListVapiAssistantsResponse,
  GetAssistantTranscriberParams,
  ListAgentModelsResponse,
  ListProviderModelsResponse,
  EnableProviderModelBody,
  EnableProviderModelResponse,
  GetAssistantTranscriberResponse,
  AnalyzeResultFailureParams,
  AnalyzeResultFailureResponse,
} from "@workspace/api-zod";
import { serializeCall } from "../lib/serialize-call";
import {
  importVapiCalls,
  previewVapiCalls,
  UnknownVapiAccountError,
  VapiSourceError,
} from "../lib/vapi-import";
import { benchmarkPlan } from "../lib/benchmark-plan";
import { buildRunManifest } from "../lib/manifest";
import {
  fetchVapiAssistants,
  listVapiAccounts,
  resolveFreshRecordingUrl,
  VapiNoRecordingError,
  VapiRequestError,
} from "../lib/vapi";
import { actorFromRequest, writeAudit } from "../lib/audit";
import { AgentConfigError, AgentRequestError, JUDGE_MODEL, analyzeFailure, matchKnownFailure, pricedAgentModels } from "../lib/agent";
import { logger } from "../lib/logger";
import { executeBenchmarkRun } from "../lib/run-executor";
import { audioCachePathFor, isAudioCached, isCustomerAudioCached, listCachedCallIds, listCachedCustomerCallIds } from "../lib/audio-cache";
import { listBenchmarkCallRows, listBenchmarkedCallIds } from "../lib/calls";
import { rescueUncachedAudio } from "../lib/audio-rescue";
import { cachedVendorModels } from "../lib/model-list-cache";
import { defaultProviders } from "../lib/default-providers";
import { respondInvalid } from "../lib/validation-error";
import { respondJson } from "../lib/respond";
import { createReadStream } from "node:fs";
import { stat as fsStat } from "node:fs/promises";

const router: IRouter = Router();

async function ensureDefaultProviders(): Promise<void> {
  await db
    .insert(benchmarkProvidersTable)
    .values(
      defaultProviders.map((provider) => ({
        ...provider,
        status: "not_configured",
      })),
    )
    .onConflictDoNothing();
}

// Provider "ready" status is derived, not manually toggled: a provider is
// ready only when (a) a PRO-03 adapter exists for its id and (b) that
// adapter's API key env var is actually set, unless an operator has
// manually disabled it (FR-P3). This keeps status truthful -- there is no
// UI path that can claim "ready" without a real, working credential.
export async function syncProviderReadiness(opts?: {
  /** R-46: a seam, for the same reason R-27 added one to the executor. The
   *  window this function has to get wrong is between reading a provider row
   *  and writing its derived status, and nothing outside the process can open
   *  that window on purpose. A test hook that runs inside it is the only way
   *  to prove the guard without a sleep and a coin flip. Never passed in
   *  production; the parameter is optional and unused there. */
  onBeforeUpdate?: (providerId: string) => Promise<void>;
}): Promise<void> {
  const providers = await db.select().from(benchmarkProvidersTable);
  for (const provider of providers) {
    const adapter = getProviderAdapter(provider.id);
    const apiKeyConfigured = Boolean(adapter && process.env[adapter.apiKeyEnvVar]);
    const nextStatus = provider.manuallyDisabled
      ? "disabled"
      : adapter && apiKeyConfigured
        ? "ready"
        : "not_configured";
    if (nextStatus !== provider.status) {
      // R-46 (ox-alpha B-82): this is a read-modify-write. The row was read at
      // the top of the function, and `nextStatus` was derived from that
      // snapshot. A PATCH that lands in between -- setting manuallyDisabled --
      // commits its own sync, and then this blind `WHERE id` would overwrite
      // the result with a status computed from the pre-PATCH row, putting a
      // provider the operator just switched off back to `ready`.
      //
      // Repeating the input in the WHERE makes the write conditional on the
      // snapshot still being true: if manuallyDisabled moved, this matches no
      // rows and does nothing, and the PATCH's own sync (:1434) has already
      // written the right value.
      //
      // R-13 means this was never a spend bug -- runCell reads
      // manuallyDisabled, not this derived status -- but the Setup page reads
      // it, and a switch that flips itself back on is worth not shipping.
      await opts?.onBeforeUpdate?.(provider.id);
      await db
        .update(benchmarkProvidersTable)
        .set({ status: nextStatus, updatedAt: new Date() })
        .where(
          and(
            eq(benchmarkProvidersTable.id, provider.id),
            eq(benchmarkProvidersTable.manuallyDisabled, provider.manuallyDisabled),
          ),
        );
    }
  }
}

function serializeProvider(provider: typeof benchmarkProvidersTable.$inferSelect): ZodInput<typeof CreateBenchmarkProviderResponse> {
  const adapter = getProviderAdapter(provider.id);
  return {
    id: provider.id,
    name: provider.name,
    model: provider.model,
    // The db column is unconstrained text; the respondJson parse validates
    // the value at the edge, the cast only carries the contract's union.
    status: provider.status as ZodInput<typeof CreateBenchmarkProviderResponse>["status"],
    supportsStreaming: provider.supportsStreaming,
    supportsDiarization: provider.supportsDiarization,
    costPerMinute: provider.costPerMinute,
    keywordBoosting: provider.keywordBoosting,
    configNote: provider.configNote,
    hasAdapter: Boolean(adapter),
    apiKeyConfigured: Boolean(adapter && process.env[adapter.apiKeyEnvVar]),
  };
}

function serializeRun(run: BenchmarkRunRow, bulkName: string | null = null): ZodInput<typeof CreateBenchmarkRunResponse> {
  return {
    id: run.id,
    // Same rule: unconstrained text column, value held by the runtime parse.
    status: run.status as ZodInput<typeof CreateBenchmarkRunResponse>["status"],
    providerIds: run.providerIds,
    callCount: run.callCount,
    createdAt: run.createdAt,
    completedAt: run.completedAt,
    notes: run.notes,
    bulkId: run.bulkId ?? null,
    bulkName,
    shardIndex: run.shardIndex ?? null,
    archivedAt: run.archivedAt,
  };
}

router.get("/benchmark/dashboard", async (_req, res): Promise<void> => {
  await ensureDefaultProviders();
  await syncProviderReadiness();
  const [calls, providers, latestRuns, finished, running, human, month] = await Promise.all([
    db.select().from(benchmarkCallsTable),
    db.select().from(benchmarkProvidersTable),
    db
      .select()
      .from(benchmarkRunsTable)
      // T-134: an archived run is not "the latest" anything.
      .where(isNull(benchmarkRunsTable.archivedAt))
      .orderBy(desc(benchmarkRunsTable.createdAt))
      .limit(1),
    // T-71 (E.3): the Overview blocks, computed in lib/overview.ts.
    latestFinishedBulk(),
    runningBulk(),
    needsHuman(),
    monthSpend(),
  ]);

  // Unconstrained text column; value held by the runtime parse (T-153 rule).
  const latestRunStatus = (latestRuns[0]?.status ?? "blocked") as ZodInput<typeof GetBenchmarkDashboardResponse>["latestRunStatus"];
  // 2026-08-27, per Abhishek: gold-transcript stage retired, then the
  // de-identification gate itself retired too -- import lands a call
  // directly at ready_to_run (see PATCH /benchmark/calls above), so
  // readyToRunCount === 0 with a non-empty corpus shouldn't happen under
  // normal use any more. Keep the branch (a call could still be moved to
  // another status by hand) but don't blame a gate that no longer exists.
  const readyToRunCount = calls.filter((call) => call.status === "ready_to_run").length;

  const data = {
    corpusCount: calls.length,
    readyToRunCount,
    configuredProviderCount: providers.filter(
      (provider) => provider.status === "ready",
    ).length,
    totalProviderCount: providers.length,
    latestRunStatus,
    decisionStatus:
      calls.length === 0
        ? "Starter corpus not registered"
        : readyToRunCount === 0
          ? "No calls ready to run yet"
          : providers.every((provider) => provider.status !== "ready")
            ? "Provider credentials not configured"
            : "Ready for controlled benchmark run",
    latestFinishedBulk: finished,
    runningBulk: running,
    needsHuman: human,
    thisMonth: month,
  };

  respondJson(res, GetBenchmarkDashboardResponse, data);
});

router.get("/benchmark/calls", async (req, res): Promise<void> => {
  const parsed = ListBenchmarkCallsQueryParams.safeParse(req.query);
  if (!parsed.success) {
    respondInvalid(res, parsed.error);
    return;
  }

  // T-79 (J.1): the query lives in lib/calls.ts, moved while T-124 touched
  // this handler.
  const calls = await listBenchmarkCallRows(parsed.data);

  // T-124: one readdir decorates every row with whether its audio bytes
  // are already on disk -- the Corpus retention chips read this instead of
  // guessing from age alone.
  const cachedIds = await listCachedCallIds();
  // M-6: a second readdir of the same directory, for the same reason -- one
  // per response, not one stat per call.
  const customerCachedIds = await listCachedCustomerCallIds();
  // One `select distinct` for the whole response, same rule as the two
  // readdirs above: the Corpus filter needs to separate calls a run has
  // touched from calls nothing has, and every call's status is
  // `ready_to_run` either way.
  const benchmarkedIds = await listBenchmarkedCallIds(calls.map((c) => c.id));
  respondJson(
    res,
    ListBenchmarkCallsResponse,
    calls.map((c) =>
      serializeCall(c, {
        cache: { audio: cachedIds.has(c.id), customerAudio: customerCachedIds.has(c.id) },
        benchmarked: benchmarkedIds.has(c.id),
      }),
    ),
  );
});

router.post("/benchmark/calls", async (req, res): Promise<void> => {
  const parsed = CreateBenchmarkCallBody.safeParse(req.body);
  if (!parsed.success) {
    req.log.warn({ error: parsed.error.message }, "Invalid benchmark call");
    respondInvalid(res, parsed.error);
    return;
  }

  let call: typeof benchmarkCallsTable.$inferSelect;
  try {
    [call] = await db
      .insert(benchmarkCallsTable)
      .values({
        label: parsed.data.label,
        vertical: parsed.data.vertical,
        durationSeconds: Math.round(parsed.data.durationSeconds),
        hardCases: parsed.data.hardCases ?? [],
        entityNotes: parsed.data.entityNotes,
        entityReferences: parsed.data.entityReferences ?? [],
        audioObjectPath: parsed.data.audioObjectPath,
        // W-12: a public-set clip brings its own human-reviewed gold and its
        // provenance. Omitted, the column defaults keep the manual call
        // exactly as before ("manual", no source id, no account label).
        goldTranscript: parsed.data.goldTranscript,
        ...(parsed.data.sourceProvider ? { sourceProvider: parsed.data.sourceProvider } : {}),
        sourceCallId: parsed.data.sourceCallId,
        sourceAccountLabel: parsed.data.sourceAccountLabel,
        // De-id gate removed 2026-08-27 per Abhishek: a call is runnable the
        // moment it exists, so it lands ready_to_run rather than waiting on a
        // review step that no longer gates anything.
        status: "ready_to_run",
      })
      .returning();
  } catch (err) {
    // (sourceProvider, sourceCallId) is unique: the same upstream clip
    // registered twice is a conflict the caller can act on, not a 500.
    if (isUniqueViolation(err)) {
      res.status(409).json({
        error: `A call from ${parsed.data.sourceProvider} with source id "${parsed.data.sourceCallId}" is already in the corpus.`,
      });
      return;
    }
    throw err;
  }

  await writeAudit({
    entityType: "call",
    entityId: call.id,
    actorLabel: actorFromRequest(req),
    action: "create",
    afterState: serializeCall(call),
  });

  respondJson(res, CreateBenchmarkCallResponse, serializeCall(call), 201);
});

// T-126: save every uncached call's audio to the server's disk while Vapi
// still has it (free -- only a download, no STT provider call). Cached
// calls are skipped, per-call failures are reported not thrown, and calls
// already past the 14-day window are named as expired instead of silently
// attempted.
router.post("/benchmark/calls/cache-audio", async (_req, res): Promise<void> => {
  const result = await rescueUncachedAudio();
  respondJson(res, CacheCorpusAudioResponse, result);
});

// T-51: one call by id. The list route above is the corpus (121 calls today,
// 1,000+ as verticals come on); nothing that wants one row should pull it.
// T-85: worst-first ordering for the Corpus table and the per-call list on
// Results. Registered before the /:callId routes so "disagreement" is never
// read as a call id.
router.get("/benchmark/calls/disagreement", async (req, res): Promise<void> => {
  const query = GetCallDisagreementQueryParams.safeParse(req.query);
  if (!query.success) {
    respondInvalid(res, query.error);
    return;
  }
  // A non-uuid bulkId would surface as a Postgres cast error (500); say
  // 400 instead.
  if (query.data.bulkId && !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(query.data.bulkId)) {
    res.status(400).json({ error: "bulkId must be a uuid" });
    return;
  }
  respondJson(res, GetCallDisagreementResponse, await callDisagreement(query.data.bulkId ?? null));
});

// M-18: the only check on file that the disagreement ranking tracks a human
// transcript. No parameters -- it is all-time over every labelled call, not
// per bulk: the labelled set is 2 calls today and slicing it further would
// leave nothing to measure.
router.get("/benchmark/proxy-agreement", async (_req, res): Promise<void> => {
  respondJson(res, GetProxyAgreementResponse, await proxyAgreement());
});

// T-87: which words keep splitting the providers, per bulk / assistant.
router.get("/benchmark/words-to-watch", async (req, res): Promise<void> => {
  const query = GetWordsToWatchQueryParams.safeParse(req.query);
  if (!query.success) {
    respondInvalid(res, query.error);
    return;
  }
  const { assistantId } = query.data;
  // T-92: no bulkId = all-time (every finished bulk, latest run per call).
  const bulkId = query.data.bulkId?.trim() ? query.data.bulkId : null;
  if (bulkId) {
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(bulkId)) {
      res.status(400).json({ error: "bulkId must be a uuid" });
      return;
    }
    const [bulk] = await db.select({ id: benchmarkBulksTable.id }).from(benchmarkBulksTable).where(eq(benchmarkBulksTable.id, bulkId)).limit(1);
    if (!bulk) {
      res.status(404).json({ error: "Bulk not found" });
      return;
    }
  }
  respondJson(res, GetWordsToWatchResponse, await wordsToWatch(bulkId, assistantId?.trim() ? assistantId : null));
});

// T-112 / T-113: judge confidence + human hard-case flags per assistant.
// Same scope rules as words-to-watch (one bulk, or all-time).
router.get("/benchmark/assistant-signals", async (req, res): Promise<void> => {
  const query = GetAssistantSignalsQueryParams.safeParse(req.query);
  if (!query.success) {
    respondInvalid(res, query.error);
    return;
  }
  const { assistantId } = query.data;
  const bulkId = query.data.bulkId?.trim() ? query.data.bulkId : null;
  if (bulkId) {
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(bulkId)) {
      res.status(400).json({ error: "bulkId must be a uuid" });
      return;
    }
    const [bulk] = await db.select({ id: benchmarkBulksTable.id }).from(benchmarkBulksTable).where(eq(benchmarkBulksTable.id, bulkId)).limit(1);
    if (!bulk) {
      res.status(404).json({ error: "Bulk not found" });
      return;
    }
  }
  respondJson(res, GetAssistantSignalsResponse, await assistantSignals(bulkId, assistantId?.trim() ? assistantId : null));
});

router.get("/benchmark/calls/:callId", async (req, res): Promise<void> => {
  const params = GetBenchmarkCallParams.safeParse(req.params);
  if (!params.success) {
    respondInvalid(res, params.error);
    return;
  }
  const [call] = await db
    .select()
    .from(benchmarkCallsTable)
    .where(eq(benchmarkCallsTable.id, params.data.callId))
    .limit(1);
  if (!call) {
    res.status(404).json({ error: "Call not found" });
    return;
  }
  respondJson(
    res,
    GetBenchmarkCallResponse,
    serializeCall(call, {
      cache: { audio: await isAudioCached(call.id), customerAudio: await isCustomerAudioCached(call.id) },
      benchmarked: (await listBenchmarkedCallIds([call.id])).has(call.id),
    }),
  );
});

// T-72 (E.4): one call, every provider's output under the reference.
// All the work is in lib/call-comparison.ts; two operations only because
// orval cannot express path + optional query params without a name clash.
router.get("/benchmark/calls/:callId/comparison", async (req, res): Promise<void> => {
  const params = GetCallComparisonParams.safeParse(req.params);
  if (!params.success) {
    respondInvalid(res, params.error);
    return;
  }
  const comparison = await callComparison(params.data.callId, null);
  if (!comparison) {
    res.status(404).json({ error: "Call not found" });
    return;
  }
  respondJson(res, GetCallComparisonResponse, comparison);
});

router.get("/benchmark/bulks/:bulkId/calls/:callId/comparison", async (req, res): Promise<void> => {
  const params = GetBulkCallComparisonParams.safeParse(req.params);
  if (!params.success) {
    respondInvalid(res, params.error);
    return;
  }
  const comparison = await callComparison(params.data.callId, params.data.bulkId);
  if (!comparison) {
    res.status(404).json({ error: "Call or bulk not found" });
    return;
  }
  respondJson(res, GetBulkCallComparisonResponse, comparison);
});

router.patch("/benchmark/calls/:callId", async (req, res): Promise<void> => {
  const params = UpdateBenchmarkCallParams.safeParse(req.params);
  const body = UpdateBenchmarkCallBody.safeParse(req.body);
  if (!params.success) {
    respondInvalid(res, params.error);
    return;
  }
  if (!body.success) {
    respondInvalid(res, body.error);
    return;
  }

  const existing = await db
    .select()
    .from(benchmarkCallsTable)
    .where(eq(benchmarkCallsTable.id, params.data.callId))
    .limit(1);

  if (!existing[0]) {
    res.status(404).json({ error: "Benchmark call not found" });
    return;
  }

  const current = existing[0];
  // 2026-08-27, per Abhishek's explicit decision: the de-identification gate
  // is removed entirely. Setting ready_to_run used to require two distinct
  // approvers (FR-C3); it now requires nothing. The attest-deid endpoint and
  // its columns remain so historical attestations stay readable, but nothing
  // depends on them.

  // R-21: the labelled set is one call, and until now `{"goldTranscript":""}`
  // was an ordinary accepted request that emptied it. Gate on the state the
  // request would leave behind, not on the literal sent -- "   " erases the
  // gold exactly as thoroughly as "" does. Replacing a gold with a different
  // real gold is untouched; only going to nothing needs saying out loud.
  const { confirmClearGold, ...fields } = body.data;
  if (
    fields.goldTranscript !== undefined &&
    (current.goldTranscript ?? "").trim() !== "" &&
    fields.goldTranscript.trim() === "" &&
    confirmClearGold !== true
  ) {
    res.status(409).json({
      error:
        "This call has a gold transcript, and this request would leave it empty. " +
        "Gold is hand-written and this route has no undo -- the old text survives only in audit_log. " +
        "Send confirmClearGold: true if that is what you mean.",
    });
    return;
  }

  const [call] = await db
    .update(benchmarkCallsTable)
    .set({
      ...fields,
      updatedAt: new Date(),
    })
    .where(eq(benchmarkCallsTable.id, params.data.callId))
    .returning();

  await writeAudit({
    entityType: "call",
    entityId: call.id,
    actorLabel: actorFromRequest(req),
    action: "update",
    beforeState: serializeCall(current),
    afterState: serializeCall(call),
  });

  respondJson(res, UpdateBenchmarkCallResponse, serializeCall(call));
});

router.post("/benchmark/calls/:callId/attest-deid", async (req, res): Promise<void> => {
  const params = AttestBenchmarkCallDeidParams.safeParse(req.params);
  const body = AttestBenchmarkCallDeidBody.safeParse(req.body);
  if (!params.success || !body.success) {
    respondInvalid(res, params.error, body.error);
    return;
  }

  const existing = await db
    .select()
    .from(benchmarkCallsTable)
    .where(eq(benchmarkCallsTable.id, params.data.callId))
    .limit(1);
  if (!existing[0]) {
    res.status(404).json({ error: "Benchmark call not found" });
    return;
  }
  const current = existing[0];
  const approver = trimmedApproverLabel(body.data.approverLabel);
  if (approver === null) {
    res.status(400).json({ error: BLANK_APPROVER_MESSAGE });
    return;
  }

  if (!current.deIdAttestedByLabel) {
    const [call] = await db
      .update(benchmarkCallsTable)
      .set({ deIdAttestedByLabel: approver, deIdAttestedAt: new Date() })
      .where(eq(benchmarkCallsTable.id, current.id))
      .returning();
    await writeAudit({
      entityType: "call",
      entityId: call.id,
      actorLabel: approver,
      action: "attest_deid_first",
      afterState: { deIdAttestedByLabel: approver },
    });
    respondJson(res, AttestBenchmarkCallDeidResponse, serializeCall(call));
    return;
  }

  // Case-fold both sides -- otherwise "Bob" then "bob" count as two
  // distinct approvers, defeating the two-distinct-person compliance gate
  // (found 2026-08-24 while auditing this route).
  if (current.deIdAttestedByLabel?.trim().toLowerCase() === approver.trim().toLowerCase()) {
    res.status(409).json({
      error: "The same approver cannot provide both de-identification attestations (FR-C3).",
    });
    return;
  }

  if (current.deIdSecondApproverLabel) {
    res.status(409).json({ error: "This call already has two de-identification approvals." });
    return;
  }

  const [call] = await db
    .update(benchmarkCallsTable)
    .set({ deIdSecondApproverLabel: approver, deIdSecondApprovedAt: new Date() })
    .where(eq(benchmarkCallsTable.id, current.id))
    .returning();
  await writeAudit({
    entityType: "call",
    entityId: call.id,
    actorLabel: approver,
    action: "attest_deid_second",
    afterState: { deIdSecondApproverLabel: approver },
  });
  respondJson(res, AttestBenchmarkCallDeidResponse, serializeCall(call));
});

// Vapi's own recording URLs are short-lived signed R2/Supabase links -- the
// one captured at import time is dead within hours, well before a curator
// gets to reviewing that call (or a run executes against it). Rather than
// store (and re-store) a URL that expires, this route re-asks Vapi for a
// fresh one on every request and redirects the player at it. The run
// executor uses the exact same resolveFreshRecordingUrl() -- see
// lib/run-executor.ts -- so playback and scoring can't drift onto two
// different notions of "the audio." Never cached, never persisted.
router.get("/benchmark/calls/:callId/audio", async (req, res): Promise<void> => {
  // T-146: this route and the run-archive one below were the two the
  // batch-15 fix could not reach -- it worked by adding `format: uuid` to
  // the spec, which only binds a handler that actually parses its params.
  // Both read req.params raw, so a malformed id went into a uuid column and
  // Postgres threw: `GET /benchmark/calls/not-a-uuid/audio` answered 500.
  const params = GetBenchmarkCallAudioParams.safeParse(req.params);
  if (!params.success) {
    respondInvalid(res, params.error);
    return;
  }
  const callId = params.data.callId;
  const [call] = await db
    .select()
    .from(benchmarkCallsTable)
    .where(eq(benchmarkCallsTable.id, callId))
    .limit(1);
  if (!call) {
    res.status(404).json({ error: "Benchmark call not found" });
    return;
  }

  // T-9 fix (2026-08-27, base-solidity review): FIX-2 moved the run
  // executor off Vapi's 14-day retention clock by caching audio bytes to
  // local disk (lib/audio-cache.ts) -- this playback route never moved
  // with it, so a call whose audio is sitting on disk, already
  // successfully transcribed, still couldn't be PLAYED once its source
  // recording crossed 14 days old -- exactly the call a reviewer most
  // needs to listen to when checking a flagged span. Serve cached bytes
  // first, with Range support so the <audio> element's scrubber works;
  // only fall through to the Vapi redirect below on a genuine cache miss.
  const cachePath = audioCachePathFor(callId);
  try {
    const stat = await fsStat(cachePath);
    res.setHeader("Accept-Ranges", "bytes");
    res.setHeader("Content-Type", "audio/wav");
    const range = req.headers.range;
    const match = typeof range === "string" ? /^bytes=(\d+)-(\d*)$/.exec(range) : null;
    if (match) {
      const start = Number.parseInt(match[1]!, 10);
      const end = match[2] ? Number.parseInt(match[2], 10) : stat.size - 1;
      if (!Number.isFinite(start) || !Number.isFinite(end) || start > end || end >= stat.size) {
        res.status(416).setHeader("Content-Range", `bytes */${stat.size}`).end();
        return;
      }
      res.status(206);
      res.setHeader("Content-Range", `bytes ${start}-${end}/${stat.size}`);
      res.setHeader("Content-Length", String(end - start + 1));
      createReadStream(cachePath, { start, end }).pipe(res);
    } else {
      res.setHeader("Content-Length", String(stat.size));
      createReadStream(cachePath).pipe(res);
    }
    return;
  } catch {
    // Not cached (or unreadable) -- fall through to the live Vapi redirect.
  }

  try {
    const freshUrl = await resolveFreshRecordingUrl(call);
    res.redirect(302, freshUrl);
  } catch (err) {
    if (err instanceof VapiNoRecordingError) {
      res.status(404).json({ error: err.message });
      return;
    }
    req.log.warn({ err, callId }, "Failed to refresh Vapi recording URL");
    respondVapiError(res, err);
  }
});

// --- Vapi call sourcing (COR-01) ------------------------------------------
//
// These three routes are the UI-driven replacement for the CLI importer:
// pick an account, pick a window, preview what's there, then import only the
// calls the operator ticked. Imported calls land `ready_to_run` -- the
// de-identification gate was removed 2026-08-27 per Abhishek's explicit
// decision, so nothing stands between import and a run. Vapi's own
// transcript still goes to draftTranscript, never treated as a reference,
// because scoring against the provider Vapi already chose would bias the
// benchmark it feeds (GOLD-01).

/** Maps a Vapi/network failure onto an HTTP status without leaking the key. */
router.get("/benchmark/vapi/accounts", async (_req, res): Promise<void> => {
  respondJson(res, ListVapiAccountsResponse, listVapiAccounts());
});

// 2026-08-26: bulk selection should pick real assistants directly instead
// of being divided by vertical. Across every configured account by
// default (assistant ids are globally unique) -- pass accountId to narrow
// to one.
router.get("/benchmark/vapi/assistants", async (req, res): Promise<void> => {
  const parsed = ListVapiAssistantsQueryParams.safeParse(req.query);
  if (!parsed.success) {
    respondInvalid(res, parsed.error);
    return;
  }
  try {
    const assistants = await fetchVapiAssistants(parsed.data.accountId);
    respondJson(res, ListVapiAssistantsResponse, assistants);
  } catch (err) {
    respondVapiError(res, err);
  }
});

// T-97: what the assistant is configured to run in production -- primary,
// fallback, boosted keyterms -- read live from Vapi (10-minute cache). The
// per-call `sourceTranscriber*` columns say what ran; this says what is
// set, including the parts the benchmark cannot reproduce.
router.get("/benchmark/assistants/:assistantId/transcriber", async (req, res): Promise<void> => {
  const params = GetAssistantTranscriberParams.safeParse(req.params);
  if (!params.success) {
    respondInvalid(res, params.error);
    return;
  }
  try {
    const found = await assistantTranscriberConfig(params.data.assistantId);
    if (found.kind === "no_calls") {
      res.status(404).json({ error: "No imported call carries this assistant id, so its Vapi account is unknown." });
      return;
    }
    if (found.kind === "no_account") {
      res.status(404).json({ error: `The calls for this assistant carry org label "${found.accountLabel ?? ""}", which matches no configured Vapi account.` });
      return;
    }
    respondJson(res, GetAssistantTranscriberResponse, found.config);
  } catch (err) {
    respondVapiError(res, err);
  }
});

router.post("/benchmark/vapi/preview", async (req, res): Promise<void> => {
  const parsed = PreviewVapiCallsBody.safeParse(req.body);
  if (!parsed.success) {
    respondInvalid(res, parsed.error);
    return;
  }
  try {
    respondJson(res, PreviewVapiCallsResponse, await previewVapiCalls(parsed.data));
  } catch (err) {
    if (err instanceof UnknownVapiAccountError) {
      res.status(400).json({ error: err.message });
      return;
    }
    // W-4: only a failure of the Vapi read itself answers here. A database
    // failure inside previewVapiCalls carries no tag and reaches the error
    // handler, exactly as it did when this was one long handler body.
    if (err instanceof VapiSourceError) {
      req.log.warn({ err: err.cause }, "Vapi preview failed");
      respondVapiError(res, err.cause);
      return;
    }
    throw err;
  }
});

router.post("/benchmark/vapi/import", async (req, res): Promise<void> => {
  const parsed = ImportVapiCallsBody.safeParse(req.body);
  if (!parsed.success) {
    respondInvalid(res, parsed.error);
    return;
  }
  try {
    const result = await importVapiCalls(parsed.data, actorFromRequest(req), req.log);
    respondJson(res, ImportVapiCallsResponse, result, 201);
  } catch (err) {
    if (err instanceof UnknownVapiAccountError) {
      res.status(400).json({ error: err.message });
      return;
    }
    if (err instanceof VapiSourceError) {
      respondVapiError(res, err.cause);
      return;
    }
    throw err;
  }
});

router.get("/benchmark/providers", async (_req, res): Promise<void> => {
  await ensureDefaultProviders();
  await syncProviderReadiness();
  const providers = await db
    .select()
    .from(benchmarkProvidersTable)
    .orderBy(benchmarkProvidersTable.name);

  respondJson(res, ListBenchmarkProvidersResponse, providers.map(serializeProvider));
});

/** R-28: the same slugging providerIdForModel applies to a model, used on the
 *  vendor half so "Deepgram" and "deepgram" name the same vendor. */
function slugForProviderId(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9.-]+/g, "-")
    .replace(/^-|-$/g, "");
}

router.post("/benchmark/providers", async (req, res): Promise<void> => {
  const parsed = CreateBenchmarkProviderBody.safeParse(req.body);
  if (!parsed.success) {
    respondInvalid(res, parsed.error);
    return;
  }

  // R-28 (ox-alpha B-17): the id used to be `<name>-<model>-<6 random hex>`.
  // Nothing resolves that. getProviderApiModel() strips the vendor prefix and
  // sends whatever remains as the model string, so a row created here asked
  // the vendor for "nova-3-a1b2c3" and every one of its cells failed -- while
  // the row itself looked perfectly ordinary in Setup, and there is no delete.
  //
  // The id is now the documented stable one, providerIdForModel(vendor,
  // apiModel), and the vendor half has to be a vendor this build actually
  // serves. That is what makes the derived model string exactly the model the
  // operator typed, instead of the model plus whatever else was in the name.
  const vendor = slugForProviderId(parsed.data.name);
  const knownVendors = [...new Set(listProviderAdapters().map(vendorOf))].sort();
  if (!knownVendors.includes(vendor)) {
    res.status(400).json({
      error:
        `Provider Name must be a vendor this build has an adapter for, not a full provider id. ` +
        `Got "${parsed.data.name}" (read as "${vendor}"). Known vendors: ${knownVendors.join(", ")}. ` +
        `The model goes in Model ID -- the two are joined to form the provider id.`,
    });
    return;
  }

  const id = providerIdForModel(vendor, parsed.data.model);
  const [existing] = await db
    .select({ id: benchmarkProvidersTable.id })
    .from(benchmarkProvidersTable)
    .where(eq(benchmarkProvidersTable.id, id))
    .limit(1);
  if (existing) {
    // The random suffix used to hide this: the same vendor and model could be
    // added over and over, each time as a separate row.
    res.status(409).json({
      error: `Provider "${id}" already exists. Edit that row instead of adding it again.`,
    });
    return;
  }

  const [provider] = await db
    .insert(benchmarkProvidersTable)
    .values({
      id,
      name: parsed.data.name,
      model: parsed.data.model,
      status: "not_configured",
      supportsStreaming: parsed.data.supportsStreaming ?? false,
      supportsDiarization: parsed.data.supportsDiarization ?? false,
      costPerMinute: parsed.data.costPerMinute,
      keywordBoosting: parsed.data.keywordBoosting ?? false,
      configNote: parsed.data.configNote,
    })
    .returning();

  await writeAudit({
    entityType: "provider",
    entityId: provider.id,
    actorLabel: actorFromRequest(req),
    action: "create",
    afterState: provider,
  });

  respondJson(res, CreateBenchmarkProviderResponse, serializeProvider(provider), 201);
});

// T-104 (2026-08-30, per Abhishek: "toggle for each STT provider ... the
// latest version ... so we don't need to keep it updated manually"). Per
// vendor: the models it offers today -- live from the vendor's API where one
// exists (Deepgram, OpenAI), else a list verified against its docs on a
// dated day -- and which of them already have a provider row here. The
// route never writes; enabling is the POST below, one row per model, so a
// newer model never silently replaces the results of the old one.
// T-119/T-128: the per-vendor 8 s budget and the 30-minute server-side
// cache both live in lib/model-list-cache.ts -- a slow vendor (Deepgram's
// /v1/models once took 51 s) neither hangs the page nor gets re-asked on
// every Overview and Setup visit.
router.get("/benchmark/providers/models", async (_req, res): Promise<void> => {
  const rows = await db.select({ id: benchmarkProvidersTable.id, status: benchmarkProvidersTable.status }).from(benchmarkProvidersTable);
  const rowById = new Map(rows.map((r) => [r.id, r.status]));
  const vendors = await Promise.all(
    listProviderAdapters()
      .filter((a) => typeof a.listModels === "function")
      .map(async (adapter) => {
        const vendor = vendorOf(adapter);
        const { models, error } = await cachedVendorModels(vendor, adapter.vendorLabel ?? vendor, () => adapter.listModels!());
        return {
          vendor,
          vendorLabel: adapter.vendorLabel ?? vendor,
          adapterId: adapter.providerId,
          apiKeyConfigured: Boolean(process.env[adapter.apiKeyEnvVar]?.trim()),
          source: models[0]?.source ?? null,
          error,
          models: models.map((m) => {
            const providerId = providerIdForModel(vendor, m.apiModel);
            // The adapter's own historical row is the vendor default model
            // for that vendor; it counts as enabled for whichever model the
            // catalog says it means (or the vendor default when unknown).
            const enabledAs = rowById.has(providerId)
              ? providerId
              : m.legacyDefault && rowById.has(adapter.providerId)
                ? adapter.providerId
                : null;
            return {
              apiModel: m.apiModel,
              label: m.label,
              latest: m.latest,
              source: m.source,
              verifiedAt: m.verifiedAt,
              note: m.note ?? null,
              // S-4: report the row that is actually enabled, not the id we
              // would have synthesised for it. When `enabledAs` took the
              // `legacyDefault` path above, the synthesised id names a row
              // that does not exist -- three of them in the live response
              // (assemblyai-universal-3-5-pro, elevenlabs-scribe-v2,
              // gladia-solaria-1, all pointing at rows called
              // assemblyai-universal, elevenlabs-scribe, gladia-solaria).
              // When the model is NOT enabled the synthesised id is right:
              // it is the id the enable call will create.
              providerId: enabledAs ?? providerId,
              enabled: enabledAs !== null,
              rowStatus: enabledAs ? (rowById.get(enabledAs) ?? null) : null,
            };
          }),
        };
      }),
  );
  respondJson(res, ListProviderModelsResponse, { vendors, fetchedAt: new Date().toISOString() });
});

// T-104: one click on "Enable <newest model>". Creates the provider row for
// (vendor, apiModel) if it does not exist -- copying price and capability
// flags from the vendor's existing row so the estimate is not zero -- and
// returns it either way. Runs only when a bulk picks it, like any provider.
router.post("/benchmark/providers/models/enable", async (req, res): Promise<void> => {
  const parsed = EnableProviderModelBody.safeParse(req.body);
  if (!parsed.success) {
    respondInvalid(res, parsed.error);
    return;
  }
  const adapter = listProviderAdapters().find((a) => vendorOf(a) === parsed.data.vendor);
  if (!adapter || typeof adapter.listModels !== "function") {
    res.status(404).json({ error: `No vendor "${parsed.data.vendor}" with a model list.` });
    return;
  }
  let option: ProviderModelOption | undefined;
  try {
    option = (await adapter.listModels()).find((m) => m.apiModel === parsed.data.apiModel);
  } catch (err) {
    res.status(502).json({ error: err instanceof Error ? err.message : "Vendor model list unavailable." });
    return;
  }
  if (!option) {
    res.status(404).json({ error: `${adapter.vendorLabel ?? parsed.data.vendor} does not list a model "${parsed.data.apiModel}" today.` });
    return;
  }
  const id = providerIdForModel(parsed.data.vendor, option.apiModel);
  const [existing] = await db.select().from(benchmarkProvidersTable).where(eq(benchmarkProvidersTable.id, id)).limit(1);
  if (existing) {
    respondJson(res, EnableProviderModelResponse, { created: false, provider: serializeProvider(existing) });
    return;
  }
  const [sibling] = await db
    .select()
    .from(benchmarkProvidersTable)
    .where(eq(benchmarkProvidersTable.id, adapter.providerId))
    .limit(1);
  const [created] = await db
    .insert(benchmarkProvidersTable)
    .values({
      id,
      name: sibling?.name ?? adapter.vendorLabel ?? parsed.data.vendor,
      model: option.label,
      status: "not_configured",
      supportsStreaming: sibling?.supportsStreaming ?? false,
      supportsDiarization: sibling?.supportsDiarization ?? false,
      costPerMinute: sibling?.costPerMinute ?? 0,
      keywordBoosting: sibling?.keywordBoosting ?? false,
      configNote: sibling
        ? `T-104: price and capability flags copied from ${sibling.id} on enable -- verify the price for ${option.apiModel}.`
        : `T-104: enabled from the vendor model list; no price on file yet.`,
    })
    .returning();
  await syncProviderReadiness();
  const [refreshed] = await db.select().from(benchmarkProvidersTable).where(eq(benchmarkProvidersTable.id, id)).limit(1);
  await writeAudit({
    entityType: "provider",
    entityId: id,
    actorLabel: actorFromRequest(req),
    action: "create",
    afterState: refreshed ?? created,
  });
  respondJson(res, EnableProviderModelResponse, { created: true, provider: serializeProvider(refreshed ?? created!) }, 201);
});

router.patch("/benchmark/providers/:providerId", async (req, res): Promise<void> => {
  const params = UpdateBenchmarkProviderParams.safeParse(req.params);
  const body = UpdateBenchmarkProviderBody.safeParse(req.body);
  if (!params.success || !body.success) {
    respondInvalid(res, params.error, body.error);
    return;
  }

  const existing = await db
    .select()
    .from(benchmarkProvidersTable)
    .where(eq(benchmarkProvidersTable.id, params.data.providerId))
    .limit(1);
  if (!existing[0]) {
    res.status(404).json({ error: "Provider not found" });
    return;
  }

  const [provider] = await db
    .update(benchmarkProvidersTable)
    .set({
      manuallyDisabled: body.data.disabled ?? existing[0].manuallyDisabled,
      costPerMinute: body.data.costPerMinute ?? existing[0].costPerMinute,
      configNote: body.data.configNote ?? existing[0].configNote,
      updatedAt: new Date(),
    })
    .where(eq(benchmarkProvidersTable.id, params.data.providerId))
    .returning();

  await syncProviderReadiness();
  const [refreshed] = await db
    .select()
    .from(benchmarkProvidersTable)
    .where(eq(benchmarkProvidersTable.id, params.data.providerId))
    .limit(1);

  await writeAudit({
    entityType: "provider",
    entityId: provider.id,
    actorLabel: actorFromRequest(req),
    action: "update",
    beforeState: serializeProvider(existing[0]),
    afterState: serializeProvider(refreshed ?? provider),
  });

  respondJson(res, UpdateBenchmarkProviderResponse, serializeProvider(refreshed ?? provider));
});

// 2026-08-26, per Abhishek: a system-wide, changeable choice of (a) which
// provider real production calls actually use (separate from which
// providers a bulk run benchmarks) and (b) which OpenAI model powers the
// transcript-quality agent's judge pass. Single settings row -- see the
// schema comment on appSettingsTable for why "default"/single-row is fine
// today (no multi-tenant auth yet, OD-11).
async function getOrCreateSettings() {
  const [existing] = await db
    .select()
    .from(appSettingsTable)
    .where(eq(appSettingsTable.id, APP_SETTINGS_ID))
    .limit(1);
  if (existing) return existing;
  const [created] = await db
    .insert(appSettingsTable)
    .values({ id: APP_SETTINGS_ID })
    .onConflictDoNothing()
    .returning();
  if (created) return created;
  // Lost an insert race -- read again.
  const [row] = await db
    .select()
    .from(appSettingsTable)
    .where(eq(appSettingsTable.id, APP_SETTINGS_ID))
    .limit(1);
  return row!;
}

// T-103: judge models, live from OpenAI, pinned five first. When OpenAI
// cannot be reached the pinned list still comes back (live: false) so the
// Setup page never loses its choices.
router.get("/benchmark/agent-models", async (_req, res): Promise<void> => {
  const priced = new Set(pricedAgentModels());
  let ids: string[] = [];
  let fetchedAt: string | null = null;
  let live = true;
  let error: string | null = null;
  try {
    const got = await listOpenAiJudgeModels();
    ids = got.ids;
    fetchedAt = got.fetchedAt;
  } catch (err) {
    live = false;
    error = err instanceof OpenAiModelsError ? err.message : "OpenAI model list unavailable.";
  }
  const pinned = PINNED_AGENT_MODELS.map((id) => ({ id, priced: priced.has(id), available: live ? ids.includes(id) : null }));
  const others = ids.filter((id) => !(PINNED_AGENT_MODELS as readonly string[]).includes(id)).map((id) => ({ id, priced: priced.has(id), available: true }));
  respondJson(res, ListAgentModelsResponse, { defaultModel: JUDGE_MODEL, pinned, others, live, fetchedAt, error });
});

router.get("/benchmark/settings", async (_req, res): Promise<void> => {
  const settings = await getOrCreateSettings();
  respondJson(
    res,
    GetAppSettingsResponse,
    {
      activeProviderId: settings.activeProviderId,
      agentModel: settings.agentModel,
    },
  );
});

router.patch("/benchmark/settings", async (req, res): Promise<void> => {
  const parsed = UpdateAppSettingsBody.safeParse(req.body);
  if (!parsed.success) {
    respondInvalid(res, parsed.error);
    return;
  }
  // T-151: a PATCH that sets nothing used to reach drizzle's `.set({})` and
  // throw, so `{}` -- or a body whose only field is a typo, since zod strips
  // unknown keys -- answered 500. Reproduced live on `{"judgeModel":123}`:
  // the field does not exist, nothing was left to set, and the caller was
  // told the server had failed rather than that they had.
  if (parsed.data.activeProviderId === undefined && parsed.data.agentModel === undefined) {
    res.status(400).json({
      error: "Name at least one setting to change: activeProviderId or agentModel.",
    });
    return;
  }

  if (parsed.data.activeProviderId) {
    const [provider] = await db
      .select({ id: benchmarkProvidersTable.id })
      .from(benchmarkProvidersTable)
      .where(eq(benchmarkProvidersTable.id, parsed.data.activeProviderId))
      .limit(1);
    if (!provider) {
      res.status(400).json({ error: `Unknown provider id "${parsed.data.activeProviderId}".` });
      return;
    }
  }

  await getOrCreateSettings(); // ensure the row exists before updating it
  const [updated] = await db
    .update(appSettingsTable)
    .set({
      ...(parsed.data.activeProviderId !== undefined
        ? { activeProviderId: parsed.data.activeProviderId }
        : {}),
      ...(parsed.data.agentModel !== undefined
        ? { agentModel: parsed.data.agentModel || null }
        : {}),
    })
    .where(eq(appSettingsTable.id, APP_SETTINGS_ID))
    .returning();

  await writeAudit({
    entityType: "app_settings",
    entityId: APP_SETTINGS_ID,
    actorLabel: actorFromRequest(req),
    action: "update",
    afterState: { activeProviderId: updated.activeProviderId, agentModel: updated.agentModel },
  });

  respondJson(
    res,
    UpdateAppSettingsResponse,
    {
      activeProviderId: updated.activeProviderId,
      agentModel: updated.agentModel,
    },
  );
});

router.get("/benchmark/runs", async (_req, res): Promise<void> => {
  // "batch" only -- the transcript-quality agent (routes/agent.ts) spawns
  // its own single-call runs through this same executor, purpose
  // "agent_scan". Those belong in the Agent view, not mixed into this list.
  // Left-joined to bulks so shard runs carry the bulk's display name
  // (FR-BLK-13), not just an opaque FK.
  const runs = await db
    .select({ run: benchmarkRunsTable, bulkName: benchmarkBulksTable.name })
    .from(benchmarkRunsTable)
    .leftJoin(
      benchmarkBulksTable,
      eq(benchmarkBulksTable.id, benchmarkRunsTable.bulkId),
    )
    .where(eq(benchmarkRunsTable.purpose, "batch"))
    .orderBy(desc(benchmarkRunsTable.createdAt));
  respondJson(
    res,
    ListBenchmarkRunsResponse,
      runs.map(({ run, bulkName }) => serializeRun(run, bulkName ?? null)),
  );
});

router.post("/benchmark/runs", async (req, res): Promise<void> => {
  const parsed = CreateBenchmarkRunBody.safeParse(req.body);
  if (!parsed.success) {
    respondInvalid(res, parsed.error);
    return;
  }

  const [calls, providers] = await Promise.all([
    db.select().from(benchmarkCallsTable),
    db.select().from(benchmarkProvidersTable),
  ]);
  const selectedCalls = calls.filter((call) =>
    parsed.data.callIds.includes(call.id),
  );
  const selectedProviders = providers.filter((provider) =>
    parsed.data.providerIds.includes(provider.id),
  );
  const blockers: string[] = [];

  if (selectedCalls.length !== parsed.data.callIds.length) {
    blockers.push("one or more calls do not exist");
  }
  if (selectedProviders.length !== parsed.data.providerIds.length) {
    blockers.push("one or more providers do not exist");
  }
  if (selectedProviders.some((provider) => provider.status !== "ready")) {
    blockers.push("provider credentials and models must be configured");
  }

  const notes = [parsed.data.notes, ...blockers.map((item) => `Blocked: ${item}`)]
    .filter(Boolean)
    .join("\n");
  // RUN-01/P2-T1: freeze the immutable manifest at creation, even for a
  // blocked run -- it records what the run WOULD have executed against.
  const manifest = await buildRunManifest(
    parsed.data.callIds,
    parsed.data.providerIds,
  );
  const [run] = await db
    .insert(benchmarkRunsTable)
    .values({
      status: blockers.length > 0 ? "blocked" : "queued",
      providerIds: parsed.data.providerIds,
      callIds: parsed.data.callIds,
      callCount: parsed.data.callIds.length,
      notes: notes || null,
      manifest,
    })
    .returning();

  const actorLabel = actorFromRequest(req);
  await writeAudit({
    entityType: "run",
    entityId: run.id,
    actorLabel,
    action: "create",
    afterState: serializeRun(run),
  });

  if (blockers.length === 0) {
    // Fire-and-forget: this is a single-process executor, not a durable job
    // queue. Acceptable for the MVP corpus size (AC-MVP: 10-15 calls); a
    // real queue (BullMQ/etc) is a Phase-2 hardening item once this proves
    // out (see docs/execution-plan.md Phase 2).
    void executeBenchmarkRun(run.id, actorLabel).catch((err) => {
      req.log.error({ err, runId: run.id }, "Benchmark run execution crashed");
    });
  }

  respondJson(res, CreateBenchmarkRunResponse, serializeRun(run), 201);
});

router.post("/benchmark/runs/:runId/execute", async (req, res): Promise<void> => {
  const params = ExecuteBenchmarkRunParams.safeParse(req.params);
  if (!params.success) {
    respondInvalid(res, params.error);
    return;
  }

  const existing = await db
    .select()
    .from(benchmarkRunsTable)
    .where(eq(benchmarkRunsTable.id, params.data.runId))
    .limit(1);
  if (!existing[0]) {
    res.status(404).json({ error: "Run not found" });
    return;
  }

  const actorLabel = actorFromRequest(req);
  void executeBenchmarkRun(params.data.runId, actorLabel).catch((err) => {
    req.log.error({ err, runId: params.data.runId }, "Benchmark run execution crashed");
  });

  respondJson(res, ExecuteBenchmarkRunResponse, serializeRun(existing[0]), 202);
});

// RUN-01/P2-T1: export the frozen manifest exactly as stored at creation.
// 404 both when the run doesn't exist and when it predates manifests --
// fabricating one now would defeat the point of an immutable snapshot.
router.get("/benchmark/runs/:runId/manifest", async (req, res): Promise<void> => {
  const params = GetBenchmarkRunManifestParams.safeParse(req.params);
  if (!params.success) {
    respondInvalid(res, params.error);
    return;
  }
  const [run] = await db
    .select()
    .from(benchmarkRunsTable)
    .where(eq(benchmarkRunsTable.id, params.data.runId))
    .limit(1);
  if (!run || !run.manifest) {
    res.status(404).json({ error: "Run not found or predates manifests" });
    return;
  }
  respondJson(
    res,
    GetBenchmarkRunManifestResponse,
    // The manifest is jsonb, so its createdAt survives as the ISO string it
    // was written as -- rehydrated to a Date for the contract's coerce.date.
    { ...run.manifest, createdAt: new Date(run.manifest.createdAt), runId: run.id },
  );
});

// T-134: soft archive for ad-hoc runs. Nothing is deleted -- results,
// scores and audit rows all stay -- the run just leaves the default list
// and the "latest snapshot" picks. Guarded to bulkId null: a bulk's shard
// runs live and die with their bulk (FR-BLK-10), and archiving one shard
// would silently unbalance the bulk's own numbers.
router.post("/benchmark/runs/:runId/archive", async (req, res): Promise<void> => {
  const params = SetRunArchivedParams.safeParse(req.params);
  if (!params.success) {
    respondInvalid(res, params.error);
    return;
  }
  const parsed = SetRunArchivedBody.safeParse(req.body);
  if (!parsed.success) {
    respondInvalid(res, parsed.error);
    return;
  }
  const [run] = await db
    .select()
    .from(benchmarkRunsTable)
    .where(eq(benchmarkRunsTable.id, params.data.runId));
  if (!run) {
    res.status(404).json({ error: "Run not found" });
    return;
  }
  if (run.bulkId !== null) {
    res.status(409).json({ error: "This run belongs to a bulk -- manage it through the bulk, not here." });
    return;
  }
  const archivedAt = parsed.data.archived ? new Date() : null;
  const [updated] = await db
    .update(benchmarkRunsTable)
    .set({ archivedAt })
    .where(eq(benchmarkRunsTable.id, run.id))
    .returning();
  await writeAudit({
    entityType: "run",
    entityId: run.id,
    actorLabel: actorFromRequest(req),
    action: parsed.data.archived ? "archive" : "unarchive",
    beforeState: { archivedAt: run.archivedAt?.toISOString() ?? null },
    afterState: { archivedAt: updated!.archivedAt?.toISOString() ?? null },
  });
  respondJson(res, SetRunArchivedResponse, serializeRun(updated!));
});

router.get("/benchmark/runs/:runId/results", async (req, res): Promise<void> => {
  const params = ListBenchmarkRunResultsParams.safeParse(req.params);
  if (!params.success) {
    respondInvalid(res, params.error);
    return;
  }

  // R-38 (ox-alpha B-79): without this, an unknown runId answered 200 with an
  // empty array -- byte-for-byte what a real run that has not produced a cell
  // yet returns. A caller polling a mistyped or deleted id waits forever on a
  // response that says "not yet" when the truth is "never". The manifest route
  // beside this one has always 404'd; these two now agree.
  const [run] = await db
    .select({ id: benchmarkRunsTable.id })
    .from(benchmarkRunsTable)
    .where(eq(benchmarkRunsTable.id, params.data.runId))
    .limit(1);
  if (!run) {
    res.status(404).json({ error: "Run not found" });
    return;
  }

  const rows = await db
    .select({ result: benchmarkProviderCallResultsTable, score: benchmarkScoresTable })
    .from(benchmarkProviderCallResultsTable)
    .leftJoin(
      benchmarkScoresTable,
      eq(benchmarkScoresTable.resultId, benchmarkProviderCallResultsTable.id),
    )
    .where(eq(benchmarkProviderCallResultsTable.runId, params.data.runId))
    .orderBy(desc(benchmarkProviderCallResultsTable.createdAt));

  type RunResultRow = ZodInput<typeof ListBenchmarkRunResultsResponse>[number];
  respondJson(
    res,
    ListBenchmarkRunResultsResponse,
      rows.map(({ result, score }) => {
        // 2026-08-27 (technical-fixes FIX-5/UX-7): a known, deterministic
        // failure cause (Vapi's retention window, the Supabase archive-bucket
        // 403) is surfaced here for free, with no click and no stored
        // failureDiagnosis needed. T-41: looked up from the stored
        // failureClass (the error sentence is only consulted for rows that
        // predate classification). An operator's own "AI analysis" click
        // (which DOES persist to failureDiagnosis) always takes priority
        // once it exists.
        const known = result.status === "failed" ? matchKnownFailure(result) : null;
        return {
        id: result.id,
        runId: result.runId,
        providerId: result.providerId,
        callId: result.callId,
        // Unconstrained text column; value held by the runtime parse.
        status: result.status as RunResultRow["status"],
        submittedAt: result.submittedAt,
        finalAt: result.finalAt,
        httpStatus: result.httpStatus,
        hypothesisTranscript: result.hypothesisTranscript,
        errorMessage: result.errorMessage,
        // T-06: the stored class, verbatim -- the machine-readable cause,
        // set where the failure happened. T-41: `known` above is derived
        // FROM it (one cause of record), never the other way round.
        failureClass: result.failureClass,
        failureDiagnosis: result.failureDiagnosis ?? known?.diagnosis ?? null,
        failureSuggestedFix: result.failureSuggestedFix ?? known?.suggestedFix ?? null,
        // T-73: one judgement (isRetryableFailureClass) shared with the
        // executor and the bulk failure groups; null when there is no
        // class to judge from.
        retryable: cellRetryable(result.status, result.failureClass),
        // M-5: which channel this number was measured on, so a reader never
        // has to assume. Null on a cell that transcribed nothing, and on
        // rows written before the column existed (those are mono).
        audioSource: result.audioSource,
        rawOutputHash: result.rawOutputHash,
        createdAt: result.createdAt,
        score: score
          ? {
              scoringVersion: score.scoringVersion,
              wer: score.wer,
              entityAccuracy: score.entityAccuracy,
              alphanumericAccuracy: score.alphanumericAccuracy,
              latencyFinalMs: score.latencyFinalMs,
              costPerMinute: score.costPerMinute,
              diarizationScore: score.diarizationScore,
              wordDiff:
                // The jsonb detail was written from scoring's WordDiffOp,
                // whose op is exactly this union; the runtime parse re-checks.
                (score.detail as { wordDiff?: unknown } | null)?.wordDiff as
                  | Array<{ op: "ok" | "sub" | "del" | "ins"; ref: string | null; hyp: string | null }>
                  | undefined,
              // 2026-08-27: gold-free hybrid flagging (computeHybridFlagsForRun
              // writes flagCount/flagSeverity directly onto this row, and the
              // structured breakdown into detail.hybridFlags -- both were
              // missing from this serialization until now, so the UI never
              // actually saw them despite the pass computing them correctly).
              flagCount: score.flagCount,
              // Unconstrained text column; value held by the runtime parse.
              flagSeverity: score.flagSeverity as NonNullable<RunResultRow["score"]>["flagSeverity"],
              // jsonb written by computeHybridFlagsForRun in this same shape; the
              // runtime parse re-checks it on the way out.
              hybridFlags: (score.detail as { hybridFlags?: unknown } | null)?.hybridFlags as NonNullable<RunResultRow["score"]>["hybridFlags"],
            }
          : null,
        };
      }),
  );
});

// 2026-08-26, per Abhishek: a lot of cells were failing and the raw
// errorMessage alone wasn't enough to act on. On-demand, per cell -- an
// OpenAI call, real cost, so it never runs automatically over every
// failure in a run.
router.post("/benchmark/results/:resultId/analyze-failure", async (req, res): Promise<void> => {
  const params = AnalyzeResultFailureParams.safeParse(req.params);
  if (!params.success) {
    respondInvalid(res, params.error);
    return;
  }

  const [row] = await db
    .select({ result: benchmarkProviderCallResultsTable, provider: benchmarkProvidersTable })
    .from(benchmarkProviderCallResultsTable)
    .innerJoin(
      benchmarkProvidersTable,
      eq(benchmarkProvidersTable.id, benchmarkProviderCallResultsTable.providerId),
    )
    .where(eq(benchmarkProviderCallResultsTable.id, params.data.resultId))
    .limit(1);
  if (!row) {
    res.status(404).json({ error: "Result not found" });
    return;
  }
  if (row.result.status !== "failed") {
    res.status(409).json({ error: `This cell is "${row.result.status}", not failed -- nothing to analyze.` });
    return;
  }
  if (!row.result.errorMessage) {
    res.status(409).json({ error: "This failed cell has no error message to analyze." });
    return;
  }

  let analysis: { diagnosis: string; suggestedFix: string };
  try {
    analysis = await analyzeFailure({
      providerName: row.provider.name,
      errorMessage: row.result.errorMessage,
      httpStatus: row.result.httpStatus,
      failureClass: row.result.failureClass,
    });
  } catch (err) {
    if (err instanceof AgentConfigError) {
      res.status(400).json({ error: err.message });
      return;
    }
    if (err instanceof AgentRequestError) {
      res.status(502).json({ error: err.message });
      return;
    }
    throw err;
  }

  const [updated] = await db
    .update(benchmarkProviderCallResultsTable)
    .set({ failureDiagnosis: analysis.diagnosis, failureSuggestedFix: analysis.suggestedFix })
    .where(eq(benchmarkProviderCallResultsTable.id, row.result.id))
    .returning();

  await writeAudit({
    entityType: "result",
    entityId: updated.id,
    actorLabel: actorFromRequest(req),
    action: "analyze_failure",
    afterState: analysis,
  });

  respondJson(
    res,
    AnalyzeResultFailureResponse,
    {
      resultId: updated.id,
      // The values this handler just wrote -- non-null by construction,
      // where the read-back columns are nullable by type.
      diagnosis: analysis.diagnosis,
      suggestedFix: analysis.suggestedFix,
    },
  );
});

router.get("/benchmark/audit-log", async (req, res): Promise<void> => {
  const parsed = ListAuditLogQueryParams.safeParse(req.query);
  if (!parsed.success) {
    respondInvalid(res, parsed.error);
    return;
  }

  const conditions = [
    parsed.data.entityType ? eq(auditLogTable.entityType, parsed.data.entityType) : undefined,
    parsed.data.entityId ? eq(auditLogTable.entityId, parsed.data.entityId) : undefined,
  ].filter((c) => c !== undefined);

  const rows =
    conditions.length > 0
      ? await db
          .select()
          .from(auditLogTable)
          .where(and(...conditions))
          .orderBy(desc(auditLogTable.occurredAt))
      : await db.select().from(auditLogTable).orderBy(desc(auditLogTable.occurredAt));

  respondJson(
    res,
    ListAuditLogResponse,
      rows.map((row) => ({
        id: row.id,
        entityType: row.entityType,
        entityId: row.entityId,
        actorLabel: row.actorLabel,
        action: row.action,
        beforeState: row.beforeState,
        afterState: row.afterState,
        occurredAt: row.occurredAt,
      })),
  );
});

router.get("/benchmark/rankings", async (req, res): Promise<void> => {
  const parsedQuery = ListBenchmarkRankingsQueryParams.safeParse(req.query);
  if (!parsedQuery.success) {
    respondInvalid(res, parsedQuery.error);
    return;
  }
  const bulkId = parsedQuery.data.bulkId;

  // computeRankingsForRun/computeRankingsForBulk (run-executor.ts) each
  // insert a fresh snapshot on every recompute and never delete older ones,
  // so this table accumulates every past snapshot forever. Previously
  // returned all of them unfiltered -- a reviewer would see the same group/
  // provider pair listed 2+ times with different numbers, no way to tell
  // which was current (found 2026-08-24). Each group can have its own
  // "latest snapshot that scored it" (not every recompute necessarily
  // covers every group), so pick that per group rather than assuming one
  // global latest. T-1 (2026-08-27): a bulk-scoped snapshot's rows all
  // share one representative runId (the bulk's most-recently-created shard
  // run -- see computeRankingsForBulk), so this join/pick-latest logic
  // needed no change to keep working correctly across the bulk-scope fix.
  // "batch" only -- the agent's single-call scoped runs (purpose
  // "agent_scan", see routes/agent.ts) compute rankings too since they
  // reuse the same executor, but a 1-call snapshot has no place deciding
  // the group's "latest" ranking.
  //
  // 2026-08-27, per Abhishek: grouped by real Vapi assistant instead of
  // vertical now (same reasoning as the Bulks picker). Grouping key is
  // assistantId (null bucketed as "Other"); assistantLabel is resolved
  // here, at read time, from a live Vapi lookup -- not stored on the
  // ranking row -- so a renamed assistant shows its current name
  // immediately instead of a name frozen at whichever run last scored it.
  // 2026-08-27, per Abhishek ("for each run then it should show the
  // ranking for each, and for bulk overall ranking for all the calls"):
  // bulkId scopes strictly to that one bulk's own snapshot -- every row
  // computeRankingsForBulk wrote for it, no "latest per group" picking
  // needed since a bulk has exactly one live snapshot (delete-then-insert
  // on every recompute). Omitting bulkId keeps the original all-time
  // behavior unchanged: newest snapshot per assistant group, across every
  // batch run ever.
  let latest: { ranking: typeof benchmarkRankingsTable.$inferSelect }[];
  if (bulkId) {
    latest = await db
      .select({ ranking: benchmarkRankingsTable })
      .from(benchmarkRankingsTable)
      .where(eq(benchmarkRankingsTable.bulkId, bulkId))
      .orderBy(benchmarkRankingsTable.rank);
  } else {
    const rankings = await db
      .select({ ranking: benchmarkRankingsTable, runCreatedAt: benchmarkRunsTable.createdAt })
      .from(benchmarkRankingsTable)
      .innerJoin(
        benchmarkRunsTable,
        and(
          eq(benchmarkRunsTable.id, benchmarkRankingsTable.runId),
          eq(benchmarkRunsTable.purpose, "batch"),
          // T-134: an archived run's snapshot must not be any group's
          // "latest" -- archiving a bad test run is exactly how a wrong
          // number is retired from Results.
          isNull(benchmarkRunsTable.archivedAt),
        ),
      )
      .orderBy(benchmarkRankingsTable.rank);

    const groupKeyOf = (assistantId: string | null): string => assistantId ?? "__other__";
    const latestRunIdByGroup = new Map<string, { runId: string; createdAt: Date }>();
    for (const { ranking, runCreatedAt } of rankings) {
      const key = groupKeyOf(ranking.assistantId);
      const current = latestRunIdByGroup.get(key);
      if (!current || runCreatedAt > current.createdAt) {
        latestRunIdByGroup.set(key, { runId: ranking.runId ?? "", createdAt: runCreatedAt });
      }
    }

    latest = rankings.filter(
      ({ ranking }) => latestRunIdByGroup.get(groupKeyOf(ranking.assistantId))?.runId === ranking.runId,
    );
  }

  let assistantNameById = new Map<string, string>();
  try {
    const assistants = await fetchVapiAssistants();
    assistantNameById = new Map(assistants.map((a) => [a.id, a.name]));
  } catch (err) {
    // Vapi being briefly unreachable shouldn't take Rankings down -- fall
    // back to the raw id as the label rather than 500ing the whole page.
    logger.warn({ err }, "Could not resolve assistant names for Rankings -- falling back to raw ids");
  }

  respondJson(
    res,
    ListBenchmarkRankingsResponse,
      latest.map(({ ranking }) => ({
        // The column is nullable but the data never is: the all-time branch
        // inner-joins runs on this id, and the bulk snapshot always records
        // the run that wrote it (verified live: 0 of 378 rows null). The
        // parse would still refuse a null loudly.
        runId: ranking.runId as string,
        // Unconstrained text column; value held by the runtime parse.
        vertical: ranking.vertical as ZodInput<typeof ListBenchmarkRankingsResponse>[number]["vertical"],
        assistantId: ranking.assistantId,
        assistantLabel: ranking.assistantId
          ? (assistantNameById.get(ranking.assistantId) ?? ranking.assistantId)
          // 2026-08-27, per Abhishek ("what's this Other (no assistant on
          // file)"): say why, not just that -- these are calls imported
          // without a Vapi assistant id captured at all (e.g. manually
          // added via Add Call), not an error or a dropped assistant.
          : "Unassigned (no assistant ID captured at import)",
        providerId: ranking.providerId,
        providerName: ranking.providerName,
        rank: ranking.rank,
        score: {
          wer: ranking.wer,
          entityAccuracy: ranking.entityAccuracy,
          alphanumericAccuracy: ranking.alphanumericAccuracy,
          latencyFirstPartialMs: ranking.latencyFirstPartialMs,
          latencyFinalMs: ranking.latencyFinalMs,
          // M-10e. A ranking row written before this column existed has
          // null here, the same as a batch adapter does -- both mean "no
          // number", which is exactly what the column renders. There is no
          // backfill: rawOutput never kept the per-chunk send timestamps
          // the measurement is derived from (O-35).
          latencyEndOfAudioMs: ranking.latencyEndOfAudioMs,
          costPerMinute: ranking.costPerMinute,
          diarizationScore: ranking.diarizationScore,
          // 2026-08-27: gold-free hybrid flagging -- computeRankingsForRun
          // already writes these onto the ranking row, this route just
          // hadn't been serializing them into the response yet.
          avgFlagCount: ranking.avgFlagCount,
          avgFlagSeverityScore: ranking.avgFlagSeverityScore,
          // 2026-08-27, found live ("for this call why its different
          // then?" -- Rank contradicted avgFlagCount because Rank is
          // actually computed from THESE two fields, which weren't being
          // sent to the client at all): the confidence-excluded numbers
          // the composite score (run-executor.ts's aggregateRankingRows)
          // actually sorts by.
          avgPeerFlagCount: ranking.avgPeerFlagCount,
          avgPeerFlagSeverityScore: ranking.avgPeerFlagSeverityScore,
          // T-19
          peerFlagsPer100Words: ranking.peerFlagsPer100Words,
          cleanCallRate: ranking.cleanCallRate,
        },
        recommendation: ranking.recommendation,
      })),
  );
});

router.get("/benchmark/plan", (_req, res): void => {
  respondJson(res, GetBenchmarkPlanResponse, benchmarkPlan);
});

export default router;
