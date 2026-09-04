#!/usr/bin/env bash
# T-120: every backticked repo path in the LIVE docs must exist. Historical
# docs (execution-plan, reproducibility, logic-register, tasks.yaml, PRD-v3-*)
# carry a "paths may be stale" banner instead and are not checked -- they
# describe the plan as it was, not the tree as it is.
#
# A "path" here is a backticked token containing a slash and a code/doc
# extension, e.g. `lib/agent.ts` or `docs/runbooks/x.md`; an optional
# `:line` or `:line,line` suffix is ignored. Bare basenames (`Corpus.tsx`)
# are not checked -- too ambiguous to resolve, and the ones in the audit
# notes are deliberately as-of-that-day.
#
# Usage: bash scripts/check-doc-paths.sh   (exit 1 on any missing path)
set -euo pipefail
cd "$(dirname "$0")/.."

LIVE_DOCS=(
  .claude/CLAUDE.md .claude/VISION.md .claude/REQUIREMENTS.md .claude/STANDARDS.md
  README.md docs/PRD.md docs/PRD-v4-technical.md docs/PRD-v4-uiux.md
  docs/provider-data-samples.md docs/runbooks/*.md docs/backlog/good-to-have.md
  docs/PRD-v6-measure.md docs/step-register.md docs/scoring-policy.md
)

exists_somewhere() {
  local p="$1" root
  [ -e "$p" ] && return 0
  # Docs often write a path relative to a package root; accept those too.
  for root in artifacts/api-server artifacts/api-server/src artifacts/stt-benchmark artifacts/stt-benchmark/src lib lib/scoring lib/scoring/src lib/stt-providers/src lib/db/src; do
    [ -e "$root/$p" ] && return 0
  done
  return 1
}

report="$(mktemp)"
for doc in "${LIVE_DOCS[@]}"; do
  [ -f "$doc" ] || continue
  paths="$(grep -oE '`[A-Za-z0-9_.@-]+(/[A-Za-z0-9_.@*-]+)+\.(ts|tsx|mjs|js|md|sh|yaml|yml|baml|json|css)(:[0-9,]+)?`' "$doc" | tr -d '`' | sed -E 's/:[0-9,]+$//' | sort -u || true)"
  for p in $paths; do
    case "$p" in *'*'*|http*) continue ;; esac   # globs / urls are prose, not paths
    exists_somewhere "$p" || echo "MISSING  $doc  ->  $p" >> "$report"
  done
done

if [ -s "$report" ]; then
  cat "$report"; rm -f "$report"
  echo "check-doc-paths: stale paths above (fix the doc or the path)"
  exit 1
fi
rm -f "$report"
echo "check-doc-paths: every backticked path in the live docs exists"
