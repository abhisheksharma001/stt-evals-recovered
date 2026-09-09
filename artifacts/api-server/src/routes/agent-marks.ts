// U-1: the marks a human makes while reading results.
//
// Asked for 2026-09-09 ("once we go into the result, we should be able to do
// it from there ... mark what things we need to do or update the agent
// with"). Two capture points, one record: a disputed span inside the per-call
// comparison, and an assistant's card on the Results page.
//
// Nothing in this file talks to Vapi. A mark is a PROPOSAL -- the same
// posture the rest of the project takes toward machine output (draft != gold)
// applied to human intent. U-2 computes what the open marks WOULD change and
// U-3, behind its own go-ahead, is the only code that ever writes to a live
// assistant. That is also why `status: "applied"` is unreachable from here:
// only something that actually wrote may claim a mark was applied.
import { and, desc, eq, isNull } from "drizzle-orm";
import { Router, type IRouter } from "express";
import { agentMarksTable, benchmarkCallsTable, db, type AgentMarkRow } from "@workspace/db";
import {
  CreateAgentMarkBody,
  CreateAgentMarkResponse,
  DeleteAgentMarkParams,
  ListAgentMarksQueryParams,
  ListAgentMarksResponse,
  UpdateAgentMarkBody,
  UpdateAgentMarkParams,
  UpdateAgentMarkResponse,
} from "@workspace/api-zod";
import { actorFromRequest, writeAudit } from "../lib/audit";
import { respondInvalid } from "../lib/validation-error";
import { respondJson } from "../lib/respond";
import type { ZodInput } from "@workspace/api-zod";

const router: IRouter = Router();

// A mark on a call that carries no assistant id is a real note with no agent
// to apply it to (the Results page's own "no assistant on file" bucket), so
// the filter needs a way to ask for exactly those. Same shape as T-96's
// `__no_org__` on the Calls page, so "no label" keeps meaning one thing.
const UNASSIGNED = "__unassigned__";

// T-153: the return type is the contract's own input shape, so a field the
// contract requires cannot be dropped here without failing tsc.
function serializeMark(mark: AgentMarkRow): ZodInput<typeof CreateAgentMarkResponse> {
  return {
    id: mark.id,
    assistantId: mark.assistantId,
    callId: mark.callId,
    span: mark.span,
    note: mark.note,
    actionType: mark.actionType,
    actionValue: mark.actionValue,
    status: mark.status,
    createdByLabel: mark.createdByLabel,
    createdAt: mark.createdAt.toISOString(),
    updatedAt: mark.updatedAt.toISOString(),
  };
}

/** The two rules the contract cannot express, both about the action pair.
 *  Returns a sentence for a 400, or null when the pair is coherent. */
function actionPairProblem(actionType: string | null | undefined, actionValue: string | null | undefined): string | null {
  const value = actionValue?.trim() || null;
  if (actionType === "numerals" && value !== null) {
    return "A numerals mark carries no value -- numerals is a per-assistant on/off setting. Send actionValue as null.";
  }
  if ((actionType === "keyterm" || actionType === "prompt") && value === null) {
    return `A ${actionType} mark needs an actionValue: the term to boost, or the prompt change in words.`;
  }
  return null;
}

router.get("/benchmark/agent-marks", async (req, res): Promise<void> => {
  const parsed = ListAgentMarksQueryParams.safeParse(req.query);
  if (!parsed.success) {
    respondInvalid(res, parsed.error);
    return;
  }
  const { assistantId, callId, status } = parsed.data;

  const filters = [
    assistantId === UNASSIGNED
      ? isNull(agentMarksTable.assistantId)
      : assistantId
        ? eq(agentMarksTable.assistantId, assistantId)
        : undefined,
    callId ? eq(agentMarksTable.callId, callId) : undefined,
    status ? eq(agentMarksTable.status, status) : undefined,
  ].filter((f) => f !== undefined);

  const rows = await db
    .select()
    .from(agentMarksTable)
    .where(filters.length > 0 ? and(...filters) : undefined)
    .orderBy(desc(agentMarksTable.createdAt));

  respondJson(res, ListAgentMarksResponse, rows.map(serializeMark));
});

