#!/usr/bin/env bash
# Flips every remaining `needs_review` call to `ready_to_run`.
#
# The de-identification gate was removed 2026-08-27 (per Abhishek), and new
# imports now land ready_to_run on their own. Calls imported BEFORE that
# change are still sitting in needs_review, which is no longer a state
# anything can move them out of -- this one-shot backfill clears them.
#
# Requires the API server to already be running the post-gate code: against
# the old build every PATCH comes back 409 and this script will say so.
#
# Usage:  ./scripts/backfill-ready-to-run.sh [api-base]
set -euo pipefail

API="${1:-http://localhost:8177/api}"

# `mapfile` is bash 4+, and macOS still ships bash 3.2 -- read into a
# newline-separated string instead so this runs on a stock Mac.
IDS=$(
  curl -fsS --max-time 30 "$API/benchmark/calls" |
    python3 -c "
import json,sys
calls = json.load(sys.stdin)
calls = calls if isinstance(calls, list) else calls.get('calls', [])
for c in calls:
    if c.get('status') == 'needs_review':
        print(c['id'])
"
)

if [ -z "$IDS" ]; then
  echo "Nothing to backfill -- no calls are in needs_review."
  exit 0
fi

count=$(printf '%s\n' "$IDS" | wc -l | tr -d ' ')
echo "Flipping $count call(s) to ready_to_run..."
ok=0; failed=0
for id in $IDS; do
  code=$(curl -s -o /dev/null -w '%{http_code}' --max-time 20 \
    -X PATCH "$API/benchmark/calls/$id" \
    -H 'Content-Type: application/json' \
    -d '{"status":"ready_to_run"}')
  if [ "$code" = "200" ]; then
    ok=$((ok+1))
  else
    failed=$((failed+1))
    if [ "$code" = "409" ]; then
      echo "  $id -> HTTP 409. The API server is still running the pre-removal build; restart it and re-run." >&2
      exit 1
    fi
    echo "  $id -> HTTP $code" >&2
  fi
done

echo "Done: $ok updated, $failed failed."
