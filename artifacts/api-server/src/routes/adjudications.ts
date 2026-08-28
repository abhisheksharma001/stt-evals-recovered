// T-08: span adjudication.
//
// Two endpoints. GET builds the disagreement spans for one call from the
// stored provider results of one run (nothing is persisted; spans are a
// pure function of results that never change) and decorates each with the
// human verdict on it, if any. POST records a verdict.
//
// Spans are keyed by (call, run, startMs, endMs). Because the inputs are
// immutable stored results and the span builder is deterministic, the same
// key always denotes the same stretch of audio and the same readings -- so
// an adjudication made today still matches the span the UI shows tomorrow.
import { and, desc, eq } from "drizzle-orm";
import { Router, type IRouter } from "express";
import {
  benchmarkAdjudicationsTable,
  benchmarkCallsTable,
  benchmarkProviderCallResultsTable,
  benchmarkRunsTable,
  db,
} from "@workspace/db";
import {
  AdjudicateSpanBody,
  AdjudicateSpanParams,
  AdjudicateSpanResponse,
  ListDisagreementSpansQueryParams,
  ListDisagreementSpansResponse,
} from "@workspace/api-zod";
import { actorFromRequest, writeAudit } from "../lib/audit";
import { buildSpansForCallRun } from "../lib/disagreement-spans";

const router: IRouter = Router();

function spanKey(startMs: number, endMs: number): string {
  return `${startMs}-${endMs}`;
}

function serializeAdjudication(row: typeof benchmarkAdjudicationsTable.$inferSelect) {
  return {
    id: row.id,
    callId: row.callId,
    runId: row.runId,
    spanStartMs: row.spanStartMs,
    spanEndMs: row.spanEndMs,
    correctProviderId: row.correctProviderId,
    readings: row.readings,
    adjudicatedByLabel: row.adjudicatedByLabel,
    adjudicatedAt: row.adjudicatedAt.toISOString(),
  };
}

router.get("/benchmark/disagreement-spans", async (req, res): Promise<void> => {
  const parsed = ListDisagreementSpansQueryParams.safeParse(req.query);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }
  const { callId } = parsed.data;

  const [call] = await db.select({ id: benchmarkCallsTable.id }).from(benchmarkCallsTable).where(eq(benchmarkCallsTable.id, callId)).limit(1);
  if (!call) {
    res.status(404).json({ error: "Benchmark call not found" });
    return;
  }

  let runId: string | null = parsed.data.runId ?? null;
  if (runId) {
    const [run] = await db.select({ id: benchmarkRunsTable.id }).from(benchmarkRunsTable).where(eq(benchmarkRunsTable.id, runId)).limit(1);
    if (!run) {
      res.status(404).json({ error: "Benchmark run not found" });
      return;
    }
  } else {
    // Most recent run with at least one successful cell for this call.
    const [latest] = await db
      .select({ runId: benchmarkProviderCallResultsTable.runId })
      .from(benchmarkProviderCallResultsTable)
      .innerJoin(benchmarkRunsTable, eq(benchmarkRunsTable.id, benchmarkProviderCallResultsTable.runId))
      .where(and(eq(benchmarkProviderCallResultsTable.callId, callId), eq(benchmarkProviderCallResultsTable.status, "ok")))
      .orderBy(desc(benchmarkRunsTable.createdAt))
      .limit(1);
    runId = latest?.runId ?? null;
  }

  if (!runId) {
    res.json(
      ListDisagreementSpansResponse.parse({ callId, runId: null, referenceProviderId: null, referenceWords: [], unavailableReason: "no_run", spans: [] }),
    );
    return;
  }

  const built = await buildSpansForCallRun(callId, runId);

  const adjudications = await db
    .select()
    .from(benchmarkAdjudicationsTable)
    .where(and(eq(benchmarkAdjudicationsTable.callId, callId), eq(benchmarkAdjudicationsTable.runId, runId)));
  const adjudicationByKey = new Map(adjudications.map((a) => [spanKey(a.spanStartMs, a.spanEndMs), a]));

  res.json(
    ListDisagreementSpansResponse.parse({
      callId,
      runId,
      referenceProviderId: built.referenceProviderId,
      referenceWords: built.referenceWords,
      unavailableReason: built.unavailableReason,
      spans: built.spans.map((s) => {
        const adjudication = adjudicationByKey.get(spanKey(s.startMs, s.endMs));
        return {
          startMs: s.startMs,
          endMs: s.endMs,
          contextBefore: s.contextBefore,
          contextAfter: s.contextAfter,
          referencePositions: s.referencePositions,
          readings: s.readings,
          adjudication: adjudication ? serializeAdjudication(adjudication) : null,
        };
      }),
    }),
  );
});

