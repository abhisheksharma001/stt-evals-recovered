import {
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  uuid,
} from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";
import { benchmarkBulksTable } from "./benchmark-bulks";

// RUN-01 / P2-T1: immutable snapshot of exactly what the run was executed
// against, written once at run creation and never mutated. Editing a call's
// gold transcript afterwards changes nothing here -- that is what makes a
// run replayable/auditable (FR-REP1). A bulk's manifest (FR-BLK-8) is just
// the composition of its shard runs' manifests.
export type BenchmarkRunManifest = {
  manifestVersion: 1;
  scoringVersion: string;
  createdAt: string;
  calls: Array<{
    id: string;
    label: string;
    goldTranscriptSha256: string | null;
  }>;
  providers: Array<{
    id: string;
    name: string;
    model: string;
    configSha256: string;
  }>;
};

export const benchmarkRunsTable = pgTable("benchmark_runs", {
  id: uuid("id").primaryKey().defaultRandom(),
  status: text("status").notNull().default("queued"),
  providerIds: text("provider_ids").array().notNull(),
  callIds: text("call_ids").array().notNull(),
  callCount: integer("call_count").notNull(),
  // "batch" = a real comparable run from the Runs page (what Rankings/Runs
  // shows). "agent_scan" = the single-call, single-purpose re-transcription
  // spawned by the transcript-quality agent (routes/agent.ts) to gather
  // candidates for a flagged call. Added 2026-08-25 so an agent scan can
  // reuse the exact same run-executor/scoring pipeline without silently
  // polluting the real Rankings/Runs views with a 1-call snapshot -- the
  // same class of bug found and manually cleaned up earlier the same day
  // (see docs/backlog/good-to-have.md), fixed properly here instead of
  // relying on remembering to clean up after every scan.
  purpose: text("purpose").notNull().default("batch"),
  // Bulk lineage (FR-BLK-3/FR-BLK-13): null for ad-hoc Runs-page runs, set
  // for shard runs fanned out from a bulk. onDelete cascade is what makes
  // FR-BLK-10 bulk eviction a thin-wrapper delete -- the bulk's own runs,
  // results, and scores go with it; benchmark_calls (irreplaceable human
  // gold work) is never touched.
  bulkId: uuid("bulk_id").references(() => benchmarkBulksTable.id, {
    onDelete: "cascade",
  }),
  shardIndex: integer("shard_index"),
  manifest: jsonb("manifest").$type<BenchmarkRunManifest>(),
  // T-134: soft archive for ad-hoc runs (bulkId null) ONLY -- the route
  // guards this. A bad or test run could previously only be removed with a
  // direct DB delete (docs/backlog/good-to-have.md "no delete/archive
  // endpoint"). Archiving hides the run from the default Runs list and
  // stops it being any group's "latest" ranking snapshot; nothing is
  // deleted and unarchiving restores everything. Bulk shard runs are
  // managed through their bulk (FR-BLK-10 eviction), never here.
  archivedAt: timestamp("archived_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
  completedAt: timestamp("completed_at", { withTimezone: true }),
  notes: text("notes"),
});

export const insertBenchmarkRunSchema = createInsertSchema(
  benchmarkRunsTable,
).omit({ id: true, createdAt: true, completedAt: true });

export type InsertBenchmarkRun = z.infer<typeof insertBenchmarkRunSchema>;
export type BenchmarkRunRow = typeof benchmarkRunsTable.$inferSelect;