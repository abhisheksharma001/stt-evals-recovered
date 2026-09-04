#!/usr/bin/env bash
# M-4: nightly dump of the benchmark database.
#
# What it does, in order (stops at the first failure):
#   1. reads the database NAME out of artifacts/api-server/.env -- the value of
#      DATABASE_URL is never printed, only its last path segment is used
#   2. `docker exec stt-evals-pg pg_dump -Fc` into
#      ~/gh-projects/stt-evals-backups/stt-evals-YYYY-MM-DD.dump
#   3. keeps the newest 30 dumps and deletes the rest
#   4. prints the size of the dump it just wrote
#
# The dump lands on <name>.partial and is renamed only after pg_dump exits 0,
# so a failed run can never leave a half-written file that looks like a backup
# -- and never clobbers yesterday's good one.
#
# Restoring is the other half of a backup and lives in
# docs/runbooks/deploy-and-rollback.md ("Restore the database"). A backup that
# has not been restored once is not a backup.
#
# Usage:  bash scripts/backup-db.sh
#         launchd runs it daily at 02:00 as ai.ellavox.stt-evals.backup
#         (the plist is in the runbook; it lives outside the repo).
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
ENV_FILE="$ROOT/artifacts/api-server/.env"
CONTAINER="stt-evals-pg"
DEST="$HOME/gh-projects/stt-evals-backups"
KEEP=30

say() { printf '\n== %s\n' "$*"; }
die() { printf '\n!! %s\n' "$*" >&2; exit 1; }

command -v docker >/dev/null || die "docker not on PATH"
[[ -f "$ENV_FILE" ]] || die "no env file at $ENV_FILE"
docker ps --format '{{.Names}}' | grep -qx "$CONTAINER" || die "container $CONTAINER is not running"

# The database name is the last path segment of DATABASE_URL. The rest of that
# line is a password, so the line itself is never echoed -- not on success and
# not in any of the failures below.
url_line="$(grep -m1 '^DATABASE_URL=' "$ENV_FILE" || true)"
[[ -n "$url_line" ]] || die "no DATABASE_URL line in $ENV_FILE"
db="${url_line##*/}"      # everything after the last slash
db="${db%%\?*}"           # drop any ?query
[[ -n "$db" ]] || die "DATABASE_URL in $ENV_FILE has no database name after the last /"

mkdir -p "$DEST"
out="$DEST/stt-evals-$(date +%F).dump"
trap 'rm -f "$out.partial"' EXIT   # a failed run leaves nothing behind, not even debris

say "dump $db out of $CONTAINER"
docker exec "$CONTAINER" pg_dump -U postgres -Fc "$db" > "$out.partial"
mv "$out.partial" "$out"
say "wrote $out ($(du -h "$out" | cut -f1))"

# --- retention: the newest $KEEP, nothing older -------------------------
stale="$(ls -t "$DEST"/stt-evals-*.dump 2>/dev/null | tail -n +$((KEEP + 1)) || true)"
if [[ -n "$stale" ]]; then
  say "removing $(printf '%s\n' "$stale" | wc -l | tr -d ' ') dump(s) beyond the newest $KEEP"
  printf '%s\n' "$stale" | xargs rm -f
fi
