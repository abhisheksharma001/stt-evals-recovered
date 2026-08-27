// Hybrid, gold-free quality flagging (2026-08-27, per Abhishek: "we don't
// need a gold transcript any more ... make agent system better ... use a
// hybrid system"). Everything here is deliberately gold-independent -- it
// only ever compares candidate providers' own outputs against EACH OTHER
// (and, where available, each provider's own confidence numbers), never
// against a human-corrected reference. This is what now feeds both (a) the
// automatic per-run flag count that drives Rankings, and (b) the Agent
// page's on-demand deep-dive, so the two surfaces never drift into two
// different notions of "flagged."
//
// Deliberately NOT an LLM call -- this file is pure and free to run on every
// cell of every bundle run. The LLM layer (lib/agent.ts, api-server-side)
// stays a separate, on-demand, paid step that reads THIS module's output
// rather than replacing it -- "hybrid" means cheap deterministic signal
// first, expensive judgment only where the deterministic layer already
// found something worth explaining.

import { diffWords, digitizeSpokenDigits, normalizeTranscript } from "./index";

export type HybridSeverity = "none" | "low" | "medium" | "high";

export function severityRank(severity: HybridSeverity): number {
  return { none: 0, low: 1, medium: 2, high: 3 }[severity];
}

function maxSeverity(a: HybridSeverity, b: HybridSeverity): HybridSeverity {
  return severityRank(b) > severityRank(a) ? b : a;
}

// --- Signal 1: cross-provider disagreement -----------------------------
//
// No gold means no "correct" side to diff against -- so instead every
// candidate is diffed against every OTHER candidate (pairwise, reusing the
// same word-alignment WER already uses), and a provider's disagreement rate
// is how much of its output nobody else agreed with. A provider that's
// consistently the outlier across every pair is the one worth flagging;
// one that mostly matches its peers isn't, even though nothing here can say
// which SIDE was actually right without a human listening to the audio.

export type CrossProviderDisagreement = {
  providerId: string;
  mismatchWords: number;
  comparedWords: number;
  disagreementRate: number; // 0..1, higher = more of an outlier vs consensus
  consensusProviderCount: number; // how many candidates the consensus was built from
};

