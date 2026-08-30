#!/usr/bin/env bash
# T-99: one door for every data backfill still waiting on a human "go".
#
#   bash scripts/apply-backfills.sh          # dry run: counts only, writes nothing
#   bash scripts/apply-backfills.sh --apply  # writes, in this order:
#       1. backfill-t65-t66.ts  (T-65 cross-run pick links, T-63/T-66 legacy
#                                scans -> error, T-62 flux $/min 0.0043 -> 0.0077)
#       2. backfill-t52-started-at.ts (T-52 source_started_at + source_provider
#                                on the 22 original calls; 14 stay null forever,
#                                Vapi's 14-day retention has their metadata too)
#
# Both scripts are idempotent, so this is safe to re-run. It reads
# artifacts/api-server/.env for DATABASE_URL and the Vapi keys (T-52 calls
# Vapi) and never prints either. No API restart is needed: both write only
# to the database. Rankings already computed before the T-62 price change
# keep the old $/min in their stored score rows -- re-execute or re-rank a
# bulk if that matters (see docs/runbooks/pending-backfills.md).
set -euo pipefail
cd "$(dirname "$0")/.."
MODE="${1:-}"
if [[ -n "$MODE" && "$MODE" != "--apply" ]]; then
  echo "usage: $0 [--apply]" >&2; exit 2
fi
if [[ ! -f artifacts/api-server/.env ]]; then
  echo "artifacts/api-server/.env missing -- DATABASE_URL and Vapi keys live there" >&2; exit 1
fi
run() {
  echo "== $1 ${MODE:-(dry run)}"
  pnpm --filter @workspace/api-server exec tsx --env-file-if-exists=.env "./src/$1" ${MODE:+--apply}
}
run backfill-t65-t66.ts
run backfill-t52-started-at.ts
if [[ -z "$MODE" ]]; then
  echo
  echo "Nothing written. Re-run with --apply to write."
fi
