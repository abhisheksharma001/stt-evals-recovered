// T-09: judge accuracy -- replay human-adjudicated spans through the judge
// and report how often they agree.
//
// Two halves:
//   replayPendingAdjudications  -- spends OpenAI money. For each verdict
//                                  that has not been replayed yet, rebuilds
//                                  the span the human saw (same builder,
//                                  same stored results -> same words) and
//                                  asks judgeCandidates the same question:
//                                  "given these readings and this context,
//                                  which one is right?" Stores the answer on
//                                  the adjudication row so it is paid for
//                                  exactly once.
//   judgeAccuracyReport         -- free. Pure arithmetic over stored rows,
//                                  definition of "agree" in
//                                  lib/scoring/src/judge-agreement.ts.
//
// The judge is deliberately given ONLY what the human had: a few words of
// context and each provider's reading of the disputed stretch. It does not
// get the audio (it cannot hear) and it does not get the whole transcript
// (the human did not read it either). So the number this produces is "how
// often text-only reasoning lands where a listening human landed", which is
// exactly the question T-09 asks -- not a general statement about the judge.
import { eq, isNull } from "drizzle-orm";
import {
  APP_SETTINGS_ID,
  appSettingsTable,
  benchmarkAdjudicationsTable,
  benchmarkProvidersTable,
  db,
} from "@workspace/db";
import { computeJudgeAgreement, picksAgree, type DisagreementSpan, type JudgeAgreementRow } from "@workspace/scoring";
import { judgeCandidates } from "./agent";
import { writeAudit } from "./audit";
import { buildSpansForCallRun } from "./disagreement-spans";
import { logger } from "./logger";

type AdjudicationRow = typeof benchmarkAdjudicationsTable.$inferSelect;

/** How many spans one replay request may send to OpenAI. Each is a short
 *  gpt-4o call (a few hundred tokens, on the order of a cent); the cap
 *  keeps a single click from spending more than that times this. */
export const REPLAY_BATCH_LIMIT = 50;

function spanKey(startMs: number, endMs: number): string {
  return `${startMs}-${endMs}`;
}

function judgeInputForSpan(
  span: DisagreementSpan,
  readings: AdjudicationRow["readings"],
  providerNames: Map<string, string>,
) {
  const before = span.contextBefore.trim();
  const after = span.contextAfter.trim();
  const frame = (words: string) => [before, words.trim() || "(nothing)", after].filter(Boolean).join(" ");
  return {
    // What the human saw: the surrounding words with the disputed stretch
    // marked. There is no "earlier transcript" for a span, and saying so is
    // more honest than inventing one from a provider.
    originalTranscript: frame("[DISPUTED WORDS -- the providers below heard this stretch differently]"),
    flags: [
      {
        text: frame("..."),
        reason: "Providers disagree on the words between the surrounding context; a human has already listened and chosen one.",
      },
    ],
    candidates: readings.map((r) => ({
      providerId: r.providerId,
      providerName: providerNames.get(r.providerId) ?? r.providerId,
      transcript: frame(r.text),
    })),
  };
}

export type ReplayOutcome = {
  replayed: number;
  remaining: number;
  spanNotFound: number;
  judgeFailed: number;
  costMicrocents: number;
};

export async function replayPendingAdjudications(params: {
  actorLabel: string;
  limit?: number;
}): Promise<ReplayOutcome> {
  const limit = Math.max(1, Math.min(params.limit ?? REPLAY_BATCH_LIMIT, REPLAY_BATCH_LIMIT));
  const pending = await db
    .select()
    .from(benchmarkAdjudicationsTable)
    .where(isNull(benchmarkAdjudicationsTable.judgeReplayedAt))
    .orderBy(benchmarkAdjudicationsTable.adjudicatedAt)
    .limit(limit);
  const batch = pending;

  const providerRows = await db.select({ id: benchmarkProvidersTable.id, name: benchmarkProvidersTable.name }).from(benchmarkProvidersTable);
  const providerNames = new Map(providerRows.map((p) => [p.id, p.name]));
  const [settings] = await db
    .select({ agentModel: appSettingsTable.agentModel })
    .from(appSettingsTable)
    .where(eq(appSettingsTable.id, APP_SETTINGS_ID))
    .limit(1);
  const model = settings?.agentModel?.trim() || null;

  const spansByCallRun = new Map<string, Map<string, DisagreementSpan>>();
  const outcome: ReplayOutcome = { replayed: 0, remaining: 0, spanNotFound: 0, judgeFailed: 0, costMicrocents: 0 };

  for (const row of batch) {
    const groupKey = `${row.callId}::${row.runId}`;
    let spans = spansByCallRun.get(groupKey);
    if (!spans) {
      const built = await buildSpansForCallRun(row.callId, row.runId);
      spans = new Map(built.spans.map((s) => [spanKey(s.startMs, s.endMs), s]));
      spansByCallRun.set(groupKey, spans);
    }
    const span = spans.get(spanKey(row.spanStartMs, row.spanEndMs));
    if (!span) {
      // The stored results changed under the key (a cell was re-run, a
      // result row was deleted). The snapshot in `readings` is still the
      // human's evidence, but there is no context to hand the judge, and a
      // replay without context is not the same question. Mark it so it is
      // not retried forever; it lands in the report's "judge named nothing".
      outcome.spanNotFound += 1;
      await db
        .update(benchmarkAdjudicationsTable)
        .set({
          judgePickedProviderId: null,
          judgeReasoning: "span_not_found: the disagreement span could not be rebuilt from this run's stored results, so the judge was not asked.",
          judgeReplayedAt: new Date(),
        })
        .where(eq(benchmarkAdjudicationsTable.id, row.id));
      continue;
    }

    let result: Awaited<ReturnType<typeof judgeCandidates>>;
    try {
      result = await judgeCandidates({ ...judgeInputForSpan(span, row.readings, providerNames), model });
    } catch (err) {
      // Same split as agent-verify.ts: the judge did not answer, nothing to
      // keep, leave the row pending so a later replay retries it.
      outcome.judgeFailed += 1;
      logger.error({ err, adjudicationId: row.id }, "T-09 judge replay: the OpenAI judge call did not return an answer");
      continue;
    }

    const validPick = result.pickedProviderId && row.readings.some((r) => r.providerId === result.pickedProviderId) ? result.pickedProviderId : null;
    await db
      .update(benchmarkAdjudicationsTable)
      .set({
        judgePickedProviderId: validPick,
        judgeReasoning: result.reasoning,
        judgeModel: model ?? "gpt-4o",
        judgePromptTokens: result.promptTokens,
        judgeCompletionTokens: result.completionTokens,
        judgeCostMicrocents: result.costMicrocents,
        judgeReplayedAt: new Date(),
      })
      .where(eq(benchmarkAdjudicationsTable.id, row.id));
    outcome.replayed += 1;
    outcome.costMicrocents += result.costMicrocents ?? 0;
  }

  outcome.remaining = await db.$count(benchmarkAdjudicationsTable, isNull(benchmarkAdjudicationsTable.judgeReplayedAt));

  await writeAudit({
    entityType: "judge_replay",
    entityId: "judge_replay",
    actorLabel: params.actorLabel,
    action: "replay_adjudications",
    afterState: outcome,
  });
  return outcome;
}

export type JudgeAccuracyItem = {
  adjudicationId: string;
  callId: string;
  runId: string;
  spanStartMs: number;
  spanEndMs: number;
  humanProviderId: string | null;
  judgeProviderId: string | null;
  agrees: boolean | null;
  judgeReasoning: string | null;
  adjudicatedByLabel: string;
  readings: AdjudicationRow["readings"];
};

export async function judgeAccuracyReport() {
  const rows = await db.select().from(benchmarkAdjudicationsTable).orderBy(benchmarkAdjudicationsTable.adjudicatedAt);
  const agreementRows: JudgeAgreementRow[] = rows.map((r) => ({
    readings: r.readings,
    humanProviderId: r.correctProviderId,
    judgeProviderId: r.judgeReplayedAt ? r.judgePickedProviderId : undefined,
    adjudicatedByLabel: r.adjudicatedByLabel,
  }));
  const report = computeJudgeAgreement(agreementRows);
  const replayCostMicrocents = rows.reduce((sum, r) => sum + (r.judgeCostMicrocents ?? 0), 0);
  const items: JudgeAccuracyItem[] = rows
    .map((r, i) => ({ r, agreementRow: agreementRows[i]! }))
    .filter(({ r }) => r.judgeReplayedAt)
    .map(({ r, agreementRow }) => ({
      adjudicationId: r.id,
      callId: r.callId,
      runId: r.runId,
      spanStartMs: r.spanStartMs,
      spanEndMs: r.spanEndMs,
      humanProviderId: r.correctProviderId,
      judgeProviderId: r.judgePickedProviderId,
      agrees: picksAgree(agreementRow),
      judgeReasoning: r.judgeReasoning,
      adjudicatedByLabel: r.adjudicatedByLabel,
      readings: r.readings,
    }));
  return { ...report, replayCostMicrocents, replayBatchLimit: REPLAY_BATCH_LIMIT, items };
}
