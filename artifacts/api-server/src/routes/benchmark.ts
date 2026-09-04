import { and, desc, eq, inArray, isNull, or } from "drizzle-orm";
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
  type BenchmarkCallRow,
  type BenchmarkRunRow,
} from "@workspace/db";
import { getProviderAdapter, listProviderAdapters, providerIdForModel, vendorOf, type ProviderModelOption } from "@workspace/stt-providers";
import { latestFinishedBulk, monthSpend, needsHuman, runningBulk } from "../lib/overview";
import { wordsToWatch } from "../lib/words-to-watch";
import { assistantSignals } from "../lib/assistant-signals";
import { assistantTranscriberConfig } from "../lib/assistant-transcriber";
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
import { benchmarkPlan } from "../lib/benchmark-plan";
import { buildRunManifest } from "../lib/manifest";

// How many Vapi calls the import route re-fetches/inserts concurrently.
// Vapi's API tolerates modest parallelism; 4 keeps a 100-call backfill at
// ~25 round trips instead of 100 without risking 429 storms. Clamped like
// the executor knobs (threshold review 2026-08-25) -- a typo of 400 here
// would hammer Vapi from every import click.
const VAPI_IMPORT_CONCURRENCY = (() => {
  const raw = process.env.VAPI_IMPORT_CONCURRENCY;
  const parsed = raw ? Number.parseInt(raw, 10) : NaN;
  if (!Number.isFinite(parsed) || parsed <= 0) return 4;
  return Math.min(parsed, 16);
})();

import {
  draftTranscriptOf,
  durationSecondsOf,
  successEvaluationOf,
  fetchVapiAssistants,
  fetchVapiCall,
  fetchVapiCalls,
  listVapiAccounts,
  recordingUrlOf,
  resolveFreshRecordingUrl,
  transcriberOf,
  VapiConfigError,
  VapiNoRecordingError,
  VapiRequestError,
  type VapiCall,
} from "../lib/vapi";
import { actorFromRequest, writeAudit } from "../lib/audit";
import { AgentConfigError, AgentRequestError, JUDGE_MODEL, analyzeFailure, matchKnownFailure, pricedAgentModels } from "../lib/agent";
import { logger } from "../lib/logger";
import { executeBenchmarkRun } from "../lib/run-executor";
import { drainWithConcurrency } from "../lib/concurrency";
import { getOrCacheAudioBytes, audioCachePathFor, isAudioCached, listCachedCallIds } from "../lib/audio-cache";
import { listBenchmarkCallRows } from "../lib/calls";
import { rescueUncachedAudio } from "../lib/audio-rescue";
import { classifyAudioAttemptFailure, recordAudioCacheAttempt } from "../lib/audio-attempt";
import { cachedVendorModels } from "../lib/model-list-cache";
import { respondInvalid } from "../lib/validation-error";
import { respondJson } from "../lib/respond";
import { createHash, randomUUID } from "node:crypto";
import { createReadStream } from "node:fs";
import { stat as fsStat } from "node:fs/promises";

const router: IRouter = Router();