router.post("/benchmark/calls/:callId/adjudications", async (req, res): Promise<void> => {
  const params = AdjudicateSpanParams.safeParse(req.params);
  const body = AdjudicateSpanBody.safeParse(req.body);
  if (!params.success || !body.success) {
    res.status(400).json({ error: (params.success ? body.error : params.error)?.message ?? "Invalid request" });
    return;
  }
  const { callId } = params.data;
  const { runId, spanStartMs, spanEndMs, correctProviderId, readings } = body.data;

  if (!Number.isInteger(spanStartMs) || !Number.isInteger(spanEndMs) || spanStartMs < 0 || spanEndMs < spanStartMs) {
    res.status(400).json({ error: "spanStartMs/spanEndMs must be non-negative integers with start <= end" });
    return;
  }
  // The verdict must name one of the readings the human was actually
  // shown -- a provider id from anywhere else is a UI bug, not a verdict.
  if (correctProviderId !== null && !readings.some((r) => r.providerId === correctProviderId)) {
    res.status(400).json({ error: "correctProviderId must be one of the readings' providerIds (or null for 'none of them')" });
    return;
  }

  const [call] = await db.select({ id: benchmarkCallsTable.id }).from(benchmarkCallsTable).where(eq(benchmarkCallsTable.id, callId)).limit(1);
  if (!call) {
    res.status(404).json({ error: "Benchmark call not found" });
    return;
  }
  const [run] = await db.select({ id: benchmarkRunsTable.id }).from(benchmarkRunsTable).where(eq(benchmarkRunsTable.id, runId)).limit(1);
  if (!run) {
    res.status(404).json({ error: "Benchmark run not found" });
    return;
  }

  const actorLabel = actorFromRequest(req);
  const [previous] = await db
    .select()
    .from(benchmarkAdjudicationsTable)
    .where(
      and(
        eq(benchmarkAdjudicationsTable.callId, callId),
        eq(benchmarkAdjudicationsTable.runId, runId),
        eq(benchmarkAdjudicationsTable.spanStartMs, spanStartMs),
        eq(benchmarkAdjudicationsTable.spanEndMs, spanEndMs),
      ),
    )
    .limit(1);

  const [saved] = await db
    .insert(benchmarkAdjudicationsTable)
    .values({ callId, runId, spanStartMs, spanEndMs, correctProviderId, readings, adjudicatedByLabel: actorLabel })
    .onConflictDoUpdate({
      target: [
        benchmarkAdjudicationsTable.callId,
        benchmarkAdjudicationsTable.runId,
        benchmarkAdjudicationsTable.spanStartMs,
        benchmarkAdjudicationsTable.spanEndMs,
      ],
      set: { correctProviderId, readings, adjudicatedByLabel: actorLabel, adjudicatedAt: new Date() },
    })
    .returning();

  await writeAudit({
    entityType: "adjudication",
    entityId: saved!.id,
    actorLabel,
    action: previous ? "re_adjudicate" : "adjudicate",
    beforeState: previous ? { correctProviderId: previous.correctProviderId, adjudicatedByLabel: previous.adjudicatedByLabel } : null,
    afterState: { callId, runId, spanStartMs, spanEndMs, correctProviderId },
  });

  res.json(AdjudicateSpanResponse.parse(serializeAdjudication(saved!)));
});

export default router;
