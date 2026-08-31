import { Router, type IRouter } from "express";
import { HealthCheckResponse } from "@workspace/api-zod";
import { providerRegistry } from "@workspace/stt-providers";
import { buildAt, buildCommitSha, startedAt } from "../lib/build-info";
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
 * Kept free of database work on purpose: this is a liveness probe, so it
 * must answer even when the database is the thing that is down.
 */
router.get("/healthz", (_req, res) => {
  const providersConfigured = Object.values(providerRegistry)
    .filter((adapter) => Boolean(process.env[adapter.apiKeyEnvVar]))
    .map((adapter) => adapter.providerId)
    .sort();

  respondJson(res, HealthCheckResponse, {
    status: "ok",
    commitSha: buildCommitSha,
    builtAt: buildAt,
    startedAt,
    providersConfigured,
  });
});

export default router;
