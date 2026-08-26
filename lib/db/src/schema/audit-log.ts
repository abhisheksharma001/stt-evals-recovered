import { jsonb, pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";

// NFR-5: all state transitions on calls/runs/providers are append-only
// audit records. There is no auth system yet (tracked separately) so the
// actor is a free-text label taken from the `x-actor` request header rather
// than a users.id FK -- swap to a real FK once auth lands.
export const auditLogTable = pgTable("audit_log", {
  id: uuid("id").primaryKey().defaultRandom(),
  entityType: text("entity_type").notNull(), // "call" | "provider" | "run" | "result"
  entityId: text("entity_id").notNull(),
  actorLabel: text("actor_label").notNull().default("unknown"),
  action: text("action").notNull(),
  beforeState: jsonb("before_state"),
  afterState: jsonb("after_state"),
  occurredAt: timestamp("occurred_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
});

export const insertAuditLogSchema = createInsertSchema(auditLogTable).omit({
  id: true,
  occurredAt: true,
});

export type InsertAuditLog = z.infer<typeof insertAuditLogSchema>;
export type AuditLogRow = typeof auditLogTable.$inferSelect;
