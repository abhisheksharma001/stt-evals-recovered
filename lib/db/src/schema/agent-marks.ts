import { pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";
import { benchmarkCallsTable } from "./benchmark-calls";

/** U-1: what a mark proposes doing to the assistant, when it proposes
 *  anything at all. Null is the common case and deliberately so -- the
 *  error-analysis method this follows is open-ended notes first, categories
 *  afterwards (Part U's evidence note), so forcing a type at capture time
 *  would invent a taxonomy before anyone has read enough calls to have one. */
export type AgentMarkActionType = "keyterm" | "numerals" | "prompt";
export type AgentMarkStatus = "open" | "applied" | "dismissed";

// A mark is a human note, written where the problem is visible -- on a
// disputed span inside the per-call comparison, or on an assistant's card on
// the Results page. Asked for 2026-09-09 ("once we go into the result, we
// should be able to do it from there ... mark what things we need to do or
// update the agent with").
//
// A mark is a PROPOSAL and never more than that, the same posture the rest
// of this project takes toward machine output (draft != gold). Nothing here
// reaches Vapi: U-2 computes what these marks WOULD change and U-3, behind
// its own go-ahead, is the only thing that ever writes.
export const agentMarksTable = pgTable("agent_marks", {
  id: uuid("id").primaryKey().defaultRandom(),
  // The basket key. Null is real, not a defect: calls imported without a
  // `source_assistant_id` are the Results page's own "no assistant on file"
  // bucket, and a mark on one of those is a note with no agent to apply it
  // to. It is still worth keeping -- it is a to-do.
  assistantId: text("assistant_id"),
  // Set when the mark was made from a call comparison, null when made from
  // the assistant's card. `set null`, NOT the `cascade` that
  // benchmark_agent_scans uses on the same column: a scan is about a call
  // and dies with it, a mark is about the AGENT and outlives the call that
  // prompted it.
  callId: uuid("call_id").references(() => benchmarkCallsTable.id, { onDelete: "set null" }),
  // The disputed span the mark came from, copied at mark time. Copied rather
  // than referenced because the judge's key differences are not stored as
  // addressable rows -- they are a jsonb array on the scan.
  span: text("span"),
  // Always required. This is the whole point of the feature; the typed
  // action below is the optional extra.
  note: text("note").notNull(),
  actionType: text("action_type").$type<AgentMarkActionType | null>(),
  // The term to boost, or the prompt change in words. Must be null when
  // actionType is "numerals" -- that one is a per-assistant boolean and has
  // no value to carry (enforced in the route, which is where a 400 can be
  // explained).
  actionValue: text("action_value"),
  status: text("status").$type<AgentMarkStatus>().notNull().default("open"),
  // Same free-text `x-actor` header convention as audit_log; there is still
  // no auth system to hang a FK on.
  createdByLabel: text("created_by_label"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true })
    .notNull()
    .defaultNow()
    .$onUpdate(() => new Date()),
});

export const insertAgentMarkSchema = createInsertSchema(agentMarksTable).omit({
  id: true,
  createdAt: true,
  updatedAt: true,
});

export type InsertAgentMark = z.infer<typeof insertAgentMarkSchema>;
export type AgentMarkRow = typeof agentMarksTable.$inferSelect;
