import {
  boolean,
  pgTable,
  real,
  text,
  timestamp,
} from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";

export const benchmarkProvidersTable = pgTable("benchmark_providers", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  model: text("model").notNull(),
  status: text("status").notNull().default("not_configured"),
  supportsStreaming: boolean("supports_streaming").notNull().default(false),
  supportsDiarization: boolean("supports_diarization").notNull().default(false),
  costPerMinute: real("cost_per_minute").notNull().default(0),
  keywordBoosting: boolean("keyword_boosting").notNull().default(false),
  configNote: text("config_note"),
  // Operator override (FR-P3): true forces status to "disabled" regardless
  // of whether an adapter/API key is present. `status` itself is otherwise
  // derived, not directly writable -- see syncProviderReadiness().
  manuallyDisabled: boolean("manually_disabled").notNull().default(false),
  createdAt: timestamp("created_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true })
    .notNull()
    .defaultNow()
    .$onUpdate(() => new Date()),
});

export const insertBenchmarkProviderSchema = createInsertSchema(
  benchmarkProvidersTable,
).omit({ createdAt: true, updatedAt: true });

export type InsertBenchmarkProvider = z.infer<
  typeof insertBenchmarkProviderSchema
>;
export type BenchmarkProviderRow =
  typeof benchmarkProvidersTable.$inferSelect;