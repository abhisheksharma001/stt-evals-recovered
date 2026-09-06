#!/usr/bin/env bash
# M-6d: bring every file already sitting in the audio cache down to 0600.
#
# M-6b made the server WRITE the mono `<callId>.audio` file 0600, like the
# three sidecars beside it. That only fixed files created after it merged:
# node's `writeFile(..., { mode })` applies the mode at CREATION, so a file
# that already existed keeps whatever mode it was born with, however many
# times it is later overwritten. 156 mono files written before M-6b were
# therefore still 0644 -- world-readable caller audio in a directory whose
# other 300 files are not. The directory is only as protected as its
# weakest file.
#
# This is a one-shot sweep, not a scheduled job: once every file is 0600 the
# write path keeps it that way. It is safe to re-run -- a second run finds
# nothing to change.
#
# What it does NOT do: read, print, move, rename, delete or otherwise touch
# a single byte of any file's CONTENTS, and never leaves that one directory.
# `-type f` also means a symlink is skipped rather than followed, so nothing
# outside the cache can be reached through one.
#
# Usage:  bash scripts/chmod-audio-cache.sh            # dry run, changes nothing
#         bash scripts/chmod-audio-cache.sh --apply    # does it
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
DIR="$ROOT/artifacts/api-server/audio-cache"

say() { printf '\n== %s\n' "$*"; }
die() { printf '\n!! %s\n' "$*" >&2; exit 1; }

apply=false
case "${1-}" in
  --apply) apply=true ;;
  "")      ;;
  *)       die "unknown argument: $1 (only --apply is understood)" ;;
esac

[[ -d "$DIR" ]] || die "no audio cache directory at $DIR"

count_wrong() { find "$DIR" -type f ! -perm 600 | wc -l | tr -d ' '; }
count_all()   { find "$DIR" -type f            | wc -l | tr -d ' '; }

total="$(count_all)"
wrong="$(count_wrong)"
right=$(( total - wrong ))

say "$DIR"
printf '   %s file(s) total\n' "$total"
printf '   %s already 0600\n'  "$right"

if [[ "$wrong" == "0" ]]; then
  printf '   0 to change -- nothing to do\n'
  exit 0
fi

if [[ "$apply" != true ]]; then
  printf '   %s would change to 0600\n' "$wrong"
  say "dry run: nothing was changed. re-run with --apply"
  exit 0
fi

# -print0/-0 rather than a bare loop: filenames are call-id UUIDs today, but a
# sweep that silently mangles an odd name is worse than one that never ran.
find "$DIR" -type f ! -perm 600 -print0 | xargs -0 chmod 600

left="$(count_wrong)"
[[ "$left" == "0" ]] || die "$left file(s) are still not 0600 after the sweep"
printf '   %s changed to 0600\n' "$wrong"
say "done: all $total file(s) under that directory are 0600"
