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
is never reverted blind.

## When something is half-deployed

- **Port still held after the kill**: the script waits 10 s then exits.
  `lsof -ti:8177 -sTCP:LISTEN` shows the pid; kill that pid, re-run.
- **Healthz answers with the old sha**: the new process failed to start and
  something else re-bound the port (a `pnpm dev` in another terminal, for
  instance). Check the log, stop the other process by pid.
- **Typecheck fails**: nothing was built or stopped. Fix the code.
