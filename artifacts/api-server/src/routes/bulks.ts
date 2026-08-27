import { and, asc, count, countDistinct, desc, eq, inArray } from "drizzle-orm";
import { Router, type IRouter } from "express";
import {
  benchmarkAgentScansTable,
  benchmarkBulksTable,
  benchmarkProviderCallResultsTable,
  benchmarkRunsTable,
  benchmarkScoresTable,
  bulkTemplatesTable,
  db,
  type BenchmarkBulkRow,
  type BenchmarkRunManifest,
  type BenchmarkRunRow,
  type BulkSelectionCriteria,
  type BulkTemplateRow,
} from "@workspace/db";
import {
  CancelBulkParams,
  CancelBulkResponse,
  CreateBulkBody,
  CreateBulkResponse,
  CreateBulkTemplateBody,
  CreateBulkTemplateResponse,
  GetBulkManifestParams,
  GetBulkManifestResponse,
  GetBulkParams,
  GetBulkResponse,
  LaunchBulkParams,
  LaunchBulkResponse,
  LaunchBulkTemplateBody,
  LaunchBulkTemplateParams,
  LaunchBulkTemplateResponse,
  ListBulkTemplatesResponse,
  ListBulksQueryParams,
  ListBulksResponse,
  RetryBulkFailedParams,
  RetryBulkFailedResponse,
} from "@workspace/api-zod";
import { actorFromRequest, writeAudit } from "../lib/audit";
import {
  BulkNameConflictError,
  BulkSelectionEmptyError,
  cancelBulk,
  createBulkFromCriteria,
  isUniqueViolation,
  launchBulk,
  retryBulkFailedCells,
} from "../lib/bulks";

const router: IRouter = Router();

// The generated zod schemas coerce `format: date-time` body fields into Date
// (orval useDates); the jsonb column type stores ISO strings. Convert at the
// request boundary.
function criteriaFromBody(criteria: {
  vertical?: string;
  assistantIds?: string[];
  accountLabel?: string;
  startedAtFrom?: Date | string;
  startedAtTo?: Date | string;
  lastNDays?: number;
  minDurationSeconds?: number;
  callIds?: string[];
}): BulkSelectionCriteria {
  const iso = (value?: Date | string): string | undefined =>
    value === undefined
      ? undefined
      : value instanceof Date
        ? value.toISOString()
        : value;
  return {
    ...criteria,
    startedAtFrom: iso(criteria.startedAtFrom),
    startedAtTo: iso(criteria.startedAtTo),
  };
}

function serializeBulk(bulk: BenchmarkBulkRow) {
  return {
    id: bulk.id,
    name: bulk.name,
    status: bulk.status,
    selectionCriteria: bulk.selectionCriteria,
    providerIds: bulk.providerIds,
    shardSize: bulk.shardSize,
    minDurationSeconds: bulk.minDurationSeconds,
    estimatedCostCents: bulk.estimatedCostCents ?? null,
    estimatedSttCostCents: bulk.estimatedSttCostCents ?? null,
    estimatedAgentCostCents: bulk.estimatedAgentCostCents ?? null,
    launchedByLabel: bulk.launchedByLabel ?? null,
    notes: bulk.notes ?? null,
    createdAt: bulk.createdAt.toISOString(),
    updatedAt: bulk.updatedAt.toISOString(),
    completedAt: bulk.completedAt?.toISOString() ?? null,
  };
}

function serializeTemplate(template: BulkTemplateRow) {
  return {
    id: template.id,
    name: template.name,
    selectionCriteria: template.selectionCriteria,
    providerIds: template.providerIds,
    shardSize: template.shardSize,
    minDurationSeconds: template.minDurationSeconds,
    createdByLabel: template.createdByLabel ?? null,
    createdAt: template.createdAt.toISOString(),
    updatedAt: template.updatedAt.toISOString(),
  };
}

async function loadBulk(bulkId: string): Promise<BenchmarkBulkRow | undefined> {
  const [bulk] = await db
    .select()
    .from(benchmarkBulksTable)
    .where(eq(benchmarkBulksTable.id, bulkId))
    .limit(1);
  return bulk;
}

router.get("/benchmark/bulks", async (req, res): Promise<void> => {
  const parsed = ListBulksQueryParams.safeParse(req.query);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }
  const bulks = parsed.data.status
    ? await db
        .select()
        .from(benchmarkBulksTable)
        .where(eq(benchmarkBulksTable.status, parsed.data.status))
        .orderBy(desc(benchmarkBulksTable.createdAt))
    : await db
        .select()
        .from(benchmarkBulksTable)
        .orderBy(desc(benchmarkBulksTable.createdAt));
  res.json(ListBulksResponse.parse(bulks.map(serializeBulk)));
});

