// T-08 / T-86: disagreement spans, listen-only.
//
// One endpoint. GET builds the disagreement spans for one call from the
// stored provider results of one run. Nothing is persisted: spans are a
// pure function of results that never change, so the same (call, run)
// always yields the same stretches of audio and the same readings.
//
// There is no human verdict on a span any more (T-86): the product has no
// human judge. A person flags a whole call (hard case, notes) in Corpus;
// the words themselves are reported per assistant by lib/words-to-watch.ts.
import { and, desc, eq } from "drizzle-orm";
import { Router, type IRouter } from "express";
import { benchmarkCallsTable, benchmarkProviderCallResultsTable, benchmarkRunsTable, db } from "@workspace/db";
import { ListDisagreementSpansQueryParams, ListDisagreementSpansResponse } from "@workspace/api-zod";
import { buildSpansForCallRun } from "../lib/disagreement-spans";

const router: IRouter = Router();

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
  res.json(
    ListDisagreementSpansResponse.parse({
      callId,
      runId,
      referenceProviderId: built.referenceProviderId,
      referenceWords: built.referenceWords,
      unavailableReason: built.unavailableReason,
      // T-136: every field the schema requires, listed once. This mapping
      // dropped `majorityText` between T-47 (which made it required) and the
      // T-86 route rewrite, so the response failed its own zod parse and the
      // endpoint answered 500 for every call -- the whole "hear where they
      // disagree" panel was dead on Corpus. A route test now covers it.
      spans: built.spans.map((s) => ({
        startMs: s.startMs,
        endMs: s.endMs,
        majorityText: s.majorityText,
        contextBefore: s.contextBefore,
        contextAfter: s.contextAfter,
        referencePositions: s.referencePositions,
        readings: s.readings,
      })),
    }),
  );
});

export default router;
