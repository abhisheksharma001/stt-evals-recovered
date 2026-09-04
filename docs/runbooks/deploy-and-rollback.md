# Deploy and rollback (T-78)

One command, one process, one log. Local dev host only today — the API runs
on `:8177`. It serves **only** `/api`; the UI is a separate Vite process on
`:5173` (this script builds the UI bundle, but nothing serves that directory —
corrected 2026-09-04, the earlier line here said the API served it). Nothing
here touches the database schema (that is `pnpm --filter @workspace/db run
push`, a separate, deliberate step).

## Deploy

```bash
scripts/deploy-api.sh            # PORT defaults to 8177
```

What it refuses:

- a dirty git tree (`git status --porcelain` not empty)
- a failing `pnpm run typecheck`

What it does, in order: build UI → build API → `kill <pid>` of whatever is
listening on the port (found with `lsof -ti:8177 -sTCP:LISTEN`; **never
`pkill`**) → start the new bundle with `nohup … & disown` → poll
`/api/healthz` → print `old -> new commitSha` and fail if the new sha is not
`git rev-parse --short=12 HEAD`.

Log: `/tmp/stt-api-8177.log`. If healthz never answers, the script prints the
last 30 log lines and exits non-zero; the old process is already gone at that
point, so fix and re-run.

`SKIP_CHECKS=1 scripts/deploy-api.sh` bypasses the two gates. Local
experiments only — the healthz sha will carry a `-dirty` suffix and the
build badge in the sidebar shows it.

## Where it listens

`127.0.0.1:8177` — loopback only, since M-3. The API has no authentication
and a bulk launch spends real provider money, so anything that can reach the
port can spend. Local callers are unaffected; another machine on the same
network is refused.

The UI dev server on `127.0.0.1:5173` is loopback only too, since M-3a. It
proxies `/api` to the API from *this* machine, so a LAN-bound UI would have
handed the network everything the API refuses it. Both ends of the fence are
now closed.

`HOST=0.0.0.0 scripts/deploy-api.sh` binds every interface again, and
`UI_HOST=0.0.0.0 pnpm dev` in `artifacts/stt-benchmark` does the same for the
UI. Only for a deliberate reason (showing the UI on a phone, say), and only
for as long as that reason lasts — there is still no auth in front of either.
Check which one is live with:

```bash
lsof -nP -iTCP:8177 -sTCP:LISTEN | tail -n +2 | awk '{print $9}'
lsof -nP -iTCP:5173 -sTCP:LISTEN | tail -n +2 | awk '{print $9}'
```

## Verify

```bash
curl -s localhost:8177/api/healthz
git rev-parse --short=12 HEAD
```

The two shas must match. The sidebar footer shows the same sha (`API …`).

## Rollback

Rollback is a forward deploy of the previous state — no snapshots to
restore, no second script to learn.

```bash
git revert <bad-sha>          # one commit; or `git revert a..b` for a range
scripts/deploy-api.sh
```

The revert is a real commit on the branch, so the history says what happened
and CI runs on it. If the bad change touched the schema, revert the code
first (this script), then decide about the data separately — a schema push
is never reverted blind, and the data has its own section below.

## Back up and restore the database

The corpus, every paid provider output and every score live in the Docker
volume behind `stt-evals-pg` — none of it is in the tree and none of it is on
GitHub. If that volume goes, the money already spent on those transcriptions
goes with it.

`scripts/backup-db.sh` dumps it. launchd runs that script daily at 02:00 as
`ai.ellavox.stt-evals.backup`; dumps land in `~/gh-projects/stt-evals-backups/`
as `stt-evals-YYYY-MM-DD.dump` (pg_dump custom format), newest 30 kept. Running
it by hand is the same command and safe to repeat — it rewrites the day's file:

```bash
bash scripts/backup-db.sh
ls -lt ~/gh-projects/stt-evals-backups/ | head -3
```

**This is a folder on this laptop, not off-site.** One dead disk takes the
database and its backups together. A second destination is open question v6 E1
in `docs/step-register.md`; until it is answered, that risk is real and
unmitigated.

### Restore

Never into the live database. Restore into a scratch one, look at it, and only
then decide what to move across:

```bash
DUMP=~/gh-projects/stt-evals-backups/$(ls -t ~/gh-projects/stt-evals-backups | head -1)
docker exec stt-evals-pg createdb -U postgres stt_evals_restore
docker exec -i stt-evals-pg pg_restore -U postgres -d stt_evals_restore < "$DUMP"
docker exec stt-evals-pg psql -U postgres -d stt_evals_restore -c 'select count(*) from benchmark_calls'
docker exec stt-evals-pg dropdb -U postgres stt_evals_restore    # when finished
```

**Exercised 2026-09-05** (M-4). The 3.8 MB dump restored into
`stt_evals_restore` and every table matched the live database: 175
benchmark_calls, 1151 benchmark_provider_call_results, 999 benchmark_scores,
22 benchmark_runs, 3 benchmark_bulks, 298 benchmark_agent_scans — 11 tables in
all. Do it again after any schema change. A dump nobody has restored is a
guess, not a backup.

### The schedule

```bash
launchctl list | grep stt-evals                                # loaded?
tail ~/Library/Logs/stt-evals-backup.log                       # what the last run said
launchctl kickstart gui/$(id -u)/ai.ellavox.stt-evals.backup   # run it right now
```

`launchctl list` prints `-  0  ai.ellavox.stt-evals.backup`; the middle column
is the last exit status, so `0` is a good night and anything else means read
the log. If the laptop is asleep at 02:00 launchd runs the job at the next
wake, so one missed night corrects itself.

The plist names absolute paths, which makes it specific to this machine — it
lives outside the repo at `~/Library/LaunchAgents/ai.ellavox.stt-evals.backup.plist`
and cannot be committed. Recreate it there verbatim:

```xml
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>ai.ellavox.stt-evals.backup</string>
  <key>ProgramArguments</key>
  <array>
    <string>/bin/bash</string>
    <string>/Users/abhisheksharma/gh-projects/stt-evals-recovered/scripts/backup-db.sh</string>
  </array>
  <key>EnvironmentVariables</key>
  <dict>
    <key>PATH</key>
    <string>/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin</string>
  </dict>
  <key>StartCalendarInterval</key>
  <dict>
    <key>Hour</key><integer>2</integer>
    <key>Minute</key><integer>0</integer>
  </dict>
  <key>StandardOutPath</key>
  <string>/Users/abhisheksharma/Library/Logs/stt-evals-backup.log</string>
  <key>StandardErrorPath</key>
  <string>/Users/abhisheksharma/Library/Logs/stt-evals-backup.log</string>
</dict>
</plist>
```

`PATH` is set explicitly because a launchd agent starts with a bare
`/usr/bin:/bin:/usr/sbin:/sbin` and would never find `docker`. Load it, reload
it after an edit, or remove it:

```bash
launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/ai.ellavox.stt-evals.backup.plist
launchctl bootout   gui/$(id -u)/ai.ellavox.stt-evals.backup   # bootstrap again to reload
```

## When something is half-deployed

- **Port still held after the kill**: the script waits 10 s then exits.
  `lsof -ti:8177 -sTCP:LISTEN` shows the pid; kill that pid, re-run.
- **Healthz answers with the old sha**: the new process failed to start and
  something else re-bound the port (a `pnpm dev` in another terminal, for
  instance). Check the log, stop the other process by pid.
- **Typecheck fails**: nothing was built or stopped. Fix the code.