router.post("/benchmark/bulks", async (req, res): Promise<void> => {
  const parsed = CreateBulkBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }
  try {
    const { bulk } = await createBulkFromCriteria({
      name: parsed.data.name,
      criteria: criteriaFromBody(parsed.data.criteria),
      providerIds: parsed.data.providerIds,
      shardSize: parsed.data.shardSize,
      minDurationSeconds: parsed.data.minDurationSeconds,
      confirm: parsed.data.confirm,
      actorLabel: actorFromRequest(req),
    });
    res.status(201).json(CreateBulkResponse.parse(serializeBulk(bulk)));
  } catch (err) {
    if (err instanceof BulkSelectionEmptyError) {
      res.status(400).json({ error: err.message });
      return;
    }
    if (err instanceof BulkNameConflictError) {
      res.status(409).json({ error: err.message });
      return;
    }
    throw err;
  }
});

router.get("/benchmark/bulks/:bulkId", async (req, res): Promise<void> => {
  const params = GetBulkParams.safeParse(req.params);
  if (!params.success) {
    res.status(400).json({ error: params.error.message });
    return;
  }
  const bulk = await loadBulk(params.data.bulkId);
  if (!bulk) {
    res.status(404).json({ error: "Bulk not found" });
    return;
  }

  const runs = await db
    .select()
    .from(benchmarkRunsTable)
    .where(eq(benchmarkRunsTable.bulkId, bulk.id))
    .orderBy(asc(benchmarkRunsTable.shardIndex));

  // FR-EXC-4 / FR-BLK-13: one grouped aggregate query, not a row dump --
  // progress counters must stay cheap at 10k-call bulk sizes.
  const grouped = runs.length
    ? await db
        .select({
          status: benchmarkProviderCallResultsTable.status,
          cells: count(),
          calls: countDistinct(benchmarkProviderCallResultsTable.callId),
        })
        .from(benchmarkProviderCallResultsTable)
        .where(
          inArray(
            benchmarkProviderCallResultsTable.runId,
            runs.map((run) => run.id),
          ),
        )
        .groupBy(benchmarkProviderCallResultsTable.status)
    : [];

  const byStatus = new Map(grouped.map((g) => [g.status, g]));
  const cellsWritten = grouped.reduce((sum, g) => sum + g.cells, 0);
  const callsTotal = bulk.selectionCriteria.resolvedCallIds?.length ?? 0;
  const plannedCells = callsTotal * bulk.providerIds.length;
  const ranStatuses = ["ok", "failed", "cancelled"] as const;

  // callsRun must count each call once even if its cells landed in more than
  // one status (e.g. some providers ok, some cancelled mid-flight) -- summing
  // the per-status distinct counts above double-counts those calls, which is
  // how callsRun could come out higher than callsTotal. Count distinct calls
  // across all ran statuses in a single query instead.
  const [ranCalls] = runs.length
    ? await db
        .select({ calls: countDistinct(benchmarkProviderCallResultsTable.callId) })
        .from(benchmarkProviderCallResultsTable)
        .where(
          and(
            inArray(
              benchmarkProviderCallResultsTable.runId,
              runs.map((run) => run.id),
            ),
            inArray(benchmarkProviderCallResultsTable.status, [...ranStatuses]),
          ),
        )
    : [{ calls: 0 }];

  // 2026-08-27, per Abhishek ("show cost of each run ... separately"): real
  // spend, not the pre-launch estimate. STT cost sums benchmark_scores rows
  // for this bulk's own runs (only "ok" cells ever get a score row). Agent
  // cost sums benchmark_agent_scans rows tagged with this bulk's runIds
  // (set by lib/agent-verify.ts's automatic pass) -- never combined into
  // one number, since they're different budgets to someone deciding
  // whether to keep running this.
  const sttCostRows = runs.length
    ? await db
        .select({ costMicrocents: benchmarkScoresTable.costMicrocents })
        .from(benchmarkScoresTable)
        .innerJoin(benchmarkProviderCallResultsTable, eq(benchmarkProviderCallResultsTable.id, benchmarkScoresTable.resultId))
        .where(inArray(benchmarkProviderCallResultsTable.runId, runs.map((run) => run.id)))
    : [];
  const sttCostMicrocents = sttCostRows.reduce((sum, r) => sum + (r.costMicrocents ?? 0), 0);

  const agentScanRows = runs.length
    ? await db
        .select({
          status: benchmarkAgentScansTable.status,
          judgeCostMicrocents: benchmarkAgentScansTable.judgeCostMicrocents,
        })
        .from(benchmarkAgentScansTable)
        .where(inArray(benchmarkAgentScansTable.runId, runs.map((run) => run.id)))
    : [];
  const agentCostMicrocents = agentScanRows.reduce((sum, r) => sum + (r.judgeCostMicrocents ?? 0), 0);
  const agentCallsChecked = agentScanRows.length;
  const agentCallsFlagged = agentScanRows.filter((r) => r.status === "flagged" || r.status === "error").length;
  const agentCallsJudged = agentScanRows.filter((r) => r.status === "flagged" && r.judgeCostMicrocents !== null).length;

  res.json(
    GetBulkResponse.parse({
      ...serializeBulk(bulk),
      actualCost: {
        sttCostMicrocents,
        agentCostMicrocents,
        agentCallsChecked,
        agentCallsFlagged,
        agentCallsJudged,
      },
      progress: {
        callsTotal,
        callsRun: ranCalls?.calls ?? 0,
        cellsTotal: plannedCells,
        cellsOk: byStatus.get("ok")?.cells ?? 0,
        cellsFailed: byStatus.get("failed")?.cells ?? 0,
        cellsPending: Math.max(0, plannedCells - cellsWritten),
        cellsCancelled: byStatus.get("cancelled")?.cells ?? 0,
        cellsSkippedPendingReview:
          byStatus.get("skipped_pending_review")?.cells ?? 0,
      },
      runs: runs.map((run) => ({
        id: run.id,
        shardIndex: run.shardIndex ?? 0,
        status: run.status,
        callCount: run.callCount,
        createdAt: run.createdAt.toISOString(),
        completedAt: run.completedAt?.toISOString() ?? null,
      })),
    }),
  );
});