const defaultProviders = [
  {
    id: "deepgram-nova-3",
    name: "Deepgram",
    model: "Nova-3",
    supportsStreaming: true,
    supportsDiarization: true,
    costPerMinute: 0.0043,
    keywordBoosting: true,
    configNote:
      "Current Rush baseline. Planning price only; verify contract and current VAPI model mapping.",
  },
  {
    id: "assemblyai-universal",
    name: "AssemblyAI",
    model: "Universal",
    supportsStreaming: true,
    supportsDiarization: true,
    costPerMinute: 0.006,
    keywordBoosting: true,
    configNote:
      "Verify current Universal model version, streaming parity, and custom vocabulary behavior.",
  },
  {
    id: "openai-gpt-4o-transcribe",
    name: "OpenAI",
    model: "gpt-4o-transcribe",
    supportsStreaming: false,
    supportsDiarization: false,
    costPerMinute: 0.006,
    keywordBoosting: false,
    configNote:
      "Keep as a batch reference unless current VAPI streaming support and latency meet the protocol.",
  },
  {
    id: "elevenlabs-scribe",
    name: "ElevenLabs",
    model: "Scribe",
    supportsStreaming: true,
    supportsDiarization: true,
    costPerMinute: 0.0065,
    keywordBoosting: false,
    configNote:
      "Verify model version, streaming price, diarization semantics, and vocabulary controls.",
  },
  {
    id: "gladia-solaria",
    name: "Gladia",
    model: "Solaria",
    supportsStreaming: true,
    supportsDiarization: true,
    costPerMinute: 0.0102,
    keywordBoosting: true,
    configNote:
      "Planning price reflects a non-volume tier; replace with negotiated volume pricing before ranking.",
  },
  {
    id: "speechmatics",
    name: "Speechmatics",
    model: "Realtime",
    supportsStreaming: true,
    supportsDiarization: true,
    costPerMinute: 0.004,
    keywordBoosting: true,
    configNote:
      "Verify realtime model, operating-point settings, diarization add-ons, and volume price.",
  },
  {
    id: "cartesia-ink-whisper",
    name: "Cartesia",
    model: "Ink-Whisper",
    supportsStreaming: true,
    supportsDiarization: false,
    costPerMinute: 0.0022,
    keywordBoosting: false,
    configNote:
      "Added on direct request, not in the original written ticket's list. WebSocket-streaming only (no batch REST endpoint), so this is the one provider with a real, measured time-to-first-partial instead of an untested 0. Planning price from public per-hour rate ($0.13/hr on the Scale plan); verify against current pricing and confirm the finalize/close handshake against a real key before trusting output.",
  },
  // 2026-08-27, per Abhishek: a vendor is not a model. These are the other
  // Deepgram models this corpus has real evidence for -- both were observed
  // as the live transcriber on Abhishek's own Vapi calls (flux-general-en on
  // 86 of 121, nova-2 on 2), which is exactly why they matter: the benchmark
  // was ranking candidates against a production baseline it never measured.
  //
  // Seeded manuallyDisabled so adding them costs nothing until someone opts
  // in on the Providers page. Cost per minute is copied from the nova-3 row
  // as a PLACEHOLDER -- confirm real per-model pricing before trusting any
  // ranking that turns on cost.
  {
    id: "deepgram-flux-general-en",
    name: "Deepgram",
    model: "Flux General EN",
    supportsStreaming: true,
    supportsDiarization: true,
    // T-62: verified against deepgram.com/pricing on 2026-08-29. Flux is
    // streaming-only; pay-as-you-go regular price $0.0077/min (a promotional
    // $0.0065 was showing that day -- list price is what gets quoted).
    // Nova-3's $0.0043 above is the PRE-RECORDED rate, which is what this
    // benchmark actually calls; Flux has no pre-recorded rate.
    costPerMinute: 0.0077,
    keywordBoosting: true,
    manuallyDisabled: true,
    configNote:
      "The model most of this corpus was actually recorded with in production (86 of 121 calls). Enable it to benchmark against the real baseline. Price: Deepgram pay-as-you-go regular streaming rate, verified 2026-08-29 (promo $0.0065 seen).",
  },
  {
    id: "deepgram-nova-2",
    name: "Deepgram",
    model: "Nova-2",
    supportsStreaming: true,
    supportsDiarization: true,
    costPerMinute: 0.0043,
    keywordBoosting: true,
    manuallyDisabled: true,
    configNote:
      "Observed on 2 calls in this corpus. Price is a placeholder copied from Nova-3 -- verify per-model pricing before relying on cost.",
  },
] as const;

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
export async function syncProviderReadiness(): Promise<void> {
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
      await db
        .update(benchmarkProvidersTable)
        .set({ status: nextStatus, updatedAt: new Date() })
        .where(eq(benchmarkProvidersTable.id, provider.id));
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

function serializeCall(call: BenchmarkCallRow, audioCached?: boolean): ZodInput<typeof GetBenchmarkCallResponse> {
  return {
    id: call.id,
    label: call.label,
    // Same rule as serializeProvider's status: unconstrained text columns,
    // values held by the runtime parse.
    vertical: call.vertical as ZodInput<typeof GetBenchmarkCallResponse>["vertical"],
    durationSeconds: call.durationSeconds,
    status: call.status as ZodInput<typeof GetBenchmarkCallResponse>["status"],
    hardCases: call.hardCases,
    goldTranscript: call.goldTranscript,
    draftTranscript: call.draftTranscript,
    entityNotes: call.entityNotes,
    entityReferences: call.entityReferences,
    audioObjectPath: call.audioObjectPath,
    deIdAttestedByLabel: call.deIdAttestedByLabel,
    deIdAttestedAt: call.deIdAttestedAt,
    deIdSecondApproverLabel: call.deIdSecondApproverLabel,
    deIdSecondApprovedAt: call.deIdSecondApprovedAt,
    sourceProvider: call.sourceProvider,
    sourceCallId: call.sourceCallId,
    sourceAccountLabel: call.sourceAccountLabel,
    sourceAssistantId: call.sourceAssistantId,
    sourceStartedAt: call.sourceStartedAt,
    sourceTranscriberProvider: call.sourceTranscriberProvider,
    sourceTranscriberModel: call.sourceTranscriberModel,
    sourceEndedReason: call.sourceEndedReason,
    sourceSuccessEvaluation: call.sourceSuccessEvaluation,
    // T-124: only the read routes pass this -- write responses leave it
    // absent rather than claiming false without having looked.
    audioCached,
    // T-131: last audio-cache attempt (rescue/import), so the UI can name a
    // permanent source refusal instead of offering to save the unsaveable.
    audioCacheLastOutcome: call.audioCacheLastOutcome ?? null,
    audioCacheLastError: call.audioCacheLastError ?? null,
    audioCacheLastAttemptAt: call.audioCacheLastAttemptAt,
    createdAt: call.createdAt,
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
  respondJson(res, ListBenchmarkCallsResponse, calls.map((c) => serializeCall(c, cachedIds.has(c.id))));
});

router.post("/benchmark/calls", async (req, res): Promise<void> => {
  const parsed = CreateBenchmarkCallBody.safeParse(req.body);
  if (!parsed.success) {
    req.log.warn({ error: parsed.error.message }, "Invalid benchmark call");
    respondInvalid(res, parsed.error);
    return;
  }

  const [call] = await db
    .insert(benchmarkCallsTable)
    .values({
      label: parsed.data.label,
      vertical: parsed.data.vertical,
      durationSeconds: Math.round(parsed.data.durationSeconds),
      hardCases: parsed.data.hardCases ?? [],
      entityNotes: parsed.data.entityNotes,
      entityReferences: parsed.data.entityReferences ?? [],
      audioObjectPath: parsed.data.audioObjectPath,
      // De-id gate removed 2026-08-27 per Abhishek: a call is runnable the
      // moment it exists, so it lands ready_to_run rather than waiting on a
      // review step that no longer gates anything.
      status: "ready_to_run",
    })
    .returning();

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
  respondJson(res, GetBenchmarkCallResponse, serializeCall(call, await isAudioCached(call.id)));
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

  const [call] = await db
    .update(benchmarkCallsTable)
    .set({
      ...body.data,
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
    res.status(400).json({ error: (params.error ?? body.error)?.message });
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
  const approver = body.data.approverLabel.trim();

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

const VAPI_PREVIEW_CHARS = 240;

/** Corpus label the importer assigns to a Vapi call.
 *
 * Hashes the id rather than truncating it directly -- Vapi call ids are
 * UUIDv7, whose first bytes are a millisecond timestamp, not random bits.
 * Truncating to the first 8 hex chars truncates the timestamp, so any two
 * calls placed close together in time collide on the label (confirmed live:
 * 3 real collisions in a 22-call corpus, calls made in the same session).
 * Hashing first makes the truncated output uniformly distributed, so
 * collisions go back to being astronomically rare instead of routine. */
function vapiLabelFor(vapiCallId: string): string {
  const digest = createHash("sha256").update(vapiCallId).digest("hex");
  return `vapi-${digest.slice(0, 8)}`;
}

/**
 * Finds an existing corpus row for a Vapi call id.
 *
 * Two lookups, not one: `sourceCallId` is exact and authoritative, but calls
 * imported by the earlier CLI predate that column and only carry the derived
 * `vapi-<first8>` label. Without the label fallback, re-previewing a window
 * that overlaps the original CLI import would offer those calls as fresh
 * and duplicate them.
 */
async function findExistingVapiCall(
  vapiCallId: string,
): Promise<{ id: string } | undefined> {
  const [row] = await db
    .select({ id: benchmarkCallsTable.id })
    .from(benchmarkCallsTable)
    .where(
      or(
        and(
          eq(benchmarkCallsTable.sourceProvider, "vapi"),
          eq(benchmarkCallsTable.sourceCallId, vapiCallId),
        ),
        eq(benchmarkCallsTable.label, vapiLabelFor(vapiCallId)),
      ),
    )
    .limit(1);
  return row;
}

/** Maps a Vapi/network failure onto an HTTP status without leaking the key. */
function respondVapiError(res: Response, err: unknown): void {
  if (err instanceof VapiConfigError) {
    res.status(400).json({ error: err.message });
    return;
  }
  if (err instanceof VapiRequestError) {
    res.status(502).json({ error: err.message, vapiStatus: err.httpStatus });
    return;
  }
  res.status(502).json({
    error: err instanceof Error ? err.message : "Vapi request failed.",
  });
}

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
  const account = listVapiAccounts().find((a) => a.id === parsed.data.accountId);
  if (!account) {
    res.status(400).json({
      error: `Unknown or unconfigured Vapi account "${parsed.data.accountId}".`,
    });
    return;
  }

  let calls: VapiCall[];
  try {
    calls = await fetchVapiCalls({
      accountId: parsed.data.accountId,
      limit: parsed.data.limit ?? 50,
      // The generated zod schema coerces `format: date-time` into a Date;
      // Vapi's query params want ISO strings.
      createdAtGe: parsed.data.startDate?.toISOString(),
      createdAtLe: parsed.data.endDate?.toISOString(),
      assistantId: parsed.data.assistantId,
    });
  } catch (err) {
    req.log.warn({ err }, "Vapi preview failed");
    respondVapiError(res, err);
    return;
  }

  // One query for the whole batch rather than per-call, so the duplicate
  // annotation stays cheap as the window widens. Matches on either the exact
  // source id or the derived label (see findExistingVapiCall).
  const ids = calls.map((c) => c.id);
  const existing = ids.length
    ? await db
        .select({
          id: benchmarkCallsTable.id,
          label: benchmarkCallsTable.label,
          sourceCallId: benchmarkCallsTable.sourceCallId,
        })
        .from(benchmarkCallsTable)
        .where(
          or(
            and(
              eq(benchmarkCallsTable.sourceProvider, "vapi"),
              inArray(benchmarkCallsTable.sourceCallId, ids),
            ),
            inArray(benchmarkCallsTable.label, ids.map(vapiLabelFor)),
          ),
        )
    : [];
  const existingBySourceId = new Map(
    existing.flatMap((row) => (row.sourceCallId ? [[row.sourceCallId, row.id]] : [])),
  );
  const existingByLabel = new Map(existing.map((row) => [row.label, row.id]));

  const previewCalls = calls.map((call) => {
    const draft = draftTranscriptOf(call);
    const recordingUrl = recordingUrlOf(call);
    const existingCallId =
      existingBySourceId.get(call.id) ??
      existingByLabel.get(vapiLabelFor(call.id)) ??
      null;
    const startedAtRaw = call.startedAt ?? call.createdAt ?? null;
    return {
      vapiCallId: call.id,
      assistantId: call.assistantId ?? null,
      startedAt: startedAtRaw ? new Date(startedAtRaw) : null,
      durationSeconds: durationSecondsOf(call),
      hasRecording: Boolean(recordingUrl),
      recordingUrl: recordingUrl ?? null,
      draftTranscriptChars: draft?.length ?? 0,
      draftTranscriptPreview: draft ? draft.slice(0, VAPI_PREVIEW_CHARS) : null,
      alreadyImported: existingCallId !== null,
      existingCallId,
    };
  });

  respondJson(
    res,
    PreviewVapiCallsResponse,
    {
      accountId: account.id,
      accountLabel: account.label,
      fetchedCount: previewCalls.length,
      importableCount: previewCalls.filter(
        (c) => c.hasRecording && !c.alreadyImported,
      ).length,
      calls: previewCalls,
    },
  );
});

router.post("/benchmark/vapi/import", async (req, res): Promise<void> => {
  const parsed = ImportVapiCallsBody.safeParse(req.body);
  if (!parsed.success) {
    respondInvalid(res, parsed.error);
    return;
  }
  const account = listVapiAccounts().find((a) => a.id === parsed.data.accountId);
  if (!account) {
    res.status(400).json({
      error: `Unknown or unconfigured Vapi account "${parsed.data.accountId}".`,
    });
    return;
  }

  const actor = actorFromRequest(req);

  type ImportOutcome = {
    vapiCallId: string;
    outcome: "imported" | "skipped_duplicate" | "skipped_no_recording" | "failed";
    callId: string | null;
    label: string | null;
    message: string | null;
  };

  // One call's full import path (duplicate check -> Vapi re-fetch -> insert
  // -> audit). Errors other than a missing config are per-call failures; the
  // batch continues (review finding #4's import parallelism, P1-4 in
  // ox-alpha/improvement-plan.md).
  const importOne = async (vapiCallId: string): Promise<ImportOutcome> => {
    const duplicate = await findExistingVapiCall(vapiCallId);
    if (duplicate) {
      return {
        vapiCallId,
        outcome: "skipped_duplicate",
        callId: duplicate.id,
        label: null,
        message: "Already in the corpus.",
      };
    }

    let call: VapiCall;
    try {
      // Re-fetched from Vapi rather than taken from the request body: the
      // browser must not be able to point a corpus entry at arbitrary audio.
      call = await fetchVapiCall(parsed.data.accountId, vapiCallId);
    } catch (err) {
      if (err instanceof VapiConfigError) throw err; // aborts the whole batch
      req.log.warn({ err, vapiCallId }, "Vapi call fetch failed during import");
      return {
        vapiCallId,
        outcome: "failed",
        callId: null,
        label: null,
        message: err instanceof Error ? err.message : "Fetch failed.",
      };
    }

    const recordingUrl = recordingUrlOf(call);
    if (!recordingUrl) {
      return {
        vapiCallId,
        outcome: "skipped_no_recording",
        callId: null,
        label: null,
        message: "Call has no recording URL; nothing to transcribe.",
      };
    }

    const draft = draftTranscriptOf(call);
    const transcriber = transcriberOf(call);
    const label = vapiLabelFor(call.id);
    const startedAt = call.startedAt ?? call.createdAt;

    const [created] = await db
      .insert(benchmarkCallsTable)
      .values({
        label,
        vertical: parsed.data.vertical,
        durationSeconds: Math.max(1, durationSecondsOf(call)),
        audioObjectPath: recordingUrl,
        // Vapi's transcript goes in draftTranscript, never goldTranscript
        // (GOLD-01): it is the reviewer's starting point, not the reference.
        draftTranscript: draft ?? null,
        status: "ready_to_run",
        sourceProvider: "vapi",
        sourceCallId: call.id,
        sourceAccountLabel: account.label,
        sourceAssistantId: call.assistantId ?? null,
        sourceStartedAt: startedAt ? new Date(startedAt) : null,
        // Best-effort -- null when Vapi doesn't echo the assistant config
        // back on this call. See transcriberOf()'s comment in lib/vapi.ts.
        sourceTranscriberProvider: transcriber?.provider ?? null,
        sourceTranscriberModel: transcriber?.model ?? null,
        sourceEndedReason: call.endedReason ?? null,
        sourceSuccessEvaluation: successEvaluationOf(call),
      })
      .returning();

    await writeAudit({
      entityType: "call",
      entityId: created.id,
      actorLabel: actor,
      action: "import_vapi",
      afterState: serializeCall(created),
    });

    // T-127: save the audio bytes to the server's disk right now, while the
    // recording is certainly still alive at Vapi -- so a newly imported call
    // never sits on the 14-day retention countdown at all. A cache failure
    // must NOT fail the import (the call row is real either way); it is
    // named in the outcome message instead of being a silent gap. This
    // re-resolves a fresh URL via the same path every other cache write
    // uses (getOrCacheAudioBytes), so the player, the run executor and the
    // importer can never disagree about what "the audio" is.
    let message: string | null = null;
    try {
      await getOrCacheAudioBytes(created);
      await recordAudioCacheAttempt(created.id, "saved", null);
    } catch (err) {
      req.log.warn({ err, callId: created.id }, "import: audio could not be cached at import time");
      const errText = err instanceof Error ? err.message : String(err);
      // T-131: remember what this attempt learned (permanent refusal vs
      // retryable), same as the rescue endpoint does.
      await recordAudioCacheAttempt(created.id, classifyAudioAttemptFailure(errText), errText);
      message = `Imported, but the audio could not be saved to the server yet (${errText}). The first run, or "Save audio now" on Calls, will try again.`;
    }

    return {
      vapiCallId,
      outcome: "imported",
      callId: created.id,
      label,
      message,
    };
  };

  // Bounded-parallel import (same worker pool the run executor uses). A
  // missing/invalid account key is fatal for every cell, so that one error
  // aborts the drain and surfaces as the request's error response.
  const byId = new Map<string, ImportOutcome>();
  try {
    await drainWithConcurrency(
      parsed.data.vapiCallIds,
      VAPI_IMPORT_CONCURRENCY,
      async (vapiCallId) => {
        byId.set(vapiCallId, await importOne(vapiCallId));
      },
    );
  } catch (err) {
    if (err instanceof VapiConfigError) {
      respondVapiError(res, err);
      return;
    }
    throw err;
  }
  // Preserve request order so the UI table matches what the operator ticked.
  const results = parsed.data.vapiCallIds.map((id) => byId.get(id)!);

  respondJson(
    res,
    ImportVapiCallsResponse,
    {
      importedCount: results.filter((r) => r.outcome === "imported").length,
      skippedCount: results.filter((r) => r.outcome.startsWith("skipped")).length,
      failedCount: results.filter((r) => r.outcome === "failed").length,
      results,
    },
    201,
  );
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

router.post("/benchmark/providers", async (req, res): Promise<void> => {
  const parsed = CreateBenchmarkProviderBody.safeParse(req.body);
  if (!parsed.success) {
    respondInvalid(res, parsed.error);
    return;
  }

  const base = `${parsed.data.name}-${parsed.data.model}`
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");
  const id = `${base}-${randomUUID().slice(0, 6)}`;
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
              providerId,
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
    res.status(400).json({ error: (params.error ?? body.error)?.message });
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