// T-4 fix (2026-08-27, base-solidity review): the original scheme diffed
// every unordered PAIR and blamed both sides equally for any mismatch. That
// meant a perfect provider absorbed up to 1/(n-1) of an outlier's badness
// just by sharing a run with it, and the SAME provider on the SAME audio
// scored differently depending on who else happened to be in the run --
// breaking comparability across bulks with different provider sets.
//
// Below, disagreement is measured against a plurality CONSENSUS instead:
// align every candidate to one anchor (the median-length candidate --
// length only, not correctness, so an outlier being unusually short/long
// doesn't get picked purely by chance), vote on the majority word at each
// anchor position, then score each candidate against that vote. A provider
// that agrees with the majority scores 0 regardless of who else ran; only
// genuine outliers accrue disagreement. Ties (no majority at a position)
// are excluded from both numerator and denominator for everyone, not
// counted as "everyone was wrong."
//
// With exactly 2 candidates a plurality is meaningless (every mismatch is a
// 1-1 tie), so that case keeps the original direct pairwise comparison.
export function computeCrossProviderDisagreement(
  candidates: { providerId: string; transcript: string }[],
): CrossProviderDisagreement[] {
  const tokenized = candidates.map((c) => ({
    providerId: c.providerId,
    words: normalizeTranscript(c.transcript).split(" ").filter(Boolean),
  }));

  if (tokenized.length < 2) {
    return tokenized.map((t) => ({
      providerId: t.providerId,
      mismatchWords: 0,
      comparedWords: 0,
      disagreementRate: 0,
      consensusProviderCount: tokenized.length,
    }));
  }

  if (tokenized.length === 2) {
    const [a, b] = tokenized as [(typeof tokenized)[number], (typeof tokenized)[number]];
    const diff = diffWords(a.words, b.words);
    const mismatches = diff.filter((op) => op.op !== "ok").length;
    return tokenized.map((t) => ({
      providerId: t.providerId,
      mismatchWords: mismatches,
      comparedWords: diff.length,
      disagreementRate: diff.length === 0 ? 0 : mismatches / diff.length,
      consensusProviderCount: 2,
    }));
  }

  const byLength = [...tokenized].sort((a, b) => a.words.length - b.words.length);
  const anchor = byLength[Math.floor(byLength.length / 2)]!;

  // Per candidate, per anchor-word-position: the word it aligned to there
  // (null = this candidate is missing a word the anchor has). A candidate's
  // extra words (inserted, not anchored to any position) have no slot to
  // vote in -- tallied directly as mismatches below instead.
  const positionValues = new Map<string, Array<string | null>>();
  const insertionCounts = new Map<string, number>();

  for (const t of tokenized) {
    const ops = diffWords(anchor.words, t.words);
    const values: Array<string | null> = [];
    let insertions = 0;
    for (const op of ops) {
      if (op.op === "ok" || op.op === "sub") values.push(op.hyp);
      else if (op.op === "del") values.push(null);
      else insertions += 1; // "ins": extra word, no anchor slot to compare
    }
    positionValues.set(t.providerId, values);
    insertionCounts.set(t.providerId, insertions);
  }

  const positionCount = anchor.words.length;
  const consensus: Array<string | null> = [];
  for (let p = 0; p < positionCount; p += 1) {
    const votes = new Map<string, number>();
    for (const t of tokenized) {
      const v = positionValues.get(t.providerId)![p];
      if (v !== null) votes.set(v, (votes.get(v) ?? 0) + 1);
    }
    let best: string | null = null;
    let bestCount = 0;
    let tie = false;
    for (const [value, count] of votes) {
      if (count > bestCount) {
        best = value;
        bestCount = count;
        tie = false;
      } else if (count === bestCount) {
        tie = true;
      }
    }
    consensus.push(tie || best === null ? null : best); // null = excluded position
  }

  return tokenized.map((t) => {
    const values = positionValues.get(t.providerId)!;
    let mismatchWords = insertionCounts.get(t.providerId)!;
    let comparedWords = insertionCounts.get(t.providerId)!;
    for (let p = 0; p < positionCount; p += 1) {
      if (consensus[p] === null) continue; // excluded -- no consensus to compare against
      comparedWords += 1;
      if (values[p] !== consensus[p]) mismatchWords += 1;
    }
    return {
      providerId: t.providerId,
      mismatchWords,
      comparedWords,
      disagreementRate: comparedWords === 0 ? 0 : mismatchWords / comparedWords,
      consensusProviderCount: tokenized.length,
    };
  });
}

// --- Signal 2: provider-native confidence ------------------------------
//
// 3 of 7 providers (AssemblyAI, Deepgram, Gladia) already return per-word
// confidence and it was never extracted or used (docs/backlog/good-to-have.md,
// "Deferred: confidence scores"). Thresholds below are AssemblyAI's own
// documented suggestion (0.4-0.5 for a single word) plus this project's own
// judgment call on what a "run" of consecutive bad words means (a much
// stronger signal of a real audio problem than one unusual name) -- neither
// has been validated against a human-labeled set, flagged here as a
// starting point, not a settled calibration.

export type ConfidenceSpan = {
  words: string[];
  startIndex: number;
  avgConfidence: number;
  severity: HybridSeverity;
};

const SINGLE_WORD_CONFIDENCE_THRESHOLD = 0.5;
const RUN_CONFIDENCE_THRESHOLD = 0.6;
const MIN_RUN_LENGTH = 2;

export function flagLowConfidenceSpans(
  words: { word: string; confidence: number }[],
): ConfidenceSpan[] {
  const spans: ConfidenceSpan[] = [];
  let run: { word: string; confidence: number }[] = [];

  const flush = (startIndex: number) => {
    if (run.length === 0) return;
    const avgConfidence = run.reduce((sum, w) => sum + w.confidence, 0) / run.length;
    if (run.length >= MIN_RUN_LENGTH && avgConfidence < RUN_CONFIDENCE_THRESHOLD) {
      spans.push({ words: run.map((w) => w.word), startIndex, avgConfidence, severity: "high" });
    } else if (run.length === 1 && run[0]!.confidence < SINGLE_WORD_CONFIDENCE_THRESHOLD) {
      spans.push({ words: run.map((w) => w.word), startIndex, avgConfidence, severity: "low" });
    }
    run = [];
  };

  words.forEach((w, i) => {
    if (w.confidence < RUN_CONFIDENCE_THRESHOLD) {
      run.push(w);
    } else {
      flush(i - run.length);
    }
  });
  flush(words.length - run.length);

  return spans;
}

