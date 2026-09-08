// T-20: per-bulk headline verdicts. T-55 (2026-08-29): one per ORG (the
// call's Vapi account label), no longer per assistant -- live bulks split
// into 22-23 assistant groups of 1-2 calls, so no group could reach the
// 5-shared-call floor and every card said too_few_calls. Rankings still
// group per assistant; each card looks its assistant up in the client
// group's `assistantIds`. Reads the bulk's ok cells with
// their scores and hands the peer flag counts + word counts to the pure
// scorer in @workspace/scoring. Computed at read time from the same cells
// the rankings snapshot was built from, so it can never disagree with a
// stale snapshot of its own.
import { and, eq, inArray } from "drizzle-orm";
import {
  benchmarkBulksTable,
  benchmarkCallsTable,
  benchmarkProviderCallResultsTable,
  benchmarkProvidersTable,
  benchmarkRunsTable,
  benchmarkScoresTable,
  db,
} from "@workspace/db";
import {
  callWordBasis,
  computeCrossProviderDisagreement,
  computeVerdict,
  normalizeTranscript,
  productionCustomerTurns,
  type HeadlineVerdict,
  type VerdictCell,
} from "@workspace/scoring";
import { extractProviderConfidenceWords } from "./hybrid-flagging";

export type BulkGroupVerdict = {
  /** Vapi account label the group's calls came from; null = none on file. */
  clientLabel: string | null;
  /** Every assistant (null = no assistant id) whose calls fed this group. */
  assistantIds: (string | null)[];
  callCount: number;
  vertical: string;
  /** Vapi's live transcriber for this group's calls, most common
   *  vendor/model pair, with how many of the group's calls it covers. */
  production: { vendor: string; model: string | null; coverage: number; total: number } | null;
  /** M-8a: how far production's OWN transcript sat from the candidates'
   *  consensus on this group's calls. Null on a bulk that ran on the mono
   *  mix -- see productionDisagreementFor. */
  productionDisagreement: ProductionDisagreement | null;
  verdict: HeadlineVerdict;
};

export type ProductionDisagreement = {
  /** Pooled mismatch words / compared words across `calls`, 0..1. */
  rate: number;
  /** The same measure for the best-agreeing candidate, over exactly the same
   *  calls, so the two numbers are on one scale. Null when no candidate had
   *  a comparable word. */
  leaderProviderId: string | null;
  leaderRate: number | null;
  /** Calls this could be computed on, out of the group's total. Never
   *  presented as the whole group: a call with no caller turn in its draft,
   *  or fewer than three candidates, has no answer here. */
  calls: number;
  totalCalls: number;
};

export type BulkVerdicts = {
  bulkId: string;
  providers: { id: string; name: string }[];
  groups: BulkGroupVerdict[];
};

const NO_CLIENT_KEY = "__no_client__";
const norm = (v: string) => v.toLowerCase().replace(/[^a-z0-9]/g, "");

/** Which provider row IS a call's production transcriber -- the same
 * vendor/model normalisation the verdict uses, shared with the bulk preview
 * (T-56) so both answer identically. Null when nothing on file matches. */
export function resolveProductionProviderId(
  vendor: string,
  model: string | null,
  providers: { id: string; name: string; model: string }[],
): string | null {
  return providers.find((p) => norm(p.name) === norm(vendor) && (model ? norm(p.model) === norm(model) : false))?.id ?? null;
}

/** M-8a: an id no provider row can have, so a production candidate that ever
 *  escaped into a ranking would be unmistakable rather than plausible. */
const PRODUCTION_CANDIDATE_ID = "__production__";

/** At least this many candidates must have transcribed a call before
 *  production can be measured against them -- a plurality needs three
 *  voters (lib/scoring/src/hybrid.ts). */
const MIN_CONSENSUS_CANDIDATES = 3;

