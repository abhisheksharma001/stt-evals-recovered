#!/usr/bin/env bash
# T-78: one-command local deploy of the UI bundle + API server.
#
# What it does, in order (stops at the first failure):
#   1. refuses to run if the git tree is dirty or the typecheck fails
#   2. builds the UI (vite) and the API bundle (esbuild)
#   3. stops the API listening on $PORT by PID -- never pkill
#   4. starts the new build, logs to $LOG
#   5. polls /api/healthz until it answers, then prints old -> new commitSha
#      and fails if the new sha is not `git rev-parse --short=12 HEAD`
#
# Rollback is the same script after `git revert <sha>` -- see
# docs/runbooks/deploy-and-rollback.md.
#
# Usage:  scripts/deploy-api.sh            (PORT defaults to 8177)
#         PORT=8177 scripts/deploy-api.sh
#         SKIP_CHECKS=1 scripts/deploy-api.sh   (dirty tree / no typecheck; local only)
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PORT="${PORT:-8177}"
LOG="${LOG:-/tmp/stt-api-${PORT}.log}"
API_DIR="$ROOT/artifacts/api-server"
HEALTH="http://localhost:${PORT}/api/healthz"

say() { printf '\n== %s\n' "$*"; }
die() { printf '\n!! %s\n' "$*" >&2; exit 1; }

cd "$ROOT"
command -v pnpm >/dev/null || die "pnpm not on PATH"
command -v curl >/dev/null || die "curl not on PATH"
command -v lsof >/dev/null || die "lsof not on PATH"

want_sha="$(git rev-parse --short=12 HEAD)"

# --- 1. gates -----------------------------------------------------------
if [[ "${SKIP_CHECKS:-0}" != "1" ]]; then
  if [[ -n "$(git status --porcelain)" ]]; then
    git status --short
    die "working tree is dirty -- commit or stash first (SKIP_CHECKS=1 to override locally)"
  fi
  say "typecheck"
  pnpm run typecheck >/dev/null || die "typecheck failed -- not deploying"
else
  say "SKIP_CHECKS=1: skipping dirty-tree and typecheck gates"
fi

old_sha="$(curl -sf --max-time 2 "$HEALTH" 2>/dev/null | sed -n 's/.*"commitSha":"\([^"]*\)".*/\1/p' || true)"
say "currently live: ${old_sha:-nothing on :$PORT}"

# --- 2. build -----------------------------------------------------------
say "build UI"
pnpm --filter @workspace/stt-benchmark exec vite build >/dev/null
say "build API"
(cd "$API_DIR" && node ./build.mjs >/dev/null)

# --- 3. stop the old process by PID -------------------------------------
pids="$(lsof -ti:"$PORT" -sTCP:LISTEN || true)"
if [[ -n "$pids" ]]; then
  for p in $pids; do
    say "stopping pid $p on :$PORT"
    kill "$p"
  done
  # wait up to 10s for the port to free
  for _ in $(seq 1 20); do
    lsof -ti:"$PORT" -sTCP:LISTEN >/dev/null 2>&1 || break
    sleep 0.5
  done
  lsof -ti:"$PORT" -sTCP:LISTEN >/dev/null 2>&1 && die "port $PORT still held after 10s"
fi

# --- 4. start -----------------------------------------------------------
say "start API on :$PORT (log: $LOG)"
(
  cd "$API_DIR"
  PORT="$PORT" nohup node --env-file-if-exists=.env --enable-source-maps ./dist/index.mjs >"$LOG" 2>&1 </dev/null &
  disown
)

# --- 5. verify ----------------------------------------------------------
new_sha=""
for _ in $(seq 1 40); do
  new_sha="$(curl -sf --max-time 2 "$HEALTH" 2>/dev/null | sed -n 's/.*"commitSha":"\([^"]*\)".*/\1/p' || true)"
  [[ -n "$new_sha" ]] && break
  sleep 0.5
done
[[ -n "$new_sha" ]] || { tail -n 30 "$LOG" >&2; die "healthz never answered on :$PORT"; }

say "deployed: ${old_sha:-none} -> $new_sha"
if [[ "$new_sha" != "$want_sha" ]]; then
  die "live commitSha $new_sha != HEAD $want_sha (dirty build or stale bundle?)"
fi
say "ok: live build matches HEAD $want_sha"
