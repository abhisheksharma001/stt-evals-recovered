# Deployment — Vercel workflow integration

Status: wired this session on branch `provider-adapters-run-executor`.

## Architecture: split by process lifetime

| Tier | Runs where | Why |
|---|---|---|
| Web UI (`artifacts/stt-benchmark`, static SPA) | **Vercel** | Static build, CDN edge, zero servers; deep links (`/results`, `/runs`) work via SPA rewrites. |
| API server (`artifacts/api-server`, Express 5) | Any **long-running** host (Fly.io / Railway / a small VPS) | Run execution is minutes-long and fire-and-forget; Cartesia cells hold a WebSocket open for the call duration. Serverless would kill both. |

The Express server must never be crammed into a Vercel function — that is an
architectural fact, not a limitation; `docs/execution-plan.md` already lists
serverless as the rejected execution model for runs.

## What was added

1. `artifacts/stt-benchmark/vercel.json` — framework preset, build command
   (`pnpm run build`), output dir (`dist/public`), SPA rewrite for client-side
   routes, immutable cache header for hashed `/assets/*`.
2. `artifacts/stt-benchmark/src/main.tsx` — honors
   `VITE_API_BASE_URL` via `setBaseUrl()`; unset ⇒ relative `/api`
   (same-origin setups unchanged: Replit router, dev proxy).
3. `artifacts/stt-benchmark/vite.config.ts` — `PORT`/`BASE_PATH` are now
   optional with defaults (`5173` / `/`). Replit deployments keep injecting
   them; Vercel builds no longer crash at config-eval time.
4. `.github/workflows/ci.yml` — every push/PR: full workspace typecheck,
   offline unit tests (scoring + provider parsers), web build, API bundle.
5. `.github/workflows/deploy-web.yml` — push to `main` touching the web app or
   its libs deploys production to Vercel via the CLI (no third-party action);
   manual `workflow_dispatch` included.

## One-time setup to make deploys live

1. `vercel link` (or create the project in the dashboard) under the right team;
   note ORG_ID and PROJECT_ID.
2. Add repo secrets: `VERCEL_TOKEN`, `VERCEL_ORG_ID`, `VERCEL_PROJECT_ID`.
3. Add repo variable `VITE_API_BASE_URL=https://<api-host>/api` once the API
   host exists. Without it, the deployed site will call relative `/api` and
   get HTML back — loud, obvious misconfiguration, not a silent failure.
4. Deploy the API server to the long-running host of choice with:
   `DATABASE_URL`, provider keys, `VAPI_API_KEY*`, `PORT`. The API bundle is
   already built by CI (`pnpm --filter @workspace/api-server run build` →
   `dist/index.mjs`; run with `node --env-file-if-exists=.env dist/index.mjs`).

## Env loading fix worth knowing

`artifacts/api-server/.env` was never loaded by anything before this session
(Replit injected env directly). `pnpm start` now uses Node's
`--env-file-if-exists=.env`, so laptop runs pick the file up and hosts that
inject env vars are unaffected (file absent ⇒ no-op).