/**
 * M-8a: production's own transcript, held against the candidates' consensus.
 *
 * Production (Deepgram Flux for 50 of 56 Land And Apartment calls) is
 * streaming-only and cannot be run here, so it never has cells of its own and
 * `resolveProductionProviderId` returns null for it. What it does have is the
 * Vapi draft on every call, whose "User:" turns ARE its transcript of the
 * customer channel. Those turns go in as one more candidate -- NON-VOTING, so
 * the consensus stays the one the providers' stored peerFlagCounts were
 * computed against and the two numbers remain on one scale.
 *
 * Gated on the bulk's channel by the caller, and for a hard reason: on a mono
 * bulk the candidates transcribed both speakers (~126 words a call) and this
 * is the caller alone (~37), so the comparison would read as ~70%
 * disagreement purely for the assistant's turns being absent. Null, not a
 * number, until a bulk runs on the customer channel.
 */
function productionDisagreementFor(
  groupCalls: { id: string; draftTranscript: string | null }[],
  cellsByCall: Map<string, { providerId: string; transcript: string | null }[]>,
): ProductionDisagreement | null {
  let mismatchWords = 0;
  let comparedWords = 0;
  let calls = 0;
  const candidateTotals = new Map<string, { mismatch: number; compared: number }>();

  for (const call of groupCalls) {
    if (!call.draftTranscript) continue;
    const customerTurns = productionCustomerTurns(call.draftTranscript);
    if (!customerTurns.trim()) continue; // no caller turn on file -- no answer, not a zero

    // One cell per provider: a re-run leaves a second row for the same
    // (call, provider) and a duplicate candidate would vote twice.
    const byProvider = new Map<string, string>();
    for (const cell of cellsByCall.get(call.id) ?? []) {
      if (cell.transcript && !byProvider.has(cell.providerId)) byProvider.set(cell.providerId, cell.transcript);
    }
    if (byProvider.size < MIN_CONSENSUS_CANDIDATES) continue;

    const rows = computeCrossProviderDisagreement(
      [
        ...[...byProvider].map(([providerId, transcript]) => ({ providerId, transcript })),
        { providerId: PRODUCTION_CANDIDATE_ID, transcript: customerTurns },
      ],
      { nonVoting: [PRODUCTION_CANDIDATE_ID] },
    );

    const production = rows.find((r) => r.providerId === PRODUCTION_CANDIDATE_ID);
    if (!production || production.comparedWords === 0) continue;
    mismatchWords += production.mismatchWords;
    comparedWords += production.comparedWords;
    calls += 1;
    for (const row of rows) {
      if (row.providerId === PRODUCTION_CANDIDATE_ID) continue;
      const totals = candidateTotals.get(row.providerId) ?? { mismatch: 0, compared: 0 };
      totals.mismatch += row.mismatchWords;
      totals.compared += row.comparedWords;
      candidateTotals.set(row.providerId, totals);
    }
  }

  if (calls === 0 || comparedWords === 0) return null;

  let leaderProviderId: string | null = null;
  let leaderRate: number | null = null;
  for (const [providerId, totals] of [...candidateTotals].sort((a, b) => a[0].localeCompare(b[0]))) {
    if (totals.compared === 0) continue;
    const rate = totals.mismatch / totals.compared;
    if (leaderRate === null || rate < leaderRate) {
      leaderRate = rate;
      leaderProviderId = providerId;
    }
  }

  return {
    rate: mismatchWords / comparedWords,
    leaderProviderId,
    leaderRate,
    calls,
    totalCalls: groupCalls.length,
  };
}

