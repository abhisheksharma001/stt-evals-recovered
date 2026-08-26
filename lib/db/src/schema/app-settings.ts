import { pgTable, text, timestamp } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";
import { benchmarkProvidersTable } from "./benchmark-providers";

// Single-row settings table (id is always the literal "default" -- there is
// exactly one operator today, same OD-11 assumption benchmark_bulks' name
// uniqueness already relies on). Added 2026-08-26 per Abhishek's request:
// a system-wide, changeable choice of (a) which provider is "the" one real
// production calls actually use, separate from picking providers to
// benchmark in a bulk run, and (b) which OpenAI model powers the
// transcript-quality agent's judge pass (lib/agent.ts's JUDGE_MODEL).
// Both null = fall back to the hardcoded defaults (no active provider
// designated; JUDGE_MODEL's own constant).
export const appSettingsTable = pgTable("app_settings", {
  id: text("id").primaryKey().default("default"),
  activeProviderId: text("active_provider_id").references(
    () => benchmarkProvidersTable.id,
  ),
  agentModel: text("agent_model"),
  updatedAt: timestamp("updated_at", { withTimezone: true })
    .notNull()
    .defaultNow()
    .$onUpdate(() => new Date()),
});

export const insertAppSettingsSchema = createInsertSchema(
  appSettingsTable,
).omit({ updatedAt: true });

export type InsertAppSettings = z.infer<typeof insertAppSettingsSchema>;
export type AppSettingsRow = typeof appSettingsTable.$inferSelect;

export const APP_SETTINGS_ID = "default";
