// T-72 (PRD-v4-uiux E.4): one call, every provider's output under the
// reference transcript. Computed server-side from the same immutable result
// and score rows Runs/Results read, so this section can never disagree
// with them.
//
// Reference rule (project standing rule, never bent here): the gold
// transcript is the reference only when the call has one; otherwise the
// Vapi draft is the reference and is labelled "draft" -- the draft is the
// output of whichever provider Vapi ran live on the call and must never be
// presented as a standard. When a gold transcript exists the draft is
// still shown, as one more row marked "production", diffed against gold
// like every candidate (E.4 open decision, default yes).
import { and, desc, eq, inArray } from "drizzle-orm";
import {
  benchmarkAgentScansTable,
  benchmarkBulksTable,
  benchmarkCallsTable,
  benchmarkProviderCallResultsTable,
  benchmarkProvidersTable,
  benchmarkRunsTable,
  benchmarkScoresTable,
  db,
} from "@workspace/db";
import { diffWords, normalizeTranscript, type WordDiffOp } from "@workspace/scoring";
import { isFailureClass, isRetryableFailureClass, type FailureClass } from "@workspace/stt-providers";
import { matchKnownFailure } from "./agent";
import { bulkVerdicts } from "./verdict";

export type ComparisonReference = { kind: "gold" | "draft"; text: string };

export type ComparisonDiff = {
  wordDiff: WordDiffOp[];
  referenceWords: number;
  wordsDiffer: number;
  /** errors / referenceWords against THIS section's reference. Not the
   *  retired gold WER column -- computed fresh, and null when the reference
   *  is empty. */
  werVsReference: number | null;
};

export type LowConfidenceWordSpan = { words: string[]; avgConfidence: number; severity: string };

export type ComparisonHybridFlags = {
  disagreementRate: number | null;
  lowConfidenceSpans: number;
  /** T-109: the spans themselves (the provider's own per-word confidence,
   *  hybrid.ts signal 2), so the diff can underline the words it was unsure
   *  of. Empty when the provider reports no confidence. */
  lowConfidenceWordSpans: LowConfidenceWordSpan[];
  confidenceAvailable: boolean;
  entityMismatches: number;
};

export type ComparisonRow = {
  providerId: string;
  providerName: string;
  /** "missing": the provider was in the run's provider list but no result
   *  row exists for this call (E.5 says a missing row is still a row). */
  status: "ok" | "failed" | "skipped_pending_review" | "pending" | "cancelled" | "missing";
  resultId: string | null;
  runId: string | null;
  attemptedAt: string | null;
  hypothesisTranscript: string | null;
  diff: ComparisonDiff | null;
  peerFlagCount: number | null;
  peerFlagSeverity: string | null;
  flagCount: number | null;
  flagSeverity: string | null;
  hybridFlags: ComparisonHybridFlags | null;
  latencyFinalMs: number | null;
  costMicrocents: number | null;
  failureClass: FailureClass | null;
  /** null = class unknown so retryability is unknown; never defaulted. */
  retryable: boolean | null;
  errorMessage: string | null;
  failureDiagnosis: string | null;
  failureSuggestedFix: string | null;
  isJudgePick: boolean;
};

export type CallComparison = {
  callId: string;
  label: string;
  callStatus: string;
  durationSeconds: number;
  reference: ComparisonReference | null;
  audioAvailable: boolean;
  production: { vendor: string; model: string | null } | null;
  /** The Vapi draft as an extra row, only when the reference is gold. */
  productionRow: { text: string; diff: ComparisonDiff | null } | null;
  context: { bulkId: string; bulkName: string } | null;
  ordering: "verdict_rate" | "alphabetical";
  judge: {
    scanId: string;
    status: string;
    pickProviderId: string | null;
    reasoning: string | null;
    /** T-108: typed verdict halves; null on pre-2026-08-30 scans. */
    confidence: "high" | "medium" | "low" | null;
    keyDifferences: Array<{ span: string; alternatives: string; matters: string }> | null;
    createdAt: string;
  } | null;
  rows: ComparisonRow[];
};

/** Vapi drafts (and gold transcripts written from them) carry speaker
 * labels per line ("AI: …", "User: …"). Provider output never does, so
 * the labels must not count as deleted words in the diff. Same line
 * pattern the Corpus turn parser used. */
export function stripSpeakerLabels(text: string): string {
  return text
    .split(/\r?\n/)
    .map((line) => line.replace(/^\s*[A-Za-z][A-Za-z ]{0,14}:\s*/, ""))
    .join("\n");
}

function words(text: string): string[] {
  return normalizeTranscript(text).split(" ").filter(Boolean);
}

/**
 * T-73: one place decides whether a cell's failure is worth re-running.
 * Same rule as the executor's permanently-failed set (isRetryableFailureClass)
 * and the bulk failure groups; used by the comparison rows and the run
 * results rows so no screen re-derives it.
 *   - failed + classified          -> the class's verdict
 *   - skipped_pending_review       -> true (a re-run picks it up once the
 *                                     call clears review)
 *   - failed + no class            -> null: predates classification, never
 *                                     defaulted to either answer
 *   - anything else                -> null (not a failure)
 */
export function cellRetryable(status: string, failureClass: string | null | undefined): boolean | null {
  if (status === "skipped_pending_review") return true;
  if (status !== "failed") return null;
  return isFailureClass(failureClass) ? isRetryableFailureClass(failureClass) : null;
}

export function diffAgainstReference(reference: string, hypothesis: string): ComparisonDiff {
  const ref = words(stripSpeakerLabels(reference));
  const ops = diffWords(ref, words(hypothesis));
  const wordsDiffer = ops.filter((o) => o.op !== "ok").length;
  return {
    wordDiff: ops,
    referenceWords: ref.length,
    wordsDiffer,
    werVsReference: ref.length === 0 ? null : wordsDiffer / ref.length,
  };
}

function hybridFlagsOf(detail: Record<string, unknown> | null): ComparisonHybridFlags | null {
  const hf = (detail as { hybridFlags?: Record<string, unknown> } | null)?.hybridFlags;
  if (!hf) return null;
  const disagreement = hf.crossProviderDisagreement as { disagreementRate?: number } | null | undefined;
  const spans: LowConfidenceWordSpan[] = Array.isArray(hf.lowConfidenceSpans)
    ? (hf.lowConfidenceSpans as Array<{ words?: unknown; avgConfidence?: unknown; severity?: unknown }>)
        .filter((s) => Array.isArray(s.words) && typeof s.avgConfidence === "number")
        .map((s) => ({
          words: (s.words as unknown[]).filter((w): w is string => typeof w === "string"),
          avgConfidence: s.avgConfidence as number,
          severity: typeof s.severity === "string" ? s.severity : "low",
        }))
    : [];
  return {
    disagreementRate: typeof disagreement?.disagreementRate === "number" ? disagreement.disagreementRate : null,
    lowConfidenceSpans: spans.length,
    lowConfidenceWordSpans: spans,
    confidenceAvailable: hf.confidenceAvailable === true,
    entityMismatches: Array.isArray(hf.entityMismatches) ? hf.entityMismatches.length : 0,
  };
}

