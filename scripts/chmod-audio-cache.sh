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
# M-6e: and the directory holding them down to 0700. Same reason, one level
# up. mkdir's `mode` also applies at CREATION only, so the directory this
# server has been writing into since long before M-6e keeps the 0755 that
# mkdir's default 0777-minus-umask gave it, and deploying the fixed mkdir
# does not change that. 456 locked files in a world-listable directory still
# hand any local user every cached call id and its size, and a call id is the
# join key to a real caller's record.
#
# This is a one-shot sweep, not a scheduled job: once every file is 0600 and
# the directory is 0700 the write path keeps them that way. It is safe to
# re-run -- a second run finds nothing to change.
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
# The directory itself, asked the same way the files are asked, so this stays
# one idiom -- and `find -maxdepth 0 ! -perm` reads the same on macOS and
# Linux, which `stat`'s format flags do not. 1 means wrong, 0 means right.
dir_wrong()   { find "$DIR" -maxdepth 0 ! -perm 700 | wc -l | tr -d ' '; }
dir_shown()   { ls -ld "$DIR" | awk '{ print $1 }'; }

total="$(count_all)"
wrong="$(count_wrong)"
right=$(( total - wrong ))
dwrong="$(dir_wrong)"

say "$DIR"
printf '   %s file(s) total\n' "$total"
printf '   %s already 0600\n'  "$right"
printf '   the directory itself is %s\n' "$(dir_shown)"

if [[ "$wrong" == "0" && "$dwrong" == "0" ]]; then
  printf '   0 to change -- nothing to do\n'
  exit 0
fi

if [[ "$apply" != true ]]; then
  [[ "$wrong" == "0" ]]  || printf '   %s file(s) would change to 0600\n' "$wrong"
  [[ "$dwrong" == "0" ]] || printf '   the directory would change to 0700\n'
  say "dry run: nothing was changed. re-run with --apply"
  exit 0
fi

# -print0/-0 rather than a bare loop: filenames are call-id UUIDs today, but a
# sweep that silently mangles an odd name is worse than one that never ran.
if [[ "$wrong" != "0" ]]; then
  find "$DIR" -type f ! -perm 600 -print0 | xargs -0 chmod 600
  printf '   %s file(s) changed to 0600\n' "$wrong"
fi

# Only this one directory, named once at the top and never derived from an
# argument -- and never its parents, which are ordinary source directories.
if [[ "$dwrong" != "0" ]]; then
  chmod 700 "$DIR"
  printf '   the directory changed to 0700\n'
fi

left="$(count_wrong)"
[[ "$left" == "0" ]] || die "$left file(s) are still not 0600 after the sweep"
dleft="$(dir_wrong)"
[[ "$dleft" == "0" ]] || die "the directory is still $(dir_shown) after the sweep"
say "done: all $total file(s) are 0600 and the directory is 0700"
