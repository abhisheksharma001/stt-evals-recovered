import { Router, type IRouter } from "express";
import { HealthCheckResponse } from "@workspace/api-zod";
import { providerRegistry } from "@workspace/stt-providers";
import { pool } from "@workspace/db";
import { buildAt, buildCommitSha, startedAt } from "../lib/build-info";
import { probeDatabase } from "../lib/db-probe";
import { respondJson } from "../lib/respond";

const router: IRouter = Router();

/**
 * T-04 (2026-08-28): the health check now identifies the running build.
 *
 * SECURITY, and this is not negotiable: `providersConfigured` reports
 * provider NAMES only -- the adapter ids, exactly as they appear in
 * benchmark_providers. It reports whether an env var is non-empty and
 * NEVER the value, never a prefix, never a length. This endpoint is
 * unauthenticated; anything it returns is public. Adding a field here
 * means deciding it is safe for anyone who can reach the port.
 *
 * Kept a liveness probe on purpose: it must answer even when the database is
 * the thing that is down. R-56 (2026-09-28) adds `database` -- a `select 1`
 * capped at one second that never throws -- so a stopped database is visible
 * instead of hidden behind "ok". `status` stays "ok": it means the process
 * is alive, which it is.
 */
router.get("/healthz", async (_req, res) => {
  const providersConfigured = Object.values(providerRegistry)
    .filter((adapter) => Boolean(process.env[adapter.apiKeyEnvVar]))
    .map((adapter) => adapter.providerId)
    .sort();

  const database = await probeDatabase(() => pool.query("select 1"));

  respondJson(res, HealthCheckResponse, {
    status: "ok",
    database,
    commitSha: buildCommitSha,
    builtAt: buildAt,
    startedAt,
    providersConfigured,
  });
});

export default router;