export async function bulkVerdicts(bulkId: string): Promise<BulkVerdicts> {
  const [bulkRow] = await db
    .select({ selectionCriteria: benchmarkBulksTable.selectionCriteria })
    .from(benchmarkBulksTable)
    .where(eq(benchmarkBulksTable.id, bulkId))
    .limit(1);
  // M-5: the channel this bulk declares. The verdict reads only cells that
  // came off it, for the same reason the rankings do -- a headline that
  // averages caller-only and mono cells together is one number describing
  // two different measurements. Pre-M-5 rows carry null and are mono.
  const bulkAudioSource: "customer" | "mono" =
    bulkRow?.selectionCriteria.requireCustomerAudio === true ? "customer" : "mono";

  const runs = await db
    .select({ id: benchmarkRunsTable.id, callIds: benchmarkRunsTable.callIds, providerIds: benchmarkRunsTable.providerIds })
    .from(benchmarkRunsTable)
    .where(eq(benchmarkRunsTable.bulkId, bulkId));
  if (runs.length === 0) return { bulkId, providers: [], groups: [] };
  const runIds = runs.map((r) => r.id);
  const allCallIds = [...new Set(runs.flatMap((r) => r.callIds))];
  const allProviderIds = [...new Set(runs.flatMap((r) => r.providerIds))];

  const [calls, providers, cells] = await Promise.all([
    allCallIds.length
      ? db
          .select({
            id: benchmarkCallsTable.id,
            sourceAssistantId: benchmarkCallsTable.sourceAssistantId,
            sourceAccountLabel: benchmarkCallsTable.sourceAccountLabel,
            vertical: benchmarkCallsTable.vertical,
            sourceTranscriberProvider: benchmarkCallsTable.sourceTranscriberProvider,
            sourceTranscriberModel: benchmarkCallsTable.sourceTranscriberModel,
            // M-8a: production's own transcript of the call. Its "User:"
            // turns are the customer-channel half.
            draftTranscript: benchmarkCallsTable.draftTranscript,
          })
          .from(benchmarkCallsTable)
          .where(inArray(benchmarkCallsTable.id, allCallIds))
      : Promise.resolve([] as { id: string; sourceAssistantId: string | null; sourceAccountLabel: string | null; vertical: string; sourceTranscriberProvider: string | null; sourceTranscriberModel: string | null; draftTranscript: string | null }[]),
    allProviderIds.length
      ? db
          .select({ id: benchmarkProvidersTable.id, name: benchmarkProvidersTable.name, model: benchmarkProvidersTable.model })
          .from(benchmarkProvidersTable)
          .where(inArray(benchmarkProvidersTable.id, allProviderIds))
      : Promise.resolve([] as { id: string; name: string; model: string }[]),
    db
      .select({
        id: benchmarkProviderCallResultsTable.id,
        callId: benchmarkProviderCallResultsTable.callId,
        providerId: benchmarkProviderCallResultsTable.providerId,
        transcript: benchmarkProviderCallResultsTable.hypothesisTranscript,
        peerFlagCount: benchmarkScoresTable.peerFlagCount,
        audioSource: benchmarkProviderCallResultsTable.audioSource,
      })
      .from(benchmarkProviderCallResultsTable)
      .innerJoin(benchmarkScoresTable, eq(benchmarkScoresTable.resultId, benchmarkProviderCallResultsTable.id))
      .where(
        and(
          inArray(benchmarkProviderCallResultsTable.runId, runIds),
          eq(benchmarkProviderCallResultsTable.status, "ok"),
        ),
      ),
  ]);

  const cellsOnChannel = cells.filter((c) => (c.audioSource ?? "mono") === bulkAudioSource);

  // Which providers report per-word confidence: decided from ONE real ok
  // response per provider through the same extractor hybrid flagging uses
  // -- not from a hardcoded list -- so it stays true to what each API
  // actually returned. One row per provider keeps rawOutput reads cheap.
  // M-8a: the same on-channel cells, keyed by call, so production can be
  // held against each call's candidates without re-scanning the list.
  const cellsByCall = new Map<string, { providerId: string; transcript: string | null }[]>();
  for (const c of cellsOnChannel) {
    const list = cellsByCall.get(c.callId) ?? [];
    list.push({ providerId: c.providerId, transcript: c.transcript });
    cellsByCall.set(c.callId, list);
  }

  const sampleIdByProvider = new Map<string, string>();
  for (const c of cellsOnChannel) if (!sampleIdByProvider.has(c.providerId)) sampleIdByProvider.set(c.providerId, c.id);
  const samples = sampleIdByProvider.size
    ? await db
        .select({ providerId: benchmarkProviderCallResultsTable.providerId, rawOutput: benchmarkProviderCallResultsTable.rawOutput })
        .from(benchmarkProviderCallResultsTable)
        .where(inArray(benchmarkProviderCallResultsTable.id, [...sampleIdByProvider.values()]))
    : [];
  const confidenceReportingProviderIds = samples
    .filter((s) => extractProviderConfidenceWords(s.providerId, s.rawOutput) !== null)
    .map((s) => s.providerId);

  // R-1: the word basis for each call, one number every provider on that
  // call is measured against. Computed over the whole bulk's on-channel
  // cells; a call belongs to exactly one org group, so scoping it per group
  // would give the same numbers.
  const wordBasis = callWordBasis(
    cellsOnChannel.map((c) => ({
      callId: c.callId,
      words: normalizeTranscript(c.transcript ?? "").split(" ").filter(Boolean).length,
    })),
  );

  const providerNames = Object.fromEntries(providers.map((p) => [p.id, p.name]));
  const clientKeyOf = (c: { sourceAccountLabel: string | null }) => c.sourceAccountLabel?.trim() || NO_CLIENT_KEY;
  const groupKeys = new Set(calls.map(clientKeyOf));

  const groups: BulkGroupVerdict[] = [];
  for (const key of [...groupKeys].sort()) {
    const clientLabel = key === NO_CLIENT_KEY ? null : key;
    const groupCalls = calls.filter((c) => clientKeyOf(c) === key);
    const groupCallIds = new Set(groupCalls.map((c) => c.id));
    const assistantIds = [...new Set(groupCalls.map((c) => c.sourceAssistantId ?? null))].sort((a, b) => (a ?? "").localeCompare(b ?? ""));

    const verticalCounts = new Map<string, number>();
    for (const c of groupCalls) verticalCounts.set(c.vertical, (verticalCounts.get(c.vertical) ?? 0) + 1);
    const vertical = [...verticalCounts.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? "rush";

    // Production baseline: same vendor/model normalisation Rankings.tsx's
    // useProductionBaseline applies client-side, now done once here.
    const prodCounts = new Map<string, number>();
    for (const c of groupCalls) {
      if (!c.sourceTranscriberProvider) continue;
      const k = `${c.sourceTranscriberProvider}::${c.sourceTranscriberModel ?? ""}`;
      prodCounts.set(k, (prodCounts.get(k) ?? 0) + 1);
    }
    const topProd = [...prodCounts.entries()].sort((a, b) => b[1] - a[1])[0];
    let production: BulkGroupVerdict["production"] = null;
    let productionProviderId: string | null = null;
    if (topProd) {
      const [vendor, model] = topProd[0].split("::") as [string, string];
      production = { vendor, model: model || null, coverage: topProd[1], total: groupCalls.length };
      productionProviderId = resolveProductionProviderId(vendor, model || null, providers);
    }

    const verdictCells: VerdictCell[] = cellsOnChannel
      .filter((c) => groupCallIds.has(c.callId))
      .map((c) => ({
        callId: c.callId,
        providerId: c.providerId,
        peerFlagCount: c.peerFlagCount,
        words: wordBasis.get(c.callId) ?? 0,
      }));

    groups.push({
      clientLabel,
      assistantIds,
      callCount: groupCalls.length,
      vertical,
      production,
      // M-8a: only on a customer-channel bulk. On a mono bulk the candidates
      // heard both speakers and production's draft turns are the caller
      // alone, so the comparison would read as ~70% disagreement for a reason
      // that has nothing to do with production.
      productionDisagreement:
        bulkAudioSource === "customer" ? productionDisagreementFor(groupCalls, cellsByCall) : null,
      verdict: computeVerdict(verdictCells, { productionProviderId, confidenceReportingProviderIds, providerNames }),
    });
  }

  return { bulkId, providers: providers.map((p) => ({ id: p.id, name: p.name })), groups };
}
