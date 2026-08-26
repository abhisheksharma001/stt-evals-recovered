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

export async function writeAudit(entry: {
  entityType: string;
  entityId: string;
  actorLabel: string;
  action: string;
  beforeState?: unknown;
  afterState?: unknown;
}): Promise<void> {
  await db.insert(auditLogTable).values({
    entityType: entry.entityType,
    entityId: entry.entityId,
    actorLabel: entry.actorLabel,
    action: entry.action,
    beforeState: entry.beforeState ?? null,
    afterState: entry.afterState ?? null,
  });
}
