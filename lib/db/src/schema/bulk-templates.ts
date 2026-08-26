import {
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";
import type { BulkSelectionCriteria } from "./benchmark-bulks";

// FR-BLK-9: a named, reusable selection -- "the same slice, run weekly"
// without re-entering every filter by hand. Unlike a bulk, a template's
// criteria are deliberately UNFROZEN: a relative window (`lastNDays: 7`)
// is re-resolved against launch time on every POST /bulk-templates/:id/launch,
// so two launches on different days select different concrete date ranges
// (AC-2.7). The bulk created from it freezes its own copy as usual.
export const bulkTemplatesTable = pgTable(
  "bulk_templates",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    name: text("name").notNull(),
    selectionCriteria: jsonb("selection_criteria")
      .$type<BulkSelectionCriteria>()
      .notNull(),
    providerIds: text("provider_ids").array().notNull(),
    shardSize: integer("shard_size").notNull().default(50),
    minDurationSeconds: integer("min_duration_seconds").notNull().default(5),
    createdByLabel: text("created_by_label"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
  },
  (table) => [uniqueIndex("bulk_templates_name_unique").on(table.name)],
);

export const insertBulkTemplateSchema = createInsertSchema(
  bulkTemplatesTable,
).omit({ id: true, createdAt: true, updatedAt: true });

export type InsertBulkTemplate = z.infer<typeof insertBulkTemplateSchema>;
export type BulkTemplateRow = typeof bulkTemplatesTable.$inferSelect;