router.post("/benchmark/agent-marks", async (req, res): Promise<void> => {
  const parsed = CreateAgentMarkBody.safeParse(req.body);
  if (!parsed.success) {
    respondInvalid(res, parsed.error);
    return;
  }
  const body = parsed.data;

  // The contract's `minLength: 1` rejects "" but not "   ", and a mark whose
  // whole content is whitespace is the one thing this feature must not store.
  const note = body.note.trim();
  if (note.length === 0) {
    res.status(400).json({ error: "A mark needs a note -- that is the part that survives; the action is optional." });
    return;
  }

  const problem = actionPairProblem(body.actionType, body.actionValue);
  if (problem) {
    res.status(400).json({ error: problem });
    return;
  }

  // U-1b: the basket key is derived here rather than sent, because the
  // surface that captures a span-mark cannot know it. `CallComparison` (the
  // per-call view holding the judge's disputed spans) carries no assistant
  // id at all, so a client marking a span would have to guess -- and a mark
  // filed under the wrong assistant is worse than one filed under none. An
  // explicitly sent assistantId still wins; this only fills a gap.
  let assistantId = body.assistantId ?? null;
  if (body.callId) {
    const [call] = await db
      .select({ id: benchmarkCallsTable.id, sourceAssistantId: benchmarkCallsTable.sourceAssistantId })
      .from(benchmarkCallsTable)
      .where(eq(benchmarkCallsTable.id, body.callId))
      .limit(1);
    if (!call) {
      res.status(404).json({ error: "Benchmark call not found" });
      return;
    }
    // Still null when the call was imported without one -- the "no assistant
    // on file" bucket is a real answer, not a failure to look.
    if (assistantId === null) assistantId = call.sourceAssistantId;
  }

  const actorLabel = actorFromRequest(req);
  const [mark] = await db
    .insert(agentMarksTable)
    .values({
      assistantId,
      callId: body.callId ?? null,
      span: body.span?.trim() || null,
      note,
      actionType: body.actionType ?? null,
      actionValue: body.actionValue?.trim() || null,
      createdByLabel: body.createdByLabel?.trim() || actorLabel,
    })
    .returning();

  await writeAudit({
    entityType: "agent_mark",
    entityId: mark.id,
    actorLabel,
    action: "create",
    afterState: serializeMark(mark),
  });

  respondJson(res, CreateAgentMarkResponse, serializeMark(mark), 201);
});

router.patch("/benchmark/agent-marks/:markId", async (req, res): Promise<void> => {
  const parsedParams = UpdateAgentMarkParams.safeParse(req.params);
  if (!parsedParams.success) {
    respondInvalid(res, parsedParams.error);
    return;
  }
  const parsed = UpdateAgentMarkBody.safeParse(req.body);
  if (!parsed.success) {
    respondInvalid(res, parsed.error);
    return;
  }
  const body = parsed.data;

  const [before] = await db
    .select()
    .from(agentMarksTable)
    .where(eq(agentMarksTable.id, parsedParams.data.markId))
    .limit(1);
  if (!before) {
    res.status(404).json({ error: "Agent mark not found" });
    return;
  }

  const note = body.note === undefined ? before.note : body.note.trim();
  if (note.length === 0) {
    res.status(400).json({ error: "A mark needs a note -- that is the part that survives; the action is optional." });
    return;
  }

  // Validate the pair the row will END UP with, not the half that was sent:
  // clearing actionValue on an existing keyterm mark is just as broken as
  // creating one without it.
  const actionType = body.actionType === undefined ? before.actionType : body.actionType;
  const actionValue = body.actionValue === undefined ? before.actionValue : (body.actionValue?.trim() || null);
  const problem = actionPairProblem(actionType, actionValue);
  if (problem) {
    res.status(400).json({ error: problem });
    return;
  }

  const actorLabel = actorFromRequest(req);
  const [mark] = await db
    .update(agentMarksTable)
    .set({ note, actionType, actionValue, ...(body.status === undefined ? {} : { status: body.status }) })
    .where(eq(agentMarksTable.id, before.id))
    .returning();

  await writeAudit({
    entityType: "agent_mark",
    entityId: mark.id,
    actorLabel,
    action: "update",
    beforeState: serializeMark(before),
    afterState: serializeMark(mark),
  });

  respondJson(res, UpdateAgentMarkResponse, serializeMark(mark));
});

router.delete("/benchmark/agent-marks/:markId", async (req, res): Promise<void> => {
  const parsedParams = DeleteAgentMarkParams.safeParse(req.params);
  if (!parsedParams.success) {
    respondInvalid(res, parsedParams.error);
    return;
  }

  const [deleted] = await db
    .delete(agentMarksTable)
    .where(eq(agentMarksTable.id, parsedParams.data.markId))
    .returning();
  if (!deleted) {
    res.status(404).json({ error: "Agent mark not found" });
    return;
  }

  await writeAudit({
    entityType: "agent_mark",
    entityId: deleted.id,
    actorLabel: actorFromRequest(req),
    action: "delete",
    beforeState: serializeMark(deleted),
  });

  res.status(204).end();
});

export default router;