router.post("/benchmark/bulks/:bulkId/launch", async (req, res): Promise<void> => {
  const params = LaunchBulkParams.safeParse(req.params);
  if (!params.success) {
    res.status(400).json({ error: params.error.message });
    return;
  }
  const bulk = await loadBulk(params.data.bulkId);
  if (!bulk) {
    res.status(404).json({ error: "Bulk not found" });
    return;
  }
  if (bulk.status !== "draft" && bulk.status !== "awaiting_confirmation") {
    res.status(409).json({ error: `Bulk is ${bulk.status}, not launchable.` });
    return;
  }
  const actorLabel = actorFromRequest(req);
  await launchBulk(bulk.id, actorLabel);
  const refreshed = await loadBulk(bulk.id);
  res
    .status(202)
    .json(LaunchBulkResponse.parse(serializeBulk(refreshed ?? bulk)));
});

router.post("/benchmark/bulks/:bulkId/retry-failed", async (req, res): Promise<void> => {
  const params = RetryBulkFailedParams.safeParse(req.params);
  if (!params.success) {
    res.status(400).json({ error: params.error.message });
    return;
  }
  const bulk = await loadBulk(params.data.bulkId);
  if (!bulk) {
    res.status(404).json({ error: "Bulk not found" });
    return;
  }
  if (bulk.status === "cancelled" || bulk.status === "estimating") {
    res
      .status(409)
      .json({ error: `Bulk is ${bulk.status}; retry-failed does not apply.` });
    return;
  }
  await retryBulkFailedCells(bulk.id, actorFromRequest(req));
  const refreshed = await loadBulk(bulk.id);
  res
    .status(202)
    .json(RetryBulkFailedResponse.parse(serializeBulk(refreshed ?? bulk)));
});

router.post("/benchmark/bulks/:bulkId/cancel", async (req, res): Promise<void> => {
  const params = CancelBulkParams.safeParse(req.params);
  if (!params.success) {
    res.status(400).json({ error: params.error.message });
    return;
  }
  const bulk = await loadBulk(params.data.bulkId);
  if (!bulk) {
    res.status(404).json({ error: "Bulk not found" });
    return;
  }
  if (["complete", "partial", "failed", "cancelled"].includes(bulk.status)) {
    res.status(409).json({ error: `Bulk is already ${bulk.status}.` });
    return;
  }
  await cancelBulk(bulk.id, actorFromRequest(req));
  const refreshed = await loadBulk(bulk.id);
  res.json(CancelBulkResponse.parse(serializeBulk(refreshed ?? bulk)));
});

