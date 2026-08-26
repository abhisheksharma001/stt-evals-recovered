# What you (Abhishek) actually need, to keep this moving

Plain checklist — not architecture, just "what do I need to have ready."

## Accounts / API keys — have vs. still need

| Provider | Status | Notes |
|---|---|---|
| Vapi | ✅ have 2 keys | `Default` (original) + `Land And Apartment` (client, added 2026-08-25). Multi-account/multi-org supported already (`VAPI_API_KEY_<LABEL>` pattern) — get a new key from any client's Vapi org whenever we want to benchmark on their actual calls, not just our own. **When adding a 3rd account, check for calls with an empty `sourceAccountLabel` first** — see the 2026-08-25 note in `.claude/CLAUDE.md`, backfilling those blind stops being safe once there's real ambiguity. |
| AssemblyAI | ✅ have a key | |
| Cartesia | ✅ have a key | Streaming (WebSocket) provider — different shape from the others, see `docs/provider-data-samples.md`. |
| Gladia | ✅ have a key | |
| Deepgram | ✅ have a key | Also the provider Vapi itself uses live on some calls — see the bias note in `.claude/CLAUDE.md`. |
| OpenAI (gpt-4o-transcribe, and the transcript-quality agent) | ✅ have a key | Added 2026-08-25. Powers both the OpenAI STT provider and the `/agent` page's flag/judge calls (`lib/agent.ts`). |
| ElevenLabs | ⬜ not yet | Adapter code exists, no key. In `docs/PRD.md`'s provider list. |
| Speechmatics | ⬜ not yet | Adapter code exists, no key. |

When a new key shows up: say so and I'll save it to `artifacts/api-server/.env`
(never committed) and confirm the adapter + provider row are wired — most of that is
already done for these three, so it's usually a one-line addition, not new code.

## Infra

- **Postgres** — local Docker container (`stt-evals-pg`, port 5433). Needs to be
  running for anything to work. If it's ever moved to a real hosted DB (not local
  Docker), that's a real decision to make together first, not something to do
  silently.
- **API server** — Express, local dev on port 8177 right now. Not deployed anywhere
  public yet — this is an internal tool, not something client-facing.
- **UI** — Vite dev server, port 5173.

## Recurring things worth checking on, not one-time

- **Provider API docs drift.** Every field this tool relies on (confidence scores,
  response shapes, pricing) should be reverified against the provider's real docs
  before trusting a claim about it, not assumed to still be true — providers change
  these. `docs/provider-data-samples.md` has today's real snapshot; it'll go stale.
- **New client = new Vapi org key.** Benchmarking a specific client's call patterns
  needs that client's own Vapi recordings, not just internal test calls — ask for
  access when a client engagement calls for a real provider recommendation.
- **Corpus size.** The tool explicitly flags rankings as "low confidence" under a
  small sample count (`docs/PRD.md` AC-FULL-1). More real reviewed-and-gold'd calls
  per vertical is the single highest-leverage thing to keep growing — the
  scoring/ranking pipeline is already built, it's underfed on data, not on features.

## What I don't need to worry about

- API keys never need to touch the browser, the database, or a chat message once
  they're in `.env` — that's enforced by how the app is built, not a manual step to
  remember.
- Re-running a benchmark is safe — it only retries what actually failed, it won't
  silently re-charge for calls that already succeeded.
