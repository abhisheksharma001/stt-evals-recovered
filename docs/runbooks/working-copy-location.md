# Where the working copy lives (S-0.1)

**Canonical:** GitHub `abhisheksharma001/stt-evals-recovered`, branch `main`.
**Local working copy:** `~/gh-projects/stt-evals-recovered` (since 2026-09-02).
**Never:** anywhere under `/private/tmp`, including a Claude Code scratchpad.

## What happened on 2026-09-01

Until 2026-09-02 the working copy lived inside a Claude Code scratchpad under
`/private/tmp/claude-501/…`. Overnight something on this Mac swept that tree: every
file whose atime, mtime **and** ctime were all older than about three days was deleted.
Gone from disk: 166 tracked source files (`.gitignore` among them), 209 loose objects
inside `.git` (77 blobs, 131 trees, 1 commit — `git log -- <old path>` answered
`fatal: unable to read tree`), 64 of 107 cached audio files, and part of
`node_modules` (typecheck failed at a commit CI had passed).

The sweeper was not identified. macOS's `/etc/periodic` does not exist on this OS
version; two user launch agents (`ai.openclaw.gateway`, `com.kimi-news-automation.schedule`)
run at the relevant hours and were not ruled out. The fix does not depend on the
answer: nothing that must survive lives under `/private/tmp`.

Nothing committed was lost — `HEAD` equalled the remote. What was lost for good is
recorded in `docs/backlog/good-to-have.md` (2026-09-02 entry): audio for 6 calls whose
Vapi retention window closed while the files sat deleted.

`~/gh-projects/STT-evals` is an older clone of the *original* repository
(`abhisheksharma001/STT-evals`, branch `provider-adapters-run-executor`, two uncommitted
files). It is not this project's working copy and was left untouched.

## What lives only on disk and must be carried by hand

1. `artifacts/api-server/.env` — the real provider and Vapi keys. **Copy it first, the same day.**
   Claude does not write keys into `.env` without being told to.
   ```
   cp <old-tree>/artifacts/api-server/.env ~/gh-projects/stt-evals-recovered/artifacts/api-server/.env
   ```
2. `artifacts/api-server/audio-cache/` — cached call audio. The API resolves it as
   `process.cwd()/audio-cache` (`artifacts/api-server/src/lib/audio-cache.ts`), so the
   API must be started from `artifacts/api-server` — `scripts/deploy-api.sh` does that.
   Vapi keeps recordings 14 days; anything older exists only in this directory. If files
   are missing, `POST /benchmark/calls/cache-audio` re-fetches whatever Vapi still holds
   (free — a Vapi download, no STT provider is called; cached calls are skipped).
3. The database is Docker Postgres on `:5433` — a Docker volume, not in the tree and
   not carried by a clone. Since M-4 `scripts/backup-db.sh` dumps it nightly to
   `~/gh-projects/stt-evals-backups/`, which is a folder on this same laptop — so it
   is a third thing to copy by hand when moving machines, not an off-site copy.
   The restore recipe is in `docs/runbooks/deploy-and-rollback.md`.

## Relocate or recover

```
git clone https://github.com/abhisheksharma001/stt-evals-recovered.git ~/gh-projects/stt-evals-recovered
cd ~/gh-projects/stt-evals-recovered
pnpm install --frozen-lockfile
pnpm run typecheck
# copy .env and audio-cache (section above)
scripts/deploy-api.sh                 # stops whatever listens on :8177, starts from here
curl -s localhost:8177/api/healthz    # commitSha must equal: git rev-parse --short=12 HEAD
```

Then start Claude Code **from the new directory** — its working directory and scratchpad
follow wherever it was launched.

Explained and fixed 2026-09-06 (S-0.2, PR #95): the first `pnpm install` into the empty
clone failed at the root `preinstall` guard with `Use pnpm instead` although pnpm was the
runner. The guard tested `$npm_config_user_agent`, which pnpm 11 leaves empty when it runs
a **workspace root's** own lifecycle scripts -- a phase it runs after linking, which is
also why that failed install still left a fully linked `node_modules` behind. The guard now
tests the basename of `$npm_execpath`, which is set in every phase. No workaround is
needed: a fresh clone runs `pnpm install --frozen-lockfile` and then `pnpm run typecheck`
straight through.

## If `.env` is gone but the API is still running

The sweep takes `.env` like any other old file (it did on 2026-09-03). While the API
process is alive its `process.env` still holds everything `--env-file-if-exists=.env`
loaded, and Node opens a localhost-only inspector on `SIGUSR1`. **Do not restart, deploy,
or reboot first** — the process is the last copy. With Abhishek's explicit go:

1. `ps -Eww -o command= -p <pid>` → the names in the exec-time environment (the shell's
   variables — these were **not** in `.env`).
2. `kill -USR1 <pid>`; `curl http://127.0.0.1:9229/json` gives the WebSocket URL.
3. Over that socket send `Runtime.evaluate` with `JSON.stringify(process.env)`,
   `returnByValue: true`. Keep only names absent from step 1: that set is exactly what
   `.env` held (2026-09-04: 12 names — six vendor keys, three Vapi accounts,
   `DATABASE_URL`, `LOG_LEVEL`, `NODE_ENV`).
4. Write them to the new `.env` with mode `600` from inside the script. Print names and
   counts only — never a value, not to the terminal, not to a log.
5. Close the inspector from the same session:
   `process.getBuiltinModule('node:inspector').close()`, then confirm `:9229` no longer
   answers.

The script used on 2026-09-04 was a 30-line `.mjs` using Node 22's global `WebSocket`;
it lived in the session scratchpad and is not kept — the five steps above are the whole
of it.

## How to tell it happened again

- `git status` shows many ` D` lines nobody made, `.gitignore` among them →
  `git restore .` is safe when there are no ` M` lines (nothing of yours is overwritten;
  untracked files are not touched). **Do not `git add -A` while `.gitignore` is missing** —
  `.env` is an ordinary untracked file at that moment.
- `git log -- <path>` fails with `unable to read tree` → history objects are gone; a fresh
  clone is the only repair.
- `ls artifacts/api-server/audio-cache | wc -l` is lower than the Calls page's
  "audio saved" count → run the rescue endpoint above, today, before more windows close.
