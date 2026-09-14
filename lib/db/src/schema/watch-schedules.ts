import {
  boolean,
  integer,
  pgTable,
  text,
  timestamp,
  uuid,
} from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";
import { bulkTemplatesTable } from "./bulk-templates";

// W-2 (PRD v8 Part A): the policy row. A bulk template already says WHICH
// calls and WHICH providers; nothing anywhere says "for this org, this agent,
// this many calls a day, and never more than this much money". This table is
// that missing sentence, one row per org-or-agent policy.
//
// It launches nothing on its own. W-5 adds the ledger and the tick that reads
// these rows; until then a schedule is inert data, which is deliberate -- a
// row that could start spending the moment it was saved would make W-2 a
// money step instead of a schema step.
//
// `assistantId` NULL means "every agent on this account", sampled per agent
// rather than pooled, so a quiet agent is not drowned out by a busy one.
//
// The caps are stored in CENTS as integers, never as dollars in a float: a
// spend ceiling that drifts by a rounding error is not a ceiling. They are
// stored here and enforced by the tick (W-5), not by this table -- a column
// cannot refuse a run.
//
// `accountId` is a Vapi account id from `listVapiAccounts()`, which derives
// its ids from env-var NAMES (`VAPI_API_KEY_<LABEL>` -> `<label>`). The id is
// the only part that is ever stored: no key, no key prefix, no fingerprint.
export const watchSchedulesTable = pgTable("watch_schedules", {
  id: uuid("id").primaryKey().defaultRandom(),
  templateId: uuid("template_id")
    .notNull()
    .references(() => bulkTemplatesTable.id),
  accountId: text("account_id").notNull(),
  // Plain text with the enum enforced at the API boundary, exactly as
  // `benchmark_calls.vertical` does it. The import needs it.
  vertical: text("vertical").notNull(),
  assistantId: text("assistant_id"),
  sampleSize: integer("sample_size").notNull().default(10),
  dailyCapCents: integer("daily_cap_cents").notNull().default(100),
  monthlyCapCents: integer("monthly_cap_cents").notNull().default(3000),
  // Hour of the local day the tick should fire at, 0..23.
  hourLocal: integer("hour_local").notNull().default(3),
  enabled: boolean("enabled").notNull().default(true),
  createdByLabel: text("created_by_label"),
  createdAt: timestamp("created_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true })
    .notNull()
    .defaultNow()
    .$onUpdate(() => new Date()),
});

export const insertWatchScheduleSchema = createInsertSchema(
  watchSchedulesTable,
).omit({ id: true, createdAt: true, updatedAt: true });

export type InsertWatchSchedule = z.infer<typeof insertWatchScheduleSchema>;
export type WatchScheduleRow = typeof watchSchedulesTable.$inferSelect;
