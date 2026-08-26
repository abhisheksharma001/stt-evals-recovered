# STT Benchmark Command Center

A standalone internal architecture and UI foundation for importing historical Vapi call audio, replaying it through candidate STT providers, and selecting a default transcriber from reproducible accuracy, latency, and cost evidence.

## Run & Operate

- `pnpm --filter @workspace/api-server run dev` — run the API server (port 5000)
- `pnpm run typecheck` — full typecheck across all packages
- `pnpm run build` — typecheck + build all packages
- `pnpm --filter @workspace/api-spec run codegen` — regenerate API hooks and Zod schemas from the OpenAPI spec
- `pnpm --filter @workspace/db run push` — push DB schema changes (dev only)
- Required env: `DATABASE_URL` — Postgres connection string

## Stack

- pnpm workspaces, Node.js 24, TypeScript 5.9
- API: Express 5
- DB: PostgreSQL + Drizzle ORM
- Validation: Zod (`zod/v4`), `drizzle-zod`
- API codegen: Orval (from OpenAPI spec)
- Build: esbuild (CJS bundle)

## Where things live

- `docs/standalone-vapi-architecture.md` — Vapi-specific standalone architecture and primary handoff
- `docs/integration-strategy.md` — direct API, connector, MCP, and secret boundaries
- `docs/HANDOFF.md` — current state and first implementation slice
- `docs/execution-plan.md`, `docs/tasks.yaml`, `docs/task-graph.mmd` — microtasks and dependencies
- `docs/logic-register.md` — scoring decisions to resolve during implementation
- `lib/api-spec/openapi.yaml` — typed API contract used by the UI foundation
- `lib/db/src/schema/` — current benchmark metadata schema
- `scripts/src/stt-score.ts` — starter WER/entity/alphanumeric scoring CLI
- `artifacts/stt-benchmark/` — standalone command-center UI

## Architecture decisions

- Both Vapi date-range import and manual private-file upload converge on the same corpus record shape.
- Deployed application code uses direct provider APIs or a native connector; MCP is agent-side tooling and must not sit in the runtime benchmark path.
- The first provider scope is Deepgram, Cartesia, and ElevenLabs. The earlier six-provider matrix is expansion reference only.
- A run is comparable only when every provider receives identical audio bytes and immutable corpus/config/scoring snapshots.
- Provider-native output is stored before normalization so scores can be reproduced without paying to transcribe again.

## Product

The UI foundation covers corpus/gold readiness, provider configuration, benchmark runs, rankings, and the implementation plan. Live Vapi import, private audio upload, provider adapters, and run orchestration are intentionally left for the implementation owner.

## User preferences

- Stop at architecture and handoff documentation for this phase; do not autonomously build the full Vapi/provider integration.
- Keep the product UI-based and standalone.

## Gotchas

- Do not ask for or store provider API keys in source, database fields, browser forms, or chat; use platform secrets/native integrations.
- Do not treat an MCP server as an application-runtime integration.
- All vendor pricing and capability claims must be reverified against primary documentation before a benchmark run.

## Pointers

- See the `pnpm-workspace` skill for workspace structure, TypeScript setup, and package details
