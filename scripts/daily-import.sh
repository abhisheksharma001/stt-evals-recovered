#!/usr/bin/env bash
# M-17: a daily import, so nothing crosses Vapi's 14-day audio cliff again.
#
# Vapi deletes a call's recording 14 days after the call. Import has been a
# button since the beginning: 6 calls are already gone for good, and the
# 99-call client corpus was saved by hand five days before its own cliff.
#
# What it does, per account named in ACCOUNTS below (stops at the first
# failure):
#   1. POST /benchmark/vapi/preview for the last DAYS days
#   2. keeps the ids that are importable -- not already in the corpus, and
#      Vapi still has a recording for them
#   3. POST /benchmark/vapi/import with x-actor: scheduler, in chunks of 200
#      (the contract's maxItems)
#   4. prints what it imported, skipped and failed
#
# It never launches a bulk and never calls a transcription provider: importing
# is a Vapi download and costs nothing. The Vapi API keys stay on the server --
# this script only ever talks to the local API, and no key value passes
# through it.
#
# ACCOUNTS is explicit on purpose. `vertical` is required by the import
# contract and CANNOT be derived from the account: read live 2026-09-09, the
# "default" account's 22 calls carry three different verticals (trucking 8,
# rush 8, property_management 6). Only accounts listed here are imported, so a
# nightly job can never file a call under a guess. Adding one is a one-line
# edit and a decision somebody made on purpose.
#
# WINDOW: one day, not the three the step was written with. Measured live
# 2026-09-09 on the Land And Apartment account: 257 calls in the last 24 hours,
# 252 of them importable. The preview endpoint takes no cursor and caps at 500
# per request, so a 3-day window comes back truncated -- it returned exactly
# 500 -- and a nightly job that silently sees two thirds of its window is the
# same cliff it exists to prevent. One day fits; if it ever stops fitting, the
# truncation check below says so and the run exits non-zero.
#
# Usage:  bash scripts/daily-import.sh
#         DAYS=2 bash scripts/daily-import.sh          # a catch-up after a miss
#         launchd runs it daily at 03:00 as ai.ellavox.stt-evals.import
#         (the plist is in docs/runbooks/deploy-and-rollback.md; it names
#         absolute paths, so it lives outside the repo)
set -euo pipefail

API="${STT_API:-http://localhost:8177/api}"
DAYS="${DAYS:-1}"
# accountId:vertical -- see the note above before adding one.
ACCOUNTS=("land-and-apartment:property_management")
CHUNK=200
# The preview contract's own maximum. Not a tuning knob: it is the largest
# window this endpoint can be asked to show at once.
LIMIT=500
truncated=0

command -v jq >/dev/null || { echo "daily-import: jq is required" >&2; exit 1; }

# BSD date on macOS, GNU date elsewhere. A wrong window would silently import
# nothing, which looks exactly like a quiet night, so this fails loudly.
if date -u -v-1d +%Y >/dev/null 2>&1; then
  START="$(date -u -v-"${DAYS}"d +%Y-%m-%dT%H:%M:%SZ)"
else
  START="$(date -u -d "${DAYS} days ago" +%Y-%m-%dT%H:%M:%SZ)"
fi
END="$(date -u +%Y-%m-%dT%H:%M:%SZ)"

echo "== daily-import $(date -u +%Y-%m-%dT%H:%M:%SZ)  window ${START} .. ${END}"

curl -fsS "${API}/healthz" >/dev/null || {
  echo "daily-import: the API at ${API} is not answering; nothing imported" >&2
  exit 1
}

for entry in "${ACCOUNTS[@]}"; do
  account="${entry%%:*}"
  vertical="${entry##*:}"

  preview="$(curl -fsS -X POST "${API}/benchmark/vapi/preview" \
    -H 'content-type: application/json' \
    -d "$(jq -n --arg a "$account" --arg s "$START" --arg e "$END" \
      --argjson l "$LIMIT" '{accountId: $a, startDate: $s, endDate: $e, limit: $l}')")"

  fetched="$(jq -r '.fetchedCount' <<<"$preview")"
  # fetchedCount == LIMIT means Vapi had at least this many and the rest were
  # never shown. Those calls still age towards the 14-day deletion, so this is
  # a failure to report, not a busy night to shrug at.
  if [ "$fetched" -ge "$LIMIT" ]; then
    echo "   WINDOW TRUNCATED: ${account} returned the maximum ${LIMIT}; calls in this window were not seen. Run more often, or with a shorter DAYS." >&2
    truncated=1
  fi
  # importableCount is the API's own word for it, but the ids are filtered
  # here as well rather than trusted: a call with no recording is one Vapi has
  # already deleted, and asking for it would only produce a failed outcome.
  ids="$(jq -r '[.calls[] | select(.alreadyImported == false and .hasRecording == true) | .vapiCallId]' <<<"$preview")"
  count="$(jq -r 'length' <<<"$ids")"
  echo "-- ${account} (${vertical}): ${fetched} fetched, ${count} to import"

  if [ "$count" -eq 0 ]; then continue; fi

  offset=0
  while [ "$offset" -lt "$count" ]; do
    chunk="$(jq -c --argjson o "$offset" --argjson n "$CHUNK" '.[$o:($o+$n)]' <<<"$ids")"
    result="$(curl -fsS -X POST "${API}/benchmark/vapi/import" \
      -H 'content-type: application/json' \
      -H 'x-actor: scheduler' \
      -d "$(jq -n --arg a "$account" --arg v "$vertical" --argjson ids "$chunk" \
        '{accountId: $a, vertical: $v, vapiCallIds: $ids}')")"
    jq -r '"   imported \(.importedCount), skipped \(.skippedCount), failed \(.failedCount)"' <<<"$result"
    # A failure is named, not swallowed: an outcome nobody reads is why the
    # first six recordings were lost.
    jq -r '.results[] | select(.outcome == "failed") | "   FAILED \(.vapiCallId): \(.message // "no message")"' <<<"$result"
    offset=$((offset + CHUNK))
  done
done

if [ "$truncated" -ne 0 ]; then
  echo "== daily-import finished with a truncated window -- some calls were never offered" >&2
  exit 1
fi

echo "== daily-import done"