export async function callComparison(callId: string, bulkId: string | null): Promise<CallComparison | null> {
  const [call] = await db.select().from(benchmarkCallsTable).where(eq(benchmarkCallsTable.id, callId)).limit(1);
  if (!call) return null;

  // Context: one bulk's runs, or every real ("batch") run. Agent-scan runs
  // are single-call re-transcriptions and stay out of this view exactly as
  // they stay out of Runs/Results.
  let context: CallComparison["context"] = null;
  if (bulkId) {
    const [bulk] = await db
      .select({ id: benchmarkBulksTable.id, name: benchmarkBulksTable.name })
      .from(benchmarkBulksTable)
      .where(eq(benchmarkBulksTable.id, bulkId))
      .limit(1);
    if (!bulk) return null;
    context = { bulkId: bulk.id, bulkName: bulk.name };
  }
  const runs = await db
    .select({ id: benchmarkRunsTable.id, providerIds: benchmarkRunsTable.providerIds, callIds: benchmarkRunsTable.callIds })
    .from(benchmarkRunsTable)
    .where(
      bulkId
        ? and(eq(benchmarkRunsTable.bulkId, bulkId), eq(benchmarkRunsTable.purpose, "batch"))
        : eq(benchmarkRunsTable.purpose, "batch"),
    )
    .orderBy(desc(benchmarkRunsTable.createdAt));
  const runsWithCall = runs.filter((r) => r.callIds.includes(callId));
  const runIds = runsWithCall.map((r) => r.id);

  const providers = await db
    .select({ id: benchmarkProvidersTable.id, name: benchmarkProvidersTable.name })
    .from(benchmarkProvidersTable);
  const providerName = new Map(providers.map((p) => [p.id, p.name]));

  const cells = runIds.length
    ? await db
        .select({ result: benchmarkProviderCallResultsTable, score: benchmarkScoresTable })
        .from(benchmarkProviderCallResultsTable)
        .leftJoin(benchmarkScoresTable, eq(benchmarkScoresTable.resultId, benchmarkProviderCallResultsTable.id))
        .where(
          and(
            eq(benchmarkProviderCallResultsTable.callId, callId),
            inArray(benchmarkProviderCallResultsTable.runId, runIds),
          ),
        )
        .orderBy(desc(benchmarkProviderCallResultsTable.createdAt))
    : [];

  // Latest attempt per provider. A retry replaces a failed row in place
  // (T-27 upsert) so "latest" is the honest state of that cell.
  const latestByProvider = new Map<string, (typeof cells)[number]>();
  for (const cell of cells) {
    if (!latestByProvider.has(cell.result.providerId)) latestByProvider.set(cell.result.providerId, cell);
  }
  // Providers a run was supposed to cover for this call but never wrote a
  // row for -- rendered as "missing", never silently dropped.
  const expectedProviderIds = new Set<string>();
  // T-73: remember which run expected each provider, so a "missing" row can
  // still offer the retry action (re-execute that run) -- latest run wins.
  const runExpectingProvider = new Map<string, string>();
  for (const r of runsWithCall) {
    for (const p of r.providerIds) {
      expectedProviderIds.add(p);
      if (!runExpectingProvider.has(p)) runExpectingProvider.set(p, r.id);
    }
  }
  for (const p of latestByProvider.keys()) expectedProviderIds.add(p);

  // Judge pick: latest scan for this call, scoped to the context's runs
  // when in a bulk. The pick is a result id; resolve it to a provider.
  const scanWhere = runIds.length
    ? and(eq(benchmarkAgentScansTable.callId, callId), inArray(benchmarkAgentScansTable.runId, runIds))
    : eq(benchmarkAgentScansTable.callId, callId);
  const [scan] = await db
    .select()
    .from(benchmarkAgentScansTable)
    .where(scanWhere)
    .orderBy(desc(benchmarkAgentScansTable.createdAt))
    .limit(1);
  let pickProviderId: string | null = null;
  if (scan?.agentPickResultId) {
    const [pick] = await db
      .select({ providerId: benchmarkProviderCallResultsTable.providerId })
      .from(benchmarkProviderCallResultsTable)
      .where(eq(benchmarkProviderCallResultsTable.id, scan.agentPickResultId))
      .limit(1);
    pickProviderId = pick?.providerId ?? null;
  }

  const gold = call.goldTranscript?.trim() ? call.goldTranscript : null;
  const draft = call.draftTranscript?.trim() ? call.draftTranscript : null;
  const reference: ComparisonReference | null = gold
    ? { kind: "gold", text: gold }
    : draft
      ? { kind: "draft", text: draft }
      : null;

  const rows: ComparisonRow[] = [];
  for (const providerId of expectedProviderIds) {
    const cell = latestByProvider.get(providerId);
    const name = providerName.get(providerId) ?? providerId;
    if (!cell) {
      rows.push({
        providerId,
        providerName: name,
        status: "missing",
        resultId: null,
        runId: runExpectingProvider.get(providerId) ?? null,
        attemptedAt: null,
        hypothesisTranscript: null,
        diff: null,
        peerFlagCount: null,
        peerFlagSeverity: null,
        flagCount: null,
        flagSeverity: null,
        hybridFlags: null,
        latencyFinalMs: null,
        costMicrocents: null,
        failureClass: null,
        retryable: null,
        errorMessage: null,
        failureDiagnosis: null,
        failureSuggestedFix: null,
        isJudgePick: providerId === pickProviderId,
      });
      continue;
    }
    const { result, score } = cell;
    const failureClass = isFailureClass(result.failureClass) ? result.failureClass : null;
    const known = result.status === "failed" ? matchKnownFailure({ failureClass, errorMessage: result.errorMessage }) : null;
    const status = result.status as ComparisonRow["status"];
    rows.push({
      providerId,
      providerName: name,
      status,
      resultId: result.id,
      runId: result.runId,
      attemptedAt: (result.finalAt ?? result.submittedAt ?? result.createdAt)?.toISOString() ?? null,
      hypothesisTranscript: result.hypothesisTranscript,
      diff:
        reference && result.status === "ok" && result.hypothesisTranscript
          ? diffAgainstReference(reference.text, result.hypothesisTranscript)
          : null,
      peerFlagCount: score?.peerFlagCount ?? null,
      peerFlagSeverity: score?.peerFlagSeverity ?? null,
      flagCount: score?.flagCount ?? null,
      flagSeverity: score?.flagSeverity ?? null,
      hybridFlags: hybridFlagsOf(score?.detail ?? null),
      latencyFinalMs: score?.latencyFinalMs ?? null,
      costMicrocents: score?.costMicrocents ?? null,
      failureClass,
      retryable: cellRetryable(result.status, failureClass),
      errorMessage: result.errorMessage,
      failureDiagnosis: result.failureDiagnosis ?? known?.diagnosis ?? null,
      failureSuggestedFix: result.failureSuggestedFix ?? known?.suggestedFix ?? null,
      isJudgePick: providerId === pickProviderId,
    });
  }

  // Ordering: the bulk's verdict rate (peer flags per 100 words, lower
  // first) for the group this call belongs to; alphabetical otherwise.
  // Providers the verdict has no rate for sort after the rated ones.
  let ordering: CallComparison["ordering"] = "alphabetical";
  const byName = (a: ComparisonRow, b: ComparisonRow) => a.providerName.localeCompare(b.providerName);
  if (bulkId) {
    const verdicts = await bulkVerdicts(bulkId);
    const group =
      verdicts.groups.find((g) => g.assistantIds.includes(call.sourceAssistantId ?? null)) ?? null;
    if (group && group.verdict.rates.length > 0) {
      ordering = "verdict_rate";
      const rate = new Map(group.verdict.rates.map((r) => [r.providerId, r.flagsPer100Words]));
      rows.sort((a, b) => {
        const ra = rate.get(a.providerId);
        const rb = rate.get(b.providerId);
        if (ra != null && rb != null) return ra - rb || byName(a, b);
        if (ra != null) return -1;
        if (rb != null) return 1;
        return byName(a, b);
      });
    } else {
      rows.sort(byName);
    }
  } else {
    rows.sort(byName);
  }

  return {
    callId: call.id,
    label: call.label,
    callStatus: call.status,
    durationSeconds: call.durationSeconds,
    reference,
    audioAvailable: Boolean(call.audioObjectPath),
    production: call.sourceTranscriberProvider
      ? { vendor: call.sourceTranscriberProvider, model: call.sourceTranscriberModel ?? null }
      : null,
    productionRow:
      reference?.kind === "gold" && draft ? { text: draft, diff: diffAgainstReference(reference.text, stripSpeakerLabels(draft)) } : null,
    context,
    ordering,
    judge: scan
      ? {
          scanId: scan.id,
          status: scan.status,
          pickProviderId,
          reasoning: scan.agentPickReasoning ?? null,
          confidence: scan.judgeConfidence ?? null,
          keyDifferences: scan.judgeKeyDifferences ?? null,
          createdAt: scan.createdAt.toISOString(),
        }
      : null,
    rows,
  };
}
