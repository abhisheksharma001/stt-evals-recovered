// W-2 (PRD v8 Part A): CRUD for the watch schedule -- the policy row that
// says "for this org, this agent, this many calls a day, and never past this
// much money".
//
// Nothing in this file launches anything. A schedule is inert data until the
// W-5 tick reads it, and that is the whole point of shipping it alone: a row
// that could start spending the moment it was saved would make this a money
// step instead of a schema step. `POST /benchmark/bulks` executes the run it
// creates fire-and-forget; nothing here goes near it.
//
// Two things are refused at the boundary rather than trusted:
//
//   * an `accountId` that is not a configured Vapi account. The error names
//     the known ids and nothing else -- an account id is derived from an
//     env-var NAME, so naming ids leaks a name, while a key, a prefix or a
//     fingerprint would leak the secret itself.
//   * a `templateId` with no template behind it. The FK would refuse it too,
//     but as a 500 with a constraint name in it; a caller deserves the
//     sentence, not the constraint.
import { asc, eq } from "drizzle-orm";
import { Router, type IRouter } from "express";
import {
  bulkTemplatesTable,
  db,
  watchSchedulesTable,
  type WatchScheduleRow,
} from "@workspace/db";
import {
  CreateWatchScheduleBody,
  CreateWatchScheduleResponse,
  ListWatchSchedulesResponse,
  UpdateWatchScheduleBody,
  UpdateWatchScheduleParams,
  UpdateWatchScheduleResponse,
} from "@workspace/api-zod";
import type { ZodInput } from "@workspace/api-zod";
import { actorFromRequest, writeAudit } from "../lib/audit";
import { listVapiAccounts } from "../lib/vapi";
import { respondInvalid } from "../lib/validation-error";
import { respondJson } from "../lib/respond";

const router: IRouter = Router();

function serializeSchedule(row: WatchScheduleRow): ZodInput<typeof CreateWatchScheduleResponse> {
  return {
    id: row.id,
    templateId: row.templateId,
    accountId: row.accountId,
    // Unconstrained text column; the enum is held by the request parse above
    // and by this response parse, the same way benchmark_calls.vertical works.
    vertical: row.vertical as ZodInput<typeof CreateWatchScheduleResponse>["vertical"],
    assistantId: row.assistantId ?? null,
    sampleSize: row.sampleSize,
    dailyCapCents: row.dailyCapCents,
    monthlyCapCents: row.monthlyCapCents,
    hourLocal: row.hourLocal,
    enabled: row.enabled,
    createdByLabel: row.createdByLabel ?? null,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

/** The known-account check. Returns the sentence to send back, or null when
 *  the id is fine. Ids only -- never a key, a prefix or a fingerprint. */
function unknownAccountProblem(accountId: string): string | null {
  const known = listVapiAccounts().map((a) => a.id);
  if (known.includes(accountId)) return null;
  return known.length === 0
    ? `No Vapi accounts are configured, so "${accountId}" cannot be one. Set VAPI_API_KEY (or VAPI_API_KEY_<LABEL>) on the API server and restart it.`
    : `Unknown Vapi account "${accountId}". Configured accounts: ${known.join(", ")}.`;
}

router.get("/benchmark/watch-schedules", async (_req, res): Promise<void> => {
  const rows = await db
    .select()
    .from(watchSchedulesTable)
    .orderBy(asc(watchSchedulesTable.createdAt));
  respondJson(res, ListWatchSchedulesResponse, rows.map(serializeSchedule));
});

router.post("/benchmark/watch-schedules", async (req, res): Promise<void> => {
  const parsed = CreateWatchScheduleBody.safeParse(req.body);
  if (!parsed.success) {
    respondInvalid(res, parsed.error);
    return;
  }
  const body = parsed.data;

  const accountProblem = unknownAccountProblem(body.accountId);
  if (accountProblem) {
    res.status(400).json({ error: accountProblem });
    return;
  }

  const [template] = await db
    .select({ id: bulkTemplatesTable.id })
    .from(bulkTemplatesTable)
    .where(eq(bulkTemplatesTable.id, body.templateId))
    .limit(1);
  if (!template) {
    res.status(400).json({ error: `Bulk template ${body.templateId} does not exist.` });
    return;
  }

  const actorLabel = actorFromRequest(req);
  const [schedule] = await db
    .insert(watchSchedulesTable)
    .values({
      templateId: body.templateId,
      accountId: body.accountId,
      vertical: body.vertical,
      assistantId: body.assistantId ?? null,
      // The defaults live on the column; naming them here too would give the
      // row two sources of truth that can drift.
      ...(body.sampleSize === undefined ? {} : { sampleSize: body.sampleSize }),
      ...(body.dailyCapCents === undefined ? {} : { dailyCapCents: body.dailyCapCents }),
      ...(body.monthlyCapCents === undefined ? {} : { monthlyCapCents: body.monthlyCapCents }),
      ...(body.hourLocal === undefined ? {} : { hourLocal: body.hourLocal }),
      ...(body.enabled === undefined ? {} : { enabled: body.enabled }),
      createdByLabel: actorLabel,
    })
    .returning();

  await writeAudit({
    entityType: "watch_schedule",
    entityId: schedule.id,
    actorLabel,
    action: "create",
    afterState: serializeSchedule(schedule),
  });
  respondJson(res, CreateWatchScheduleResponse, serializeSchedule(schedule), 201);
});

router.patch("/benchmark/watch-schedules/:scheduleId", async (req, res): Promise<void> => {
  const params = UpdateWatchScheduleParams.safeParse(req.params);
  if (!params.success) {
    respondInvalid(res, params.error);
    return;
  }
  const parsed = UpdateWatchScheduleBody.safeParse(req.body);
  if (!parsed.success) {
    respondInvalid(res, parsed.error);
    return;
  }
  const body = parsed.data;

  const [before] = await db
    .select()
    .from(watchSchedulesTable)
    .where(eq(watchSchedulesTable.id, params.data.scheduleId))
    .limit(1);
  if (!before) {
    res.status(404).json({ error: "Watch schedule not found" });
    return;
  }

  if (body.accountId !== undefined) {
    const accountProblem = unknownAccountProblem(body.accountId);
    if (accountProblem) {
      res.status(400).json({ error: accountProblem });
      return;
    }
  }

  const actorLabel = actorFromRequest(req);
  const [schedule] = await db
    .update(watchSchedulesTable)
    .set({
      ...(body.accountId === undefined ? {} : { accountId: body.accountId }),
      ...(body.vertical === undefined ? {} : { vertical: body.vertical }),
      // `assistantId: null` is a real instruction -- "widen this back to every
      // agent on the account" -- so it is kept apart from "field not sent".
      ...(body.assistantId === undefined ? {} : { assistantId: body.assistantId }),
      ...(body.sampleSize === undefined ? {} : { sampleSize: body.sampleSize }),
      ...(body.dailyCapCents === undefined ? {} : { dailyCapCents: body.dailyCapCents }),
      ...(body.monthlyCapCents === undefined ? {} : { monthlyCapCents: body.monthlyCapCents }),
      ...(body.hourLocal === undefined ? {} : { hourLocal: body.hourLocal }),
      ...(body.enabled === undefined ? {} : { enabled: body.enabled }),
    })
    .where(eq(watchSchedulesTable.id, before.id))
    .returning();

  await writeAudit({
    entityType: "watch_schedule",
    entityId: schedule.id,
    actorLabel,
    action: "update",
    beforeState: serializeSchedule(before),
    afterState: serializeSchedule(schedule),
  });
  respondJson(res, UpdateWatchScheduleResponse, serializeSchedule(schedule));
});

export default router;
