import type { Request } from "express";
import { auditLogTable, db } from "@workspace/db";

// NFR-5: all state transitions on calls/runs/providers are append-only
// audit records. There's no auth system yet, so the actor comes from a
// plain `x-actor` header (email or name) -- this is a stopgap, not RBAC.
// Swap `actorLabel` for a real users.id FK once auth is built.
export function actorFromRequest(req: Request): string {
  const header = req.header("x-actor");
  return header?.trim() || "unknown";
}

/** R-24a: anything that can insert -- `db`, or a transaction handed in so the
 *  audit row lands (or rolls back) with the change it records. */
export type AuditExecutor = Pick<typeof db, "insert">;

export async function writeAudit(
  entry: {
    entityType: string;
    entityId: string;
    actorLabel: string;
    action: string;
    beforeState?: unknown;
    afterState?: unknown;
  },
  executor: AuditExecutor = db,
): Promise<void> {
  await executor.insert(auditLogTable).values({
    entityType: entry.entityType,
    entityId: entry.entityId,
    actorLabel: entry.actorLabel,
    action: entry.action,
    beforeState: entry.beforeState ?? null,
    afterState: entry.afterState ?? null,
  });
}