// FR-BLK-8: the bulk manifest is the composition of its shard runs' frozen
// manifests -- replay evidence per FR-REP1, exportable as JSON.
router.get("/benchmark/bulks/:bulkId/manifest", async (req, res): Promise<void> => {
  const params = GetBulkManifestParams.safeParse(req.params);
  if (!params.success) {
    res.status(400).json({ error: params.error.message });
    return;
  }
  const bulk = await loadBulk(params.data.bulkId);
  if (!bulk) {
    res.status(404).json({ error: "Bulk not found" });
    return;
  }
  const runs = await db
    .select()
    .from(benchmarkRunsTable)
    .where(eq(benchmarkRunsTable.bulkId, bulk.id))
    .orderBy(asc(benchmarkRunsTable.shardIndex));

  res.json(
    GetBulkManifestResponse.parse({
      manifestVersion: 1,
      bulkId: bulk.id,
      name: bulk.name,
      status: bulk.status,
      selectionCriteria: bulk.selectionCriteria,
      providerIds: bulk.providerIds,
      shardSize: bulk.shardSize,
      createdAt: bulk.createdAt.toISOString(),
      runs: runs.map((run: BenchmarkRunRow) => ({
        // Runs created before manifests existed keep a truthful stub rather
        // than a fabricated one.
        ...(run.manifest ?? {
          manifestVersion: 1,
          scoringVersion: "unknown (predates manifests)",
          createdAt: run.createdAt.toISOString(),
          calls: [],
          providers: [],
        }),
        runId: run.id,
        shardIndex: run.shardIndex ?? null,
        runStatus: run.status,
      })),
    }),
  );
});

// --- FR-BLK-9: reusable, named bulk templates -------------------------------

router.get("/benchmark/bulk-templates", async (_req, res): Promise<void> => {
  const templates = await db
    .select()
    .from(bulkTemplatesTable)
    .orderBy(asc(bulkTemplatesTable.name));
  res.json(ListBulkTemplatesResponse.parse(templates.map(serializeTemplate)));
});

router.post("/benchmark/bulk-templates", async (req, res): Promise<void> => {
  const parsed = CreateBulkTemplateBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }
  const actorLabel = actorFromRequest(req);
  let template: BulkTemplateRow;
  try {
    [template] = await db
      .insert(bulkTemplatesTable)
      .values({
        name: parsed.data.name,
        selectionCriteria: criteriaFromBody(parsed.data.criteria),
        providerIds: parsed.data.providerIds,
        shardSize: parsed.data.shardSize ?? 50,
        minDurationSeconds: parsed.data.minDurationSeconds ?? 5,
        createdByLabel: actorLabel,
      })
      .returning();
  } catch (err) {
    if (isUniqueViolation(err)) {
      res
        .status(409)
        .json({ error: `template name "${parsed.data.name}" is already in use` });
      return;
    }
    throw err;
  }
  await writeAudit({
    entityType: "bulk_template",
    entityId: template.id,
    actorLabel,
    action: "create",
    afterState: serializeTemplate(template),
  });
  res
    .status(201)
    .json(CreateBulkTemplateResponse.parse(serializeTemplate(template)));
});

router.post("/benchmark/bulk-templates/:templateId/launch", async (req, res): Promise<void> => {
  const params = LaunchBulkTemplateParams.safeParse(req.params);
  const body = LaunchBulkTemplateBody.safeParse(req.body ?? {});
  if (!params.success || !body.success) {
    res.status(400).json({ error: (params.error ?? body.error)?.message });
    return;
  }
  const [template] = await db
    .select()
    .from(bulkTemplatesTable)
    .where(eq(bulkTemplatesTable.id, params.data.templateId))
    .limit(1);
  if (!template) {
    res.status(404).json({ error: "Bulk template not found" });
    return;
  }

  const now = new Date();
  const dateSlug = now.toISOString().slice(0, 10);
  // Auto name: template + launch date; a second same-day launch gets a time
  // suffix instead of a 409 (names are unique, FR-BLK-2).
  const baseName = body.data.name ?? `${template.name} ${dateSlug}`;

  const actorLabel = actorFromRequest(req);
  const attempt = (name: string) =>
    createBulkFromCriteria({
      name,
      criteria: template.selectionCriteria,
      providerIds: template.providerIds,
      shardSize: template.shardSize,
      minDurationSeconds: template.minDurationSeconds,
      confirm: body.data.confirm,
      actorLabel,
    });

  try {
    let result;
    try {
      result = await attempt(baseName);
    } catch (err) {
      if (err instanceof BulkNameConflictError && !body.data.name) {
        // Millisecond-resolution suffix: two same-second launches must not
        // collide (found by the e2e harness firing two launches back-to-back).
        const timeSlug = now.toISOString().slice(11, 23).replace(/[:.]/g, "");
        result = await attempt(`${baseName} ${timeSlug}`);
      } else {
        throw err;
      }
    }
    await writeAudit({
      entityType: "bulk_template",
      entityId: template.id,
      actorLabel,
      action: "launch",
      afterState: { bulkId: result.bulk.id, bulkName: result.bulk.name },
    });
    res
      .status(201)
      .json(LaunchBulkTemplateResponse.parse(serializeBulk(result.bulk)));
  } catch (err) {
    if (err instanceof BulkSelectionEmptyError) {
      res.status(400).json({ error: err.message });
      return;
    }
    if (err instanceof BulkNameConflictError) {
      res.status(409).json({ error: err.message });
      return;
    }
    throw err;
  }
});

export default router;