// --- Signal 3: domain-entity extraction & cross-check -------------------
//
// This is the actual entity-accuracy goal from the PRD (RO/unit/VIN/phone
// numbers), done gold-free: extract the same entity types from every
// candidate and flag when candidates disagree on the VALUE, not just the
// wording -- a wrong VIN or phone number is exactly the class of error raw
// word-diff treats the same as a filler-word swap. Regex-based, not NER --
// real false positives/negatives are expected and acceptable for a first
// pass (this is a flag for a human to check, not an automated verdict).

export type ExtractedEntityType = "phone_number" | "vin" | "reference_number";

export type ExtractedEntity = {
  type: ExtractedEntityType;
  value: string; // normalized (for comparison)
  raw: string; // as it appeared in the transcript
};

const PHONE_RE = /\b(\d{3}[-.\s]?\d{3}[-.\s]?\d{4})\b/g;
// Real VIN spec: 17 chars, excludes I/O/Q (easily confused with 1/0). A
// length-17 alphanumeric run that's ALL letters or ALL digits is almost
// never an actual VIN mention -- just this pattern matching noise -- so
// require at least one of each before counting it as a candidate VIN.
const VIN_RE = /\b([A-HJ-NPR-Z0-9]{17})\b/gi;
// A number right after one of the domain keywords the PRD's own entity list
// names (RO, unit, work order, load number) -- deliberately narrow rather
// than "any number," which would flag every duration and dollar amount too.
const REFERENCE_RE = /\b(?:ro|unit|work\s*order|load(?:\s*number)?|order)[\s#:-]*([a-z0-9-]{2,12})\b/gi;

export function extractEntities(transcript: string): ExtractedEntity[] {
  // T-5 fix (2026-08-27): a provider that spells numbers out ("four four
  // seven one") could never match these digit-expecting regexes at all, so
  // it could never be flagged for getting a reference/phone number wrong --
  // stacking with T-3 into "spell your numbers out and you win." Digitize
  // spoken digits before matching; VIN_RE is left on the raw transcript
  // since VINs mix letters and digits and are conventionally read
  // character-by-character already.
  const digitized = digitizeSpokenDigits(transcript);
  const entities: ExtractedEntity[] = [];
  for (const m of digitized.matchAll(PHONE_RE)) {
    entities.push({ type: "phone_number", value: m[1]!.replace(/[-.\s]/g, ""), raw: m[1]! });
  }
  for (const m of transcript.matchAll(VIN_RE)) {
    const value = m[1]!.toUpperCase();
    if (/[A-Z]/.test(value) && /\d/.test(value)) {
      entities.push({ type: "vin", value, raw: m[1]! });
    }
  }
  for (const m of digitized.matchAll(REFERENCE_RE)) {
    entities.push({ type: "reference_number", value: m[1]!.toUpperCase(), raw: m[0] });
  }
  return entities;
}

export type EntityMismatch = {
  type: ExtractedEntityType;
  valuesByProvider: Record<string, string[]>;
  // T-3 fix (2026-08-27, base-solidity review): the old check only ever
  // compared providers that BOTH mentioned an entity of this type -- a
  // provider that dropped the RO number entirely never appeared here at
  // all, so silently omitting it scored better than a near-miss. Populated
  // only when a real majority exists to be missing from: >=3 providers ran
  // the call (2 providers "agreeing" isn't corroboration, it's just the
  // only other opinion) and one value is produced by >=50% of the
  // providers that produced ANY entity of this type.
  missingProviderIds: string[];
};

const ENTITY_CONSENSUS_MIN_SHARE = 0.5;
const ENTITY_CONSENSUS_MIN_PROVIDERS = 3;

/** Returns entries for every entity type where at least one provider is
 * either in conflict with its peers or missing a value the majority agreed
 * on. A type where every provider agrees (or where too few providers ran to
 * call anything a majority) produces nothing here. */
export function computeEntityMismatches(
  candidates: { providerId: string; transcript: string }[],
): EntityMismatch[] {
  const allProviderIds = candidates.map((c) => c.providerId);
  const byType = new Map<ExtractedEntityType, Map<string, Set<string>>>();
  for (const c of candidates) {
    for (const entity of extractEntities(c.transcript)) {
      if (!byType.has(entity.type)) byType.set(entity.type, new Map());
      const perProvider = byType.get(entity.type)!;
      if (!perProvider.has(c.providerId)) perProvider.set(c.providerId, new Set());
      perProvider.get(c.providerId)!.add(entity.value);
    }
  }

  const mismatches: EntityMismatch[] = [];
  for (const [type, perProvider] of byType) {
    if (perProvider.size < 2) continue; // need 2+ producers to even compare
    const valuesByProvider: Record<string, string[]> = {};
    const signatures = new Set<string>();
    for (const [providerId, values] of perProvider) {
      const sorted = [...values].sort();
      valuesByProvider[providerId] = sorted;
      signatures.add(sorted.join("|"));
    }
    const conflicting = signatures.size > 1;

    let missingProviderIds: string[] = [];
    if (allProviderIds.length >= ENTITY_CONSENSUS_MIN_PROVIDERS) {
      const valueCounts = new Map<string, number>();
      for (const values of perProvider.values()) {
        for (const v of values) valueCounts.set(v, (valueCounts.get(v) ?? 0) + 1);
      }
      const hasMajorityValue = [...valueCounts.values()].some(
        (count) => count / perProvider.size >= ENTITY_CONSENSUS_MIN_SHARE,
      );
      if (hasMajorityValue) {
        missingProviderIds = allProviderIds.filter((id) => !perProvider.has(id));
      }
    }

    if (!conflicting && missingProviderIds.length === 0) continue;
    mismatches.push({ type, valuesByProvider, missingProviderIds });
  }
  return mismatches;
}

// --- Combine into one per-provider result --------------------------------

export type HybridFlagResult = {
  // Total across every signal -- what a human reviewing one cell wants to
  // see (includes confidence spans, which ARE real signal for a human
  // deciding whether to trust one transcript).
  flagCount: number;
  flagSeverity: HybridSeverity;
  // T-2 fix (2026-08-27, base-solidity review): only 3 of 7 providers
  // (AssemblyAI, Deepgram, Gladia) expose per-word confidence at all -- the
  // other 4 structurally produce zero confidence flags, always. Folding
  // confidence into the RANKING signal punished a provider for the honesty
  // of reporting its own uncertainty. peerFlagCount/peerFlagSeverity are
  // the confidence-free subset (cross-provider disagreement + entity
  // mismatches, both available for every provider) -- this is what the
  // ranking composite must use. flagCount/flagSeverity above stay the
  // full picture for per-cell review.
  peerFlagCount: number;
  peerFlagSeverity: HybridSeverity;
  crossProviderDisagreement: CrossProviderDisagreement | null;
  lowConfidenceSpans: ConfidenceSpan[];
  // Whether this provider's raw output exposes per-word confidence at all --
  // lets a caller show "not reported by this provider" instead of a
  // misleading clean 0.
  confidenceAvailable: boolean;
  entityMismatches: EntityMismatch[];
};

// >15% of a provider's words disagreeing with its peers is a real signal,
// not normalization/formatting noise (contractions, filler words already
// get folded out by normalizeTranscript before this ever runs).
const DISAGREEMENT_FLAG_THRESHOLD = 0.15;
const DISAGREEMENT_HIGH_THRESHOLD = 0.35;

export function combineHybridFlags(params: {
  disagreement: CrossProviderDisagreement | null;
  confidenceSpans: ConfidenceSpan[];
  confidenceAvailable: boolean;
  entityMismatches: EntityMismatch[]; // pre-filtered to ones this provider participated in
}): HybridFlagResult {
  let peerFlagCount = 0;
  let confidenceFlagCount = 0;
  let peerFlagSeverity: HybridSeverity = "none";
  let flagSeverity: HybridSeverity = "none";

  if (params.disagreement && params.disagreement.disagreementRate > DISAGREEMENT_FLAG_THRESHOLD) {
    peerFlagCount += 1;
    const severity = params.disagreement.disagreementRate > DISAGREEMENT_HIGH_THRESHOLD ? "high" : "medium";
    peerFlagSeverity = maxSeverity(peerFlagSeverity, severity);
    flagSeverity = maxSeverity(flagSeverity, severity);
  }

  // Confidence spans feed flagCount/flagSeverity (per-cell review) only --
  // deliberately excluded from peerFlagCount/peerFlagSeverity (T-2).
  confidenceFlagCount += params.confidenceSpans.length;
  for (const span of params.confidenceSpans) flagSeverity = maxSeverity(flagSeverity, span.severity);

  // A wrong/missing VIN/phone/RO number is always high-stakes for this
  // tool's actual purpose (PRD G2) regardless of how small it looks as "one
  // word" -- and available for every provider, so it belongs in both.
  peerFlagCount += params.entityMismatches.length;
  if (params.entityMismatches.length > 0) {
    peerFlagSeverity = maxSeverity(peerFlagSeverity, "high");
    flagSeverity = maxSeverity(flagSeverity, "high");
  }

  return {
    flagCount: peerFlagCount + confidenceFlagCount,
    flagSeverity,
    peerFlagCount,
    peerFlagSeverity,
    crossProviderDisagreement: params.disagreement,
    lowConfidenceSpans: params.confidenceSpans,
    confidenceAvailable: params.confidenceAvailable,
    entityMismatches: params.entityMismatches,
  };
}

// --- Ranking composite (replaces the gold-based one in index.ts) --------
//
// FR-S8's composite used to weight entity/alphanumeric accuracy heaviest,
// with WER/latency/cost as secondary. Without a gold transcript there's no
// accuracy metric left at all -- flags (how much a provider disagreed with
// its peers, how often its own confidence was low, how often its entities
// didn't match) become the primary signal instead, with latency/cost as the
// same secondary tie-breakers they always were. Same shape/weighting style
// as RANKING_WEIGHTS in index.ts, deliberately not merged with it -- that
// one is kept only for historical runs scored before this change.
export const HYBRID_RANKING_WEIGHTS = {
  flags: 0.70,
  latency: 0.15,
  cost: 0.15,
} as const;

export type HybridCompositeInput = {
  // avgFlagCount + avgFlagSeverityScore (severityRank 0..3), averaged across
  // a provider's cells -- one blended "how much went wrong" number rather
  // than two separately-weighted ones, so a provider with a few high-
  // severity flags and one with many low-severity flags can still be
  // compared on the same scale.
  flagBadness: number | null;
  latencyFinalMs: number | null;
  costPerMinute: number | null;
  maxFlagBadness: number;
  maxLatencyFinalMs: number;
  maxCostPerMinute: number;
};

/** Returns null when there's no evidence at all (every cell failed) --
 * callers should surface that as "insufficient evidence," same convention
 * as the old compositeScore(). */
export function hybridCompositeScore(input: HybridCompositeInput): number | null {
  if (input.flagBadness === null) return null;

  const flagComponent =
    input.maxFlagBadness <= 0 ? 1 : 1 - Math.min(input.flagBadness / input.maxFlagBadness, 1);
  const latencyComponent =
    input.latencyFinalMs === null || input.maxLatencyFinalMs <= 0
      ? 1
      : 1 - Math.min(input.latencyFinalMs / input.maxLatencyFinalMs, 1);
  const costComponent =
    input.costPerMinute === null || input.maxCostPerMinute <= 0
      ? 1
      : 1 - Math.min(input.costPerMinute / input.maxCostPerMinute, 1);

  return (
    HYBRID_RANKING_WEIGHTS.flags * flagComponent +
    HYBRID_RANKING_WEIGHTS.latency * latencyComponent +
    HYBRID_RANKING_WEIGHTS.cost * costComponent
  );
}
