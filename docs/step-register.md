# Step register — one step, one PR, one win

**Standard:** `~/.claude/skills/mystandard/SKILL.md`. Read it before adding a step.

Every step below stands alone. A model with no memory of the conversation that produced
it should be able to open this file, read one step, and do it — without asking what was
meant. If a step needs something only a past session knows, the step is wrong.

**Status legend:** `todo` · `blocked` (waiting on Abhishek, says why) · `done` (says what
was learned, not just a tick).

**Ship a step:** branch → do exactly that step → typecheck + tests → prove by breaking →
self-review → PR → CI → squash-merge → fast-forward → deploy → verify live → mark done.

---

## Where the steps come from

`docs/PRD-v6-measure.md` (measurement — the reference, the audio, the product under
test) and `docs/PRD-v5-optimize.md` (Setup polish, Tune mode) hold the reasoning. This
file holds the work. Only the parts that have been **grilled and settled** appear as
steps; the rest are listed at the bottom with the questions that must be answered before
they can be stepped. **Order as of 2026-09-04: Part M first (M-1 … M-21), then S-2 … S-7.**

---

## Part 0 — Housekeeping

### S-0.1 — Finish moving the working copy out of `/tmp`

**Status:** `done` 2026-09-04. Learned: the sweep took the old `.env` too before it could be
copied, so the keys were recovered from the still-running API process through Node's
localhost inspector (recipe in `docs/runbooks/working-copy-location.md`), with Abhishek's
explicit go. Deployed `91c2405b0ec8 → eaaf9ccbd940`; process cwd, 101 cached audio files,
3 Vapi accounts and every keyed vendor `ready` verified live. Also learned: CLAUDE.md
was stale on two facts (ElevenLabs and OpenAI keys exist; a third Vapi account, Leasing
Dev, exists) — corrected where made.
**PR:** one (this row's docs PR is the first half; the second half is a deploy, no code).
**Depends on:** nothing.
**Files:** none in the tree. Disk only: `~/gh-projects/stt-evals-recovered` (fresh clone,
fsck clean, typecheck clean, 101 audio files copied into
`artifacts/api-server/audio-cache/`).
**Today:** the API on `:8177` still runs from the swept scratchpad clone under
`/private/tmp` (process cwd), whose `node_modules` no longer typechecks; Claude Code
sessions still open there. Full story: `docs/runbooks/working-copy-location.md`.
**Change:** once `.env` is in place — `scripts/deploy-api.sh` from the new clone (it
stops the `:8177` process by PID and starts the new build from
`artifacts/api-server`, so `audio-cache/` resolves), then restart Claude Code from
`~/gh-projects/stt-evals-recovered`. The old scratchpad clone is then dead weight; leave
it or delete it, nothing depends on it.
**Acceptance:** WHEN `/api/healthz` is polled THEN `commitSha` SHALL equal
`git rev-parse --short=12 HEAD` of the new clone, the listening process's cwd SHALL be
under `~/gh-projects/stt-evals-recovered`, and every provider that read `configured`
before the move SHALL read `configured` after it.
**Verify:**
```
cd ~/gh-projects/stt-evals-recovered && scripts/deploy-api.sh
curl -s localhost:8177/api/healthz
for p in $(lsof -nP -iTCP:8177 -sTCP:LISTEN -t); do lsof -p $p | awk '$4=="cwd"{print $NF}'; done
curl -s localhost:8177/api/benchmark/calls | jq '[.[]|select(.audioCached)]|length'   # 101
```
**Must not:** print, log or commit anything from `.env`; run any STT provider; touch
the database.

---

## Part M — Measure the thing the client actually runs (`docs/PRD-v6-measure.md`)

Order agreed with Abhishek 2026-09-04: truth → bind → backup → customer channel → verdict
wording → streaming → anchors → scheduler and band → boosts → then Part A/C below (S-2 …
S-7). Take M-1 first. Every step here spends nothing unless its **Must not** says
otherwise; the streaming steps name their spend.

### M-1 — Clear the 19 draft-copied gold transcripts

**Status:** `done` 2026-09-04 (PR #77, `856059dd26e5`). Applied live: `cleared 19; draft
copies now 0; calls still carrying gold: 2`, both remaining ones differing from their
draft; 19 audit rows written; all 121 calls still `ready_to_run` and all 994 score rows
untouched. Learned: (a) an idempotent guard has to be *inside* the update, not only in
the select — the update repeats `gold = draft` in its own `where`, which is why a second
`--apply` writes nothing and adds no audit row; (b) running the shared door found a real
bug in a neighbour, `backfill-t65-t66.ts`'s price guard compares a Postgres `real`
column to a numeric literal, so it fires every time and had already written a second
audit row — queued as M-1a; (c) no deploy was needed, the write is database-only and
the live API reads it immediately.
**PR:** one.
**Depends on:** nothing.
**Files:** new file artifacts/api-server/src/backfill-m1-clear-draft-gold.ts (plain: not
written yet), one entry in `scripts/apply-backfills.sh`, one section in
`docs/runbooks/pending-backfills.md`.
**Today:** 21 calls have a `goldTranscript`; 19 are byte-identical to their
`draftTranscript` (written by actor `claude-pipeline-test` on 2026-08-24 — audit log,
`call:update`). They are Vapi's own live output with `AI:` / `User:` labels, not a
reference. Every WER on them is wrong by construction (rush set reads 0.62–0.71).
**Change:** a script in the shape of `artifacts/api-server/src/backfill-t65-t66.ts`
(dry run by default, `--apply` writes): select calls where `gold_transcript IS NOT NULL
AND gold_transcript = draft_transcript`; set `gold_transcript = NULL`; write one audit row
per call through `writeAudit` in `artifacts/api-server/src/lib/audit.ts` (entity `call`,
action `update`, actor `backfill-m1-clear-draft-gold`, before/after carrying the two
fields). Leave `status` as is (`ready_to_run`; gold is optional). Do not touch the two
calls whose gold differs from the draft (`3559ea45…`, `64d8f463…`). Existing
`benchmark_scores` rows are untouched (history; the run manifest explains them).
**Acceptance:** WHEN the backfill has been applied THEN `GET /benchmark/calls` SHALL
return exactly 2 calls with a non-empty `goldTranscript`, both differing from their
`draftTranscript`, and the audit log SHALL hold 19 rows with actor
`backfill-m1-clear-draft-gold`.
**Verify:**
```
bash scripts/apply-backfills.sh            # dry run prints "19 to clear"
bash scripts/apply-backfills.sh --apply
curl -s localhost:8177/api/benchmark/calls | jq '[.[]|select(.goldTranscript!=null and .goldTranscript!="")]|length'   # 2
curl -s "localhost:8177/api/benchmark/audit-log?limit=2000" | jq '[.[]|select(.actorLabel=="backfill-m1-clear-draft-gold")]|length'  # 19
```
**Must not:** delete score rows, change any call's status, or touch the 2 human-edited
gold texts.

---

### M-1a — The T-62 flux reprice must stop firing on every apply

**Status:** `done` 2026-09-04 (PR #78, `6e0214b`). Live after the fix:
`bash scripts/apply-backfills.sh --apply` prints `flux repriced 0` and all three
scripts no-op (`written 0`, `M-1: 0 to clear`); `audit_log` rows with actor
`backfill-t65-t66` stayed at 2. Learned: (1) **the tolerance alone would not have
met the acceptance** — the audit insert was unconditional, so a no-op apply still
wrote a row; it is now guarded on `relinked + reclassified + repriced > 0`.
(2) Node's ambient env beats `--env-file`, so the break-proof ran against a
`pg_dump` copy (`stt_evals_m1a_dev`, dropped after) instead of live: old guard →
`flux repriced 1` and audit 2 → 3; new guard → `flux repriced 0` and audit 2 → 2.
(3) A float4 column never equals its own decimal literal — compare on a
tolerance, or cast, any time a guard reads a `real`.

**PR:** one.
**Depends on:** nothing (found while running M-1's verify, 2026-09-04).
**Files:** `artifacts/api-server/src/backfill-t65-t66.ts` (the `repriced` update and its
header comment), `docs/runbooks/pending-backfills.md` (the "every count should read 0"
sentence).
**Today:** the guard is `cost_per_minute <> 0.0077`, but
`benchmark_providers.cost_per_minute` is a Postgres `real`. Comparing it to the numeric
literal promotes the stored value to `0.007699999958276749`, which never equals `0.0077`,
so the update matches on every `--apply`. Live proof after T-111 already applied it on
2026-08-30: today's run printed `flux repriced 1 (now 0.007699999958276749)` and
`audit_log` holds two `backfill-t65-t66` rows, one per apply. The written value is
correct, so nothing is broken — but the script's header ("re-running finds nothing to
change") and the runbook ("every count should read 0 and the flux price 0.0077") are
both wrong as written.
**Change:** compare with a tolerance —
`where id = 'deepgram-flux-general-en' and abs(cost_per_minute - 0.0077) > 1e-9` — so a
row already at the price is not rewritten. Correct the two sentences named above to say
what the dry run really prints.
**Acceptance:** WHEN `bash scripts/apply-backfills.sh --apply` is run twice in a row
THEN the second run SHALL print `flux repriced 0` and `audit_log` SHALL gain no new
`backfill-t65-t66` row.
**Verify:**
```
bash scripts/apply-backfills.sh --apply | grep "flux repriced"     # flux repriced 0
docker exec stt-evals-pg psql -U postgres -d stt_evals -tAc \
  "select count(*) from audit_log where actor_label='backfill-t65-t66';"   # unchanged
```
**Must not:** change the price itself, touch the T-65/T-63/T-66 clauses, or run any STT
provider.

---

### M-2 — Speaker labels never count as words

**Status:** `done` 2026-09-04 (PR #79, `7b5c629`, deployed `7b5c62927927`).
Live proof on call `e38b42af-31f2-41e9-90ef-62d4f21f8fb0` (draft has 6 `AI:` /
`User:` lines): the AssemblyAI diff now starts at `this`, holds **0** `ai`/`user`
tokens in 134 reference words, and reads WER **0.0746** — it was 16 errors over
140 words, **0.1143**, a third of which was the labels. Learned: (1)
`canonicalTranscript()` needed no edit — it composes `normalizeTranscript()`, so
flags, spans and words-to-watch inherited the strip for free. (2) The two tests
had to be split so the mid-line case passes **with and without** the strip;
first draft put an `AI:`-prefixed assertion in it, both failed on the break, and
a test that only fails alongside the other one proves nothing extra. (3) Stored
rows keep `scoringVersion: "v2"` and their old charge — that is what the field
is for; nothing was re-scored.

**PR:** one.
**Depends on:** nothing (M-1 removes today's cases; this protects the manual path).
**Files:** `lib/scoring/src/index.ts` (`normalizeTranscript()`, `SCORING_VERSION`),
`lib/scoring/src/index.test.ts`, `docs/scoring-policy.md`.
**Today:** a gold or draft text in Vapi's format (`AI: …` / `User: …` lines) keeps `ai`
and `user` as words after normalisation, so a provider is charged one deletion per line.
The call comparison (`artifacts/api-server/src/lib/call-comparison.ts`) uses the draft
as the reference when no gold exists, so its diff carries that noise on every call.
**Change:** in `normalizeTranscript()`, before lower-casing, strip a line-leading
`AI:` or `User:` (the two labels Vapi writes; match `^(AI|User):\s*` per line, case as
written). Bump `SCORING_VERSION` to `v3`. Document as rule 0 in `docs/scoring-policy.md`
("When any of this changes" says to bump the version in the same commit — do that).
**Acceptance:** WHEN gold `AI: hello there\nUser: hi` is scored against hypothesis
`hello there hi` THEN WER SHALL be 0, and a transcript containing the word "user" mid-line
("the user said no") SHALL keep it.
**Verify:** `cd lib/scoring && pnpm run test` — two new cases (the label case, the
mid-line case). Prove by breaking: remove the strip, the first case fails, the second
still passes.
**Must not:** fold anything else; `canonicalTranscript()` is untouched.

---

### M-3 — The API listens on localhost only

**Status:** `done` 2026-09-04 (PR #80, `7844973`, deployed `78449739a880`).
Live: `lsof` reads `127.0.0.1:8177`, `localhost/api/healthz` 200, the LAN
address refused. Proved by breaking on a scratch port `:8178` against the
built bundle — with the fix `127.0.0.1:8178` and the LAN refused (curl exit
7); with the fix removed and rebuilt, `*:8178` and the LAN answered **200**;
with the fix and `HOST=0.0.0.0`, `*:8178` and 200 again, so the documented
escape hatch really works through the deploy script's `nohup node
--env-file-if-exists=.env` (ambient env beats `--env-file`, and `.env` sets no
`HOST`). Learned: (1) **This did not close the network path.** The UI is a
second process and `vite.config.ts` binds `0.0.0.0` and proxies `/api`
server-side, so `http://<lan-ip>:5173/api/healthz` still answers 200 — logged
in the backlog, queued as M-3a. When a service is split across two processes,
binding one proves nothing about reachability; test the address a person types.
(2) **The second half of the acceptance below was never true** — the API
serves nothing but `/api` (`app.ts` says so in a comment; `GET /` answers
`{"error":"No such endpoint: GET /"}`). This step is recorded as meeting its
first clause only; the runbook line that made the same claim is corrected.
(3) `git checkout HEAD~1 -- <file>` writes the **index** as well, so the
follow-up `git checkout -- <file>` restores that stale index, not HEAD — the
break-proof looked restored and was not. Use `git restore --source=HEAD
--staged --worktree <file>`, and read `git status --porcelain` rather than
trusting an `echo`.

**PR:** one.
**Depends on:** nothing.
**Files:** `artifacts/api-server/src/index.ts` (`app.listen(port, …)`),
`docs/runbooks/deploy-and-rollback.md`.
**Today:** `lsof -nP -iTCP:8177 -sTCP:LISTEN` shows `*:8177` — every interface, no
auth. Anyone on the same network can launch a bulk (spends money) or read call audio.
**Change:** `app.listen(port, process.env.HOST ?? "127.0.0.1", …)`. The UI is served by
the same process, so `http://localhost:8177` keeps working. Note the `HOST` override in
the runbook.
**Acceptance:** WHEN the API starts without `HOST` THEN it SHALL listen on
`127.0.0.1:8177` only. (The clause "and the UI SHALL load at
`http://localhost:8177`" was struck on 2026-09-04: the API has never served the
UI — that is Vite on `:5173`.)
**Verify:**
```
scripts/deploy-api.sh
lsof -nP -iTCP:8177 -sTCP:LISTEN | tail -n +2 | awk '{print $9}'   # 127.0.0.1:8177
curl -s -o /dev/null -w '%{http_code}\n' localhost:8177/api/healthz  # 200
```
**Must not:** add auth, change the port, or touch the deploy script's PID logic.

---

### M-3b — A refused launch says which filter emptied the selection

**Status:** `done` 2026-09-04 (PR #81, `01775e0`, deployed `01775e073487`).
Live against the real corpus: `no corpus calls matched: 0 of 121 in scope
(outside the date window 107, no start date on record 14)`, and no bulk row
left behind. Learned: (1) the numbers were already computed one function away
— the wrapper `resolveCriteriaCallIds` narrowed them off. **When a refusal is
vague, look for the value the caller already had and dropped.** (2) The
buckets must NOT be re-sorted for the message: `resolveCriteriaSelection`
already orders them (count desc, ties alphabetical), and my first draft
re-sorted with a weaker tie-break, which would have let the refusal and the
preview list the same buckets in different orders. (3) `bulks.ts` opens the
database at import time, so anything in it is untestable offline — the pure
helper had to move to `lib/empty-selection.ts` before a unit test could exist.

**PR:** one.
**Depends on:** nothing.
**Files:** `artifacts/api-server/src/lib/bulks.ts` (`createBulk`, the
`BulkSelectionEmptyError` message).
**Today:** launching a bulk or a template whose criteria match nothing answers
`400 selection criteria matched no corpus calls` and stops there. The screen
shows that sentence and a person has no idea which filter did it. The system
already knows: `resolveCriteriaSelection` returns `inScopeCount` and a named
`excluded` bucket per reason (T-14), and `POST /benchmark/bulks/preview`
renders them — but `createBulk` calls `resolveCriteriaCallIds`, a wrapper that
narrows the result to `callIds` + `excludedRetentionExpiredCount` and throws
the buckets away. Found live 2026-09-04 on the "weekly lindenwood heights
chek" template (`lastNDays: 7`): 121 in scope, 107 `outside the date window`,
14 `no start date on record`, 0 matched — the newest corpus call is
2026-08-26 and the window started 2026-08-28.
**Change:** in `createBulk`, call `resolveCriteriaSelection` instead of
`resolveCriteriaCallIds` and build the message from what it returns: `no
corpus calls matched: 0 of <inScopeCount> in scope (<bucket> <count>, <bucket>
<count>, ...)`, buckets largest first. Keep the existing retention sentence as
one of those buckets — it already is one. Leave `resolveCriteriaCallIds`
alone; it is exported and named in the docs, and deleting it is not this bug.
**Acceptance:** WHEN a bulk or template launch selects no calls THEN the 400
SHALL name every exclusion bucket with its count and the in-scope total, so
`lastNDays: 7` against this corpus reads `no corpus calls matched: 0 of 121 in
scope (outside the date window 107, no start date on record 14)`.
**Verify:**
```
cd artifacts/api-server && TEST_DATABASE_URL=postgresql://postgres:postgres@localhost:5433/stt_evals_test pnpm run test:integration
```
plus live, against the real corpus:
```
curl -s -X POST localhost:8177/api/benchmark/bulks -H 'content-type: application/json' \
  -d '{"name":"m3b probe","criteria":{"lastNDays":7,"minDurationSeconds":20},"minDurationSeconds":20,"providerIds":["deepgram-nova-3"]}'
```
→ 400 whose message names the buckets. **This call is safe: it is refused
before anything is created, so it spends nothing.** Prove by breaking: put the
bare sentence back, watch the new test fail.
**Must not:** change which calls are selected, the duration defaults, the cost
gate, or launch anything.

---

### M-3c — Evicting a bulk must not trip over its agent scans

**Status:** `done` 2026-09-04 (PR #82, `a1712f4`, deployed `a1712f44618b`) —
**and incomplete; finished by M-3d.** It detached `run_id` and the next live
launch failed on `agent_pick_result_id`, the same table's other no-cascade
reference. Learned, and the reason M-3d exists: **the test's scan row was
thinner than a production one** — it set only `runId`, so a half fix passed.
A fixture that omits a column cannot fail on that column.

**PR:** one.
**Depends on:** nothing.
**Files:** `artifacts/api-server/src/lib/bulks.ts` (the FR-BLK-10 eviction
block in `createBulk`),
`artifacts/api-server/src/routes/__integration__/bulk-eviction.int.test.ts`
(new), `artifacts/api-server/src/routes/__integration__/fixtures.ts`
(`adoptBulk`).
**Today:** every bulk launch answers **500** once `MAX_LIVE_BULKS` (3) is
reached. FR-BLK-10 evicts the oldest bulk in the same transaction and lets the
delete cascade into `benchmark_runs`, but `benchmark_agent_scans.run_id`
carries a plain reference with no `ON DELETE`, so a scan row blocks the
cascade and the whole transaction rolls back:
`update or delete on table "benchmark_runs" violates foreign key constraint
"benchmark_agent_scans_run_id_benchmark_runs_id_fk"`. The eviction code
already handles `benchmark_rankings` explicitly for exactly this reason; the
scans were folded into the run executor later (`e0399cc`, 2026-08-27) and
nobody came back. `fixtures.ts`'s own cleanup comment has described the trap
since batch 18 — only the tests ever worked around it. Found live 2026-09-04
launching the `weekly lindenwood heights chek` template.
**Change:** in the eviction block, before deleting the bulk, set `run_id =
null` on every scan whose run belongs to the evicted bulk, using the same
subquery shape the rankings delete uses. **Detach, do not delete:** a scan is
keyed by `call_id`, the corpus is never touched by eviction, and the judge
verdict on it cost real OpenAI money. Every run-scoped query matches on
`runId` with `eq`/`inArray`, so a null simply stops matching the run that no
longer exists, while the call comparison still finds the verdict by `callId`.
**Acceptance:** WHEN a bulk is created at the cap AND the oldest bulk has a
run with an agent scan THEN the create SHALL answer 201, the oldest bulk SHALL
be gone, and that scan SHALL still exist with `runId` null and its `callId`
unchanged.
**Verify:**
```
cd artifacts/api-server && TEST_DATABASE_URL=postgresql://postgres:postgres@localhost:5433/stt_evals_test pnpm run test:integration
```
Prove by breaking: remove the update, watch that one test fail with the
foreign-key violation.
**Must not:** change the schema (no `drizzle-kit push`), delete any scan row,
touch the corpus, change `MAX_LIVE_BULKS`, or alter the cost gate.

---

### M-3d — The other no-cascade reference on the same table

**Status:** `done` 2026-09-04 (PR #83, `24ff70f`, deployed `24ff70ffe090`).
The template then launched for real: `weekly lindenwood heights chek
2026-09-04`, 54 calls, $1.66 estimated. Learned: (1) after a
foreign-key failure, **ask `pg_constraint` for every non-cascading key into
the whole delete path** instead of fixing the one in the error — two fixes
and two deploys became one question. (2) The strengthened test fails on
exactly the live constraint when only M-3c's half is applied, which is what
makes it a real guard rather than a second copy of M-3c's.

**PR:** one.
**Depends on:** M-3c.
**Files:** `artifacts/api-server/src/lib/bulks.ts` (the FR-BLK-10 eviction
block), `artifacts/api-server/src/routes/__integration__/bulk-eviction.int.test.ts`.
**Today:** M-3c detached `benchmark_agent_scans.run_id` before eviction and
the very next live launch still answered 500 --
`update or delete on table "benchmark_provider_call_results" violates foreign
key constraint "benchmark_agent_scans_agent_pick_result_id_..."`. The same
table carries a second plain reference, `agent_pick_result_id`, into a result
cell that cascades from the run. M-3c's test set only `runId` on its scan, so
a fixture thinner than a production row passed a half fix.
**Change:** in the same eviction block, before the delete, also set
`agent_pick_result_id = null` on scans whose picked result belongs to a run of
the evicted bulk (join results to runs on `bulkId`). Give the test's scan both
pointers so it models a real row.
**Acceptance:** WHEN a bulk is created at the cap AND the oldest bulk has a
run with a scan that carries BOTH `runId` and `agentPickResultId` THEN the
create SHALL answer 201 and the scan SHALL survive with both null, its
`callId` and `status` unchanged.
**Verify:**
```
cd artifacts/api-server && TEST_DATABASE_URL=postgresql://postgres:postgres@localhost:5433/stt_evals_test pnpm run test:integration
```
Prove by breaking: remove either update, watch that one test fail on the
matching constraint.
**Must not:** change the schema, delete any scan row, or touch the corpus.

**Checked, not guessed:** `pg_constraint` says these two are the ONLY foreign
keys into the `benchmark_bulks -> benchmark_runs -> benchmark_provider_call_results
-> benchmark_scores` cascade that are not themselves `ON DELETE CASCADE`.
Query kept here so the next person does not have to re-derive it:
```sql
select cl.relname, att.attname, cl2.relname, con.confdeltype
from pg_constraint con
join pg_class cl on cl.oid = con.conrelid
join pg_class cl2 on cl2.oid = con.confrelid
join unnest(con.conkey) k(attnum) on true
join pg_attribute att on att.attrelid = cl.oid and att.attnum = k.attnum
where con.contype = 'f'
  and cl2.relname in ('benchmark_bulks','benchmark_runs',
                      'benchmark_provider_call_results','benchmark_scores');
```

---

### M-3a — The UI server listens on localhost too

**PR:** one.
**Depends on:** M-3 (done).
**Files:** `artifacts/stt-benchmark/vite.config.ts` (`server.host`,
`preview.host`), `docs/runbooks/deploy-and-rollback.md` ("Where it listens").
**Today:** M-3 made the API loopback-only, and the LAN reaches it anyway
through the UI. `vite.config.ts` sets `host: '0.0.0.0'` on both `server` and
`preview`, and proxies `/api` to `API_PROXY_TARGET` **from this machine**, so
loopback on the API is no obstacle. Measured 2026-09-04:
`curl http://192.168.1.9:5173/` → 200 and
`curl http://192.168.1.9:5173/api/healthz` → 200 with the live `commitSha`.
There is no auth on any of it and Launch spends real provider money.
**Change:** in `vite.config.ts`, both `server.host` and `preview.host` become
`process.env.UI_HOST ?? '127.0.0.1'`. Leave `allowedHosts` alone — it decides
which `Host:` headers are accepted, not which interfaces are bound, and with a
loopback bind it cannot be reached from off-machine anyway. Add the `UI_HOST`
override to the runbook's "Where it listens" beside `HOST`, and delete the
warning there that says the fence is incomplete.
**Acceptance:** WHEN `pnpm dev` runs without `UI_HOST` THEN `lsof -nP
-iTCP:5173 -sTCP:LISTEN` SHALL read `127.0.0.1:5173`, `http://localhost:5173`
SHALL load the UI, and `curl --max-time 4 http://<this machine's LAN
IP>:5173/api/healthz` SHALL fail to connect.
**Verify:**
```
lsof -nP -iTCP:5173 -sTCP:LISTEN | tail -n +2 | awk '{print $9}'   # 127.0.0.1:5173
curl -s -o /dev/null -w '%{http_code}\n' localhost:5173           # 200
curl -s --max-time 4 -o /dev/null -w '%{http_code}\n' http://$(ipconfig getifaddr en0):5173/api/healthz   # 000
```
Prove by breaking: put `'0.0.0.0'` back, restart the dev server, watch the LAN
curl answer 200 again.
**Must not:** add auth, change the port, touch `strictPort`, the proxy, or the
API's own binding.

---

### M-4 — A nightly database backup, with a restore that has been exercised

**PR:** one.
**Depends on:** nothing.
**Files:** new file scripts/backup-db.sh (plain: not written yet), new launchd plist
under `~/Library/LaunchAgents/` (outside the repo; its contents go in the runbook),
`docs/runbooks/deploy-and-rollback.md` (restore recipe),
`docs/runbooks/working-copy-location.md` ("what lives only on disk" gains the backup
folder).
**Today:** no backup exists. The corpus, every paid raw provider output and every score
live in the Docker volume of container `stt-evals-pg` (`postgres:16-alpine`, port 5433).
**Change:** the new scripts/backup-db.sh runs `docker exec stt-evals-pg pg_dump -U postgres -Fc
<db>` (the database name is the last path segment of `DATABASE_URL` in
`artifacts/api-server/.env` — read it, never print it) into
`~/gh-projects/stt-evals-backups/stt-evals-YYYY-MM-DD.dump`, keeps the newest 30, prints
the file size. A launchd agent (`ai.ellavox.stt-evals.backup`) runs it daily at 02:00.
The runbook gains the restore recipe (`pg_restore` into a fresh database) and records
the date it was exercised.
**Acceptance:** WHEN the script runs THEN a dump SHALL exist under
`~/gh-projects/stt-evals-backups/` and WHEN it is restored into a scratch database
`stt_evals_restore` THEN `select count(*) from benchmark_calls` SHALL equal the live count.
**Verify:**
```
bash scripts/backup-db.sh
ls -la ~/gh-projects/stt-evals-backups/ | tail -3
docker exec stt-evals-pg createdb -U postgres stt_evals_restore
docker exec -i stt-evals-pg pg_restore -U postgres -d stt_evals_restore < ~/gh-projects/stt-evals-backups/$(ls -t ~/gh-projects/stt-evals-backups | head -1)
docker exec stt-evals-pg psql -U postgres -d stt_evals_restore -c 'select count(*) from benchmark_calls'   # 121
docker exec stt-evals-pg dropdb -U postgres stt_evals_restore
launchctl list | grep stt-evals
```
**Must not:** write the dump anywhere under `/tmp` or the repo; print any value from
`.env`; drop or alter the live database.

---

### M-5 — Runs use the customer channel when it exists, and say so

**PR:** one.
**Depends on:** nothing (the 99 customer files already exist in
`artifacts/api-server/audio-cache/` as `<callId>.customer.audio`, saved 2026-09-04 by
`scripts/rescue-customer-audio.mjs`).
**Files:** `artifacts/api-server/src/lib/audio-cache.ts`,
`artifacts/api-server/src/lib/run-executor.ts` (`readCellAudio`, the manifest builder,
`aggregateRankingRows`), `lib/db/src/schema/benchmark-results.ts`,
`lib/db/src/schema/benchmark-runs.ts` (manifest type), `artifacts/api-server/src/lib/bulks.ts`
(preview / selection), `lib/db/src/schema/benchmark-bulks.ts` (criteria type),
`artifacts/api-server/src/lib/verdict.ts`, `lib/api-spec/openapi.yaml`, and a case in
`artifacts/api-server/src/routes/__integration__/`.
**Today:** every cell is transcribed from `<callId>.audio`, the mono mix — 71 % of its
words are the assistant's TTS voice. Nothing records which audio a cell used.
**Change:**
1. `audio-cache.ts`: `customerAudioPathFor(callId)` → `<callId>.customer.audio`;
   `readCellAudioSource(callId)` returns `{ bytes, source: "customer" | "mono" }`,
   preferring the customer file.
2. `run-executor.ts` `readCellAudio` uses it; the result row stores `audioSource` (new
   `text` column, values `customer` | `mono`, on `benchmark_results`; `pnpm --filter
   @workspace/db run push`); the run manifest's `calls[]` entries gain `audioSource`.
3. Bulk criteria gain `requireCustomerAudio?: boolean` (default `true` for new bulks;
   templates saved before this step read as `false` so they keep matching what they
   matched). The preview excludes calls with no customer file under a named bucket
   ("no customer-channel audio — N").
4. `aggregateRankingRows` and `bulkVerdicts` take only cells whose `audioSource` equals
   the bulk's (a bulk with `requireCustomerAudio` is `customer`; otherwise `mono`).
   Pre-existing result rows have `audioSource = null`; treat null as `mono`.
5. The spec exposes `audioSource` on the run-results row and `requireCustomerAudio` on
   bulk create/preview; `pnpm --filter @workspace/api-spec run codegen`.
**Acceptance:** WHEN a bulk is previewed on Land And Apartment with the default criteria
THEN it SHALL match only calls that have a customer file, and WHEN one of its cells
completes THEN its result row SHALL read `audioSource: "customer"`; a run over a
Default-account call SHALL read `mono` on that row.
**Verify:**
```
pnpm run typecheck
cd artifacts/api-server && TEST_DATABASE_URL=postgresql://postgres:postgres@localhost:5433/stt_evals_test pnpm run test:integration
```
New integration case: seed a call with a customer file present (write a small WAV into
the cache dir under a fixture id, clean it up), preview with default criteria → matched;
preview with `requireCustomerAudio: false` → also matched; a call without the file →
excluded under the named bucket. Prove by breaking: remove the preference in
`readCellAudioSource`, the source assertion fails. Live: launch nothing here.
**Must not:** launch or execute a run (spends money); delete or rename any cache file;
change how mono is resolved for a call with no customer file.

---

### M-6 — Import saves the customer channel, the assistant channel and the artifact

**PR:** one.
**Depends on:** M-5 (the file names).
**Files:** `artifacts/api-server/src/lib/vapi.ts` (the `VapiCall` artifact type: add
`presignedCustomerUrl`, `presignedAssistantUrl`, `messages`, `performanceMetrics` —
shapes in `docs/provider-data-samples.md`), `artifacts/api-server/src/lib/audio-cache.ts`,
`artifacts/api-server/src/routes/benchmark.ts` (the `vapi/import` handler and the
`calls/cache-audio` rescue), `artifacts/stt-benchmark/src/pages/Corpus.tsx` (the audio
chip), `lib/api-spec/openapi.yaml` (`BenchmarkCall.customerAudioCached`).
**Today:** import caches the mono file only. The customer file, the assistant file and
the artifact JSON (messages with turn timings and tool calls, `performanceMetrics`) were
saved for the 99 existing calls by hand (`scripts/rescue-customer-audio.mjs`). A call
imported tomorrow gets none of them.
**Change:** at import (and in the free `cache-audio` rescue), after the mono file:
download `presignedCustomerUrl` → `<callId>.customer.audio`, `presignedAssistantUrl` →
`<callId>.assistant.audio`, and write `<callId>.artifact.json` with `messages`,
`performanceMetrics`, `transcript`, `endedReason`, `analysis`, `costs`, `startedAt`,
`endedAt` — the same shape the rescue script writes. A missing URL is recorded in the
import outcome message, never fails the import. `BenchmarkCall` gains
`customerAudioCached` (derived from disk like `audioCached`); the Calls chip reads
"customer audio saved" when true.
**Acceptance:** WHEN a call is imported from Vapi THEN three new files SHALL exist in the
cache beside its mono file, and `GET /benchmark/calls` SHALL report
`customerAudioCached: true` for it.
**Verify:** `pnpm run typecheck`; the Calls render test
(`artifacts/stt-benchmark/src/pages/__render__/calls.test.tsx`) gains a case for the
chip; live: import one new call from the Leasing Dev account (free — a Vapi download),
then `ls artifacts/api-server/audio-cache | grep <callId>` shows four files.
**Must not:** run any STT provider; change the mono path; store the artifact anywhere
but the gitignored cache directory (it contains caller PII).

---

### M-7 — Production signals stored per call and shown

**PR:** one.
**Depends on:** M-6 (the artifact file; a one-time backfill reads the 99 saved ones).
**Files:** `lib/db/src/schema/benchmark-calls.ts`, `artifacts/api-server/src/routes/benchmark.ts`
(import handler + call mapping), new file artifacts/api-server/src/backfill-m7-production-signals.ts
(plain: not written yet) + entry in `scripts/apply-backfills.sh`, `lib/api-spec/openapi.yaml`,
`artifacts/stt-benchmark/src/pages/Corpus.tsx`, `artifacts/stt-benchmark/src/pages/Rankings.tsx`
(the production line), `artifacts/api-server/src/lib/verdict.ts` (`production` object).
**Today:** the tool knows which model production ran and nothing about how it did.
Vapi records per call: `performanceMetrics.transcriberLatencyAverage` (median 272 ms
across the 99 saved artifacts), `endpointingLatencyAverage` (median 102 ms),
`numAssistantInterrupted` (25 of 99 calls ≥ 1), plus tool calls (74 of 99) and their
results.
**Change:** four nullable columns on `benchmark_calls`:
`prodTranscriberLatencyMs` (real), `prodEndpointingLatencyMs` (real),
`prodAssistantInterruptions` (integer), `prodToolCalls` (integer). Filled at import from
the artifact; the backfill fills them from the saved `<callId>.artifact.json` files for
calls that have one. Exposed on `BenchmarkCall`. The Calls row shows "prod 272 ms" in
the measurements group; the Results org card's production line becomes "Production today:
Deepgram flux-general-en · 272 ms transcriber latency (median) · 25 of 99 calls
interrupted" from the group's calls (median, not mean; absent → "not recorded").
**Acceptance:** WHEN the backfill has run THEN `GET /benchmark/calls` SHALL carry
`prodTranscriberLatencyMs` on every call with an artifact file and null on the rest, and
WHEN the Land And Apartment card renders THEN it SHALL read a median in ms and an
interruption count, never "0" for a call with no artifact.
**Verify:** `pnpm run typecheck`; Results render test asserts the line with a fixture
median and the "not recorded" fallback; `bash scripts/apply-backfills.sh --apply`; then
`curl -s localhost:8177/api/benchmark/calls | jq '[.[]|select(.prodTranscriberLatencyMs!=null)]|length'` → 99.
**Must not:** compute a mean (one 6,651 ms call distorts it); show a zero for an absent
value.

---

### M-8 — The production transcript joins the consensus

**PR:** one.
**Depends on:** M-2 (labels stripped), M-5 (customer cells).
**Files:** `lib/scoring/src/hybrid.ts` (`computeCrossProviderDisagreement`,
`computeHybridFlags`), `lib/scoring/src/hybrid.test.ts`, `lib/scoring/src/verdict.ts`
(`vsProductionPct`, `productionProviderId`), `artifacts/api-server/src/lib/run-executor.ts`
(`computeHybridFlagsForRun` — where candidates are assembled per call),
`artifacts/api-server/src/lib/verdict.ts`, `artifacts/stt-benchmark/src/pages/Rankings.tsx`.
**Today:** production (Flux) is streaming-only and never runs here; the verdict's
"vs production" resolves to a provider row (`deepgram-flux-general-en`) that has no
cells, so the line is empty. The draft's `User:` lines ARE production's customer-channel
transcript for every call.
**Change:** `computeHybridFlagsForRun` adds one more candidate per call —
`{ providerId: "production", transcript: <the draft's User: lines joined> }` — to the
consensus input only (it gets no flags row of its own written as a provider result, and
never appears in rankings as a pickable row). `computeCrossProviderDisagreement` returns
its disagreement rate like any other candidate; the executor stores it on the run as
`productionDisagreement` per call (new jsonb on `benchmark_runs`, keyed by call id, or a
small new table — pick the smaller change and say which in the PR). `verdict.ts` reports
`vsProductionPct` from those numbers; Results' production line adds "disagreed with the
pack N.N / 100 words — vs leader M.M".
**Acceptance:** WHEN a bulk on Land And Apartment is (re-)executed THEN the verdict's
`vsProductionPct` SHALL be a number computed from the draft's customer turns, and the
Rankings table SHALL NOT contain a row named "production".
**Verify:** `cd lib/scoring && pnpm run test` — a case with three candidates plus
production where production is the outlier; `pnpm run typecheck`; the integration case
for rankings asserts no `production` row. Re-executing a bulk spends money: **do not**;
prove on the unit and integration level, and record the live number after the next
scheduled bulk (M-11's first run) instead.
**Must not:** write a `benchmark_results` row for "production"; let it be ranked or
picked; execute a run.

---

### M-9 — "Least disagreement", not "Winner", and the line that says what it is

**PR:** one.
**Depends on:** nothing.
**Files:** `artifacts/stt-benchmark/src/pages/Rankings.tsx` (the chip reading "Winner"
and the T-57 comment), `artifacts/api-server/src/lib/verdict-artefact.ts` (the
`winner: "Winner"` label and the explanatory paragraph),
`artifacts/stt-benchmark/src/pages/__render__/results.test.tsx`,
`artifacts/api-server/src/lib/verdict-artefact.test.ts`.
**Today:** rank 1 with a settled verdict is chipped "Winner". A client reading it hears
"most accurate". Nothing on the page says the number is relative.
**Change:** chip and artefact label read **"Least disagreement"**. Under the verdict, one
permanent muted line: *"Relative: how often each provider disagreed with the others on
the same customer audio. Not a measured accuracy — no transcript here was checked by a
person."* The artefact paragraph that begins "**Winner** = fewest disagreements…" is
rewritten to start with "**Least disagreement** = …" and to end with the same sentence.
(M-18 appends the agreement figure to this line later.)
**Acceptance:** WHEN Results or `verdict.html` renders a settled verdict THEN the word
"Winner" SHALL NOT appear anywhere in the rendered output, and the relative line SHALL
be visible without interaction.
**Verify:** `cd artifacts/stt-benchmark && pnpm run test` (results test asserts the chip
text and the line); `cd artifacts/api-server && pnpm run test` (artefact test asserts no
"Winner" in the HTML and the line present); `grep -rn "Winner" artifacts/stt-benchmark/src artifacts/api-server/src | grep -v test` → comments only.
**Must not:** change `decision` values in `lib/scoring/src/verdict.ts` (`"winner"` stays
as an enum value — it is code, not copy).

---

### M-10 — Latency means end-of-speech latency, or nothing

**PR:** one.
**Depends on:** M-5 (`audioSource` exists; batch vs streaming is known per provider row
via `supportsStreaming` on `benchmark_providers`, but that flag today means "the vendor
can stream", not "this row streams" — this step fixes the meaning).
**Files:** `lib/db/src/schema/benchmark-providers.ts` (new `mode: "batch" | "streaming"`,
default `batch`; the Cartesia row is `streaming`), `lib/scoring/src/hybrid.ts`
(`hybridCompositeScore`, `HYBRID_RANKING_WEIGHTS`), `lib/scoring/src/hybrid.test.ts`,
`artifacts/api-server/src/lib/run-executor.ts` (`aggregateRankingRows` — pass the mode),
`artifacts/stt-benchmark/src/pages/Rankings.tsx` ("Speed" column label and hover),
`lib/api-spec/openapi.yaml`.
**Today:** `latencyFinalMs` is file turnaround for batch rows (10 s for a 30 s call means
nothing to a voice agent) and roughly the call's length for Cartesia (our adapter streams
at real time). It is 15 % of the composite; it punishes the streaming adapter and rewards
the fastest batch API.
**Change:** for `mode = batch` rows the latency component is dropped (weight
redistributed: flags 0.85, cost 0.15); for `mode = streaming` rows latency is
end-of-audio → final (what the Cartesia adapter already measures from the last chunk),
and the composite keeps flags 0.70 / latency 0.15 / cost 0.15. The "Speed" column reads
"—" with hover "batch API: file turnaround, not comparable" for batch rows, and "end of
speech → final, median" for streaming rows; production's own transcriber latency (M-7)
is printed in the column header for the group.
**Acceptance:** WHEN rankings are computed for a bulk with batch rows THEN changing any
batch row's `latencyFinalMs` SHALL NOT change any rank, and WHEN a streaming row is
present THEN its latency SHALL feed its composite.
**Verify:** `cd lib/scoring && pnpm run test` — two cases (batch latency inert; streaming
latency active). Prove by breaking: restore the old weights, the first case fails.
`pnpm run typecheck`; Results render test for the column text.
**Must not:** touch cost or flag weights for streaming rows; change stored score rows.

---

### M-11 — Deepgram streaming rows: nova-3 and Flux

**PR:** one.
**Depends on:** M-5 (customer audio), M-10 (`mode`).
**Files:** new file lib/stt-providers/src/adapters/deepgram-streaming.ts (plain: not
written yet), `lib/stt-providers/src/registry.ts` (`providerCatalog` entries
`deepgram-nova-3-streaming`, `deepgram-flux-general-en-streaming`),
`lib/stt-providers/src/adapters/parsers.test.ts` (reduce a recorded message sequence to
a final transcript + first-partial time, as the Cartesia tests do),
`docs/provider-data-samples.md` (one real Flux message sample, redacted).
**Today:** every Deepgram row calls `POST /v1/listen` (batch). Flux — production for 86
of 121 calls — has no batch endpoint and cannot be run.
**Change:** a WebSocket adapter modelled on `lib/stt-providers/src/adapters/cartesia.ts`:
`wss://api.deepgram.com/v1/listen?model=nova-3&encoding=linear16&sample_rate=16000…` for
nova-3 and `wss://api.deepgram.com/v2/listen?model=flux-general-en…` for Flux (Flux
requires v2). Audio is sent in 20 ms chunks paced at real time from the customer file;
`firstPartialAt` = first non-empty transcript message; `finalAt` = the final transcript
after the close/finalize message; `latencyFinalMs` is measured from the moment the last
audio chunk was sent (end of speech), not from the first. Raw output = the full message
log. Price: nova-3 streaming $0.0043/min (list), Flux $0.0065/min (Deepgram pricing page,
read 2026-09-04) — both rows created `mode: streaming`, disabled until the first live
check passes.
**Acceptance:** WHEN one cached customer file is streamed at real time to each row THEN
the cell SHALL store a final transcript, a `latencyFinalMs` under 2,000 ms, a
`firstPartialAt`, and a raw message log — and the adapter SHALL never send faster than
real time.
**Verify:** `pnpm run typecheck`; `cd lib/stt-providers && pnpm run test` (parser cases
on a recorded sample). Live, with the go already given ("spend $3–5", 2026-09-04): an
ad-hoc run of ONE Land And Apartment call on both rows (≈ $0.02), then read the result
rows. Record the two latencies in the PR body.
**Must not:** run more than one call before the single-call check is green; enable the
rows for bulks before Abhishek sees the first numbers; send audio faster than real time.

---

### M-12 — AssemblyAI Universal-Streaming row

**PR:** one.
**Depends on:** M-11 (the streaming adapter pattern and the `mode` plumbing are proven).
**Files:** new file lib/stt-providers/src/adapters/assemblyai-streaming.ts (plain),
`lib/stt-providers/src/registry.ts`, `lib/stt-providers/src/adapters/parsers.test.ts`,
`docs/provider-data-samples.md`.
**Today:** AssemblyAI runs batch (`/v2/upload` + `/v2/transcript`).
**Change:** Universal-Streaming WebSocket per AssemblyAI's streaming docs, same pacing and
timing rules as M-11; row `assemblyai-universal-streaming`, $0.15/hr (pricing page read
2026-09-04), `mode: streaming`, disabled until the single-call check passes.
**Acceptance / Verify / Must not:** as M-11, one call, ≈ $0.01.

---

### M-13 — ElevenLabs Scribe v2 Realtime row

**PR:** one.
**Depends on:** M-11.
**Files:** new file lib/stt-providers/src/adapters/elevenlabs-streaming.ts (plain),
`lib/stt-providers/src/registry.ts`, `lib/stt-providers/src/adapters/parsers.test.ts`,
`docs/provider-data-samples.md`.
**Change:** Scribe v2 Realtime WebSocket; row `elevenlabs-scribe-v2-realtime`, $0.39/hr
(ElevenLabs API pricing, read 2026-09-04); otherwise as M-11.
**Acceptance / Verify / Must not:** as M-11, one call.

---

### M-14 — Gladia live row

**PR:** one.
**Depends on:** M-11.
**Files:** new file lib/stt-providers/src/adapters/gladia-streaming.ts (plain),
`lib/stt-providers/src/registry.ts`, `lib/stt-providers/src/adapters/parsers.test.ts`,
`docs/provider-data-samples.md`.
**Change:** Gladia live v2 WebSocket (init via `POST /v2/live`, then the socket); row
`gladia-solaria-live`, $0.75/hr self-serve (read 2026-09-04); otherwise as M-11.
**Acceptance / Verify / Must not:** as M-11, one call.

---

### M-15 — Confirmed-entity references from tool calls — grill script first

**PR:** one (the script and its findings; the feature is a later step only if the numbers
justify it).
**Depends on:** M-6 (artifact files exist for the 99).
**Files:** new file artifacts/api-server/src/mine-confirmed-entities.ts (plain: not
written yet, same shape as `artifacts/api-server/src/mine-reading-pairs.ts`),
`docs/PRD-v6-measure.md` (Part D2 gets the numbers).
**Today:** 74 of 99 calls made tool calls; `fly-APPFOLIO_FIND_TENANT`, `CREATE_SHOWING`,
`FIND_SHOWING`, `AVAILABILITY`, `CREATE_WORK_ORDER`, `SEND_SMS`, `dynamic_send_email`
carry arguments the customer said (phone, email, name, date). Whether those values
appear verbatim in the customer's turns — the condition for using them as a reference —
is unknown.
**Change:** the script reads every `<callId>.artifact.json`, collects `(tool, argument
name, value)` for string arguments, checks whether the tool result reports success
(result text without `error`/`not found`, or a status field — read three real results
first and write the rule down), and whether the value (after `normalizeEntity()`) occurs
in the joined `User:` turns of the draft. Prints counts only: candidates, confirmed,
present-in-customer-turns, by tool and argument name. No values printed.
**Acceptance:** WHEN the script runs THEN it SHALL print the three counts per tool, and
the PR SHALL state whether ≥ 10 usable references exist.
**Verify:** `pnpm --filter @workspace/api-server exec tsx ./src/mine-confirmed-entities.ts`.
**Must not:** write to the database; print argument values (PII).

---

### M-16 — The selection band counts customer words

**PR:** one.
**Depends on:** nothing.
**Files:** `artifacts/api-server/src/lib/bulks.ts` (the band beside
`resolveDurationBand`), `lib/db/src/schema/benchmark-bulks.ts` (criteria type),
`lib/api-spec/openapi.yaml`, `artifacts/stt-benchmark/src/pages/Bulks.tsx` (Advanced
field + the excluded bucket), `artifacts/api-server/src/routes/__integration__/` (the
bulk preview case).
**Today:** the band is seconds (default 60–120 s). Half the corpus has ≤ 12 customer
words; a call can be 90 s of assistant speech and one customer word.
**Change:** `minCustomerWords?: number` on the criteria (default 30), counted from the
draft's `User:` lines (words = whitespace tokens after `normalizeTranscript()`); the
preview excludes under a named bucket "fewer than N customer words — M". The seconds band
stays and still applies.
**Acceptance:** WHEN a bulk is previewed with default criteria THEN every matched call
SHALL have ≥ 30 customer words and the excluded bucket SHALL name the count.
**Verify:** integration case seeds two calls (40 and 5 customer words) and asserts one
matched, one excluded under the bucket; prove by breaking (drop the filter, the
excluded call matches). `pnpm run typecheck`.
**Must not:** change the seconds band or any saved template's stored criteria.

---

### M-17 — A daily import so nothing crosses the 14-day cliff again

**PR:** one.
**Depends on:** M-6 (import saves everything worth saving).
**Files:** new file scripts/daily-import.sh (plain: not written yet), launchd plist
under `~/Library/LaunchAgents/` (contents in the runbook),
`docs/runbooks/working-copy-location.md`.
**Today:** import is a button. Vapi deletes audio after 14 days; 6 calls are gone for
good already; the 99-call client corpus was saved by hand five days before its cliff.
**Change:** the script asks `GET /benchmark/vapi/preview` per configured account for
the last 3 days, imports the ids not yet present via `POST /benchmark/vapi/import`
(`x-actor: scheduler`), and stops. Free: Vapi downloads only. A launchd agent runs it at
03:00 (after M-4's backup).
**Acceptance:** WHEN the agent runs THEN new Vapi calls from the last 3 days SHALL exist
in `benchmark_calls` with their four cache files, and the audit log SHALL show
`call:import_vapi` rows with actor `scheduler`.
**Verify:** run the script by hand once; `curl -s "localhost:8177/api/benchmark/audit-log?limit=50" | jq '[.[]|select(.actorLabel=="scheduler")]|length'` ≥ 1.
**Must not:** launch a bulk or run any provider; import calls older than the window.

---

### M-18 — The manual place counts: proxy-agreement endpoint and line

**PR:** one.
**Depends on:** M-9 (the line it appends to).
**Files:** `lib/api-spec/openapi.yaml` (`GET /benchmark/proxy-agreement`),
`artifacts/api-server/src/routes/benchmark.ts`, new file
artifacts/api-server/src/lib/proxy-agreement.ts (plain), `lib/scoring/src/verdict.ts`
or a new pure helper for Kendall τ (put it in `lib/scoring/src/`),
`artifacts/stt-benchmark/src/pages/Rankings.tsx`, `artifacts/api-server/src/routes/__integration__/`.
**Today:** the gold editor on a call exists and nothing uses what it produces.
**Change:** for every call with a human gold (`goldTranscript` non-empty and different
from `draftTranscript`), rank the providers that scored it by WER and by consensus
disagreement; report `n`, `top1Agreement` (fraction of calls where the two rankings
share a top-1) and `kendallTau` (mean over calls). `n = 0` → `{ n: 0, top1Agreement:
null, kendallTau: null }`. M-9's line gains: "On N calls a person did check, this
ranking agreed with the transcript-checked ranking X % of the time." — only when `n > 0`.
**Acceptance:** WHEN no human gold exists THEN the endpoint SHALL answer `n: 0` with
null figures and the line SHALL show nothing extra; WHEN two labelled calls exist THEN
`n` SHALL be 2 and the figures numbers in [0, 1] / [−1, 1].
**Verify:** integration case seeds two calls with gold ≠ draft and scored cells; unit
test for τ on a known permutation; render test for the line with `n: 0` and `n: 2`.
**Must not:** count a draft-copied gold; render a number when `n = 0`.

---

### M-19 — Candidates get the assistant's own boosts, and Deepgram gets `keyterm`

**PR:** one.
**Depends on:** M-5.
**Files:** `lib/stt-providers/src/adapters/deepgram.ts` (`keywords` → `keyterm` for
nova-3 and Flux; keep `keywords` for nova-2 and older), the streaming adapters from
M-11…M-14, `artifacts/api-server/src/lib/assistant-transcriber.ts` (already reads the
live config), `artifacts/api-server/src/lib/run-executor.ts` (pass `keywordBoosts`),
`artifacts/api-server/src/lib/bulks.ts` (`boosts: "production" | "none"` on the bulk),
`lib/db/src/schema/benchmark-runs.ts` (manifest gains `boostsSha256`),
`lib/api-spec/openapi.yaml`, `artifacts/stt-benchmark/src/pages/Bulks.tsx`.
**Today:** `keywordBoosts` is on the adapter input type and the executor never sets it.
Production Rush runs 120 Deepgram keyterms; every candidate runs naked. The Deepgram
adapter sends `keywords`, the Nova-2 parameter; Nova-3 and Flux take `keyterm`.
**Change:** a bulk carries `boosts` (default `none`, so nothing changes silently). With
`production`, the executor reads the assistant's transcriber config once per assistant,
takes its keyterm list, and passes it per vendor: Deepgram `keyterm` (nova-3, Flux) /
`keywords` (nova-2), AssemblyAI `word_boost` (batch) or `keyterms_prompt` (streaming),
Gladia `custom_vocabulary`, Speechmatics `additional_vocab`; vendors without a boost
parameter get none and the cell records `boostsApplied: false`. The manifest stores the
terms' SHA-256 (FR-P2, R6). Two bulks on the same calls are the paired experiment (OD-8).
**Acceptance:** WHEN a bulk with `boosts: production` runs THEN its manifest SHALL carry
`boostsSha256` and every Deepgram nova-3 request SHALL carry `keyterm` parameters; WHEN
`boosts: none` THEN no adapter SHALL receive `keywordBoosts`.
**Verify:** unit test on the Deepgram URL builder (nova-3 → `keyterm`, nova-2 →
`keywords`); integration case on the manifest hash; `pnpm run typecheck`. Live run only
with a "go spend".
**Must not:** default to `production`; send a boost list longer than the vendor's cap
(Deepgram: 100 terms / 500 tokens — truncate and record `boostsTruncated: true`).

---

### M-20 — The judge gets a scorecard only when it can be measured

**PR:** one.
**Depends on:** M-18 (the labelled set and its query).
**Files:** artifacts/api-server/src/lib/proxy-agreement.ts (created by M-18, plain),
`lib/api-spec/openapi.yaml`, `artifacts/stt-benchmark/src/pages/Rankings.tsx` (the
judge-confidence lines on the assistant card).
**Today:** the judge's pick is shown as a verdict input; its accuracy has never been
measured (the judge-accuracy report was removed in batch 4).
**Change:** for each labelled call (as M-18), the judge's pick either is or is not the
lowest-WER provider. Report `n`, `agree`, and render "judge accuracy: X % of N" when
`n ≥ 20`, else "judge accuracy: not measured (N of 20)".
**Acceptance:** WHEN fewer than 20 labelled calls exist THEN the card SHALL say "not
measured (N of 20)" and no percentage.
**Verify:** render test for both branches; integration case with two labelled calls.
**Must not:** change the judge prompt (any prompt edit needs `pnpm run judge:contract:record`, paid).

---

### M-21 — A drift canary on a fixed set

**PR:** one.
**Depends on:** M-5, M-11 (so the canary runs on customer audio and includes the
production vendor's streaming row).
**Files:** `artifacts/api-server/src/lib/trend.ts`, `lib/scoring/src/trend.ts`,
`artifacts/stt-benchmark/src/pages/Providers.tsx` (the chip),
`docs/runbooks/pending-backfills.md` (the template's call ids).
**Today:** vendors update models without notice; nothing here would notice.
**Change:** a saved bulk template "canary — 20 fixed calls" (20 named Land And Apartment
call ids with customer audio, ≥ 30 customer words each) meant to be launched monthly by
hand (about $0.50). The trend already exists; a provider whose disagreement rate on the
canary moves more than 2 points from its own median across canary bulks gets a chip on
its Setup card: "changed since last month: +2.4". Threshold from Hamming's drift guide.
**Acceptance:** WHEN two canary bulks exist and a provider moved > 2 points THEN Setup
SHALL show the chip on that provider only.
**Verify:** unit test on the chip rule with three synthetic canary points; render test.
Launching the canary is a "go spend" each time.
**Must not:** launch anything on its own; alert on non-canary bulks.

---

## Part A — Setup page

### S-1 — Group Deepgram's domain variants under their base engine

**PR:** one — #75, squash `79691057495f`, live 2026-09-04.
**Status:** `done` 2026-09-04. Learned: the register's first suggestion (strip the trailing
domain word) would have folded OpenAI's `gpt-4o-transcribe-diarize` under
`gpt-4o-transcribe` — a feature variant, not a domain — and changed a flat vendor's
appearance. The key that holds is the one Deepgram already sends: a base engine's `label`
ends in `-general`; only those three exist across every vendor's live list. Live result:
19 → 3 rows (nova-3 +1, nova-2 +11, nova +4); every other vendor byte-identical. Loop
lesson: **commit before proving by breaking** — a `git checkout -- file` used to undo a
break restored the *committed* file and silently threw away the uncommitted step.
**Depends on:** S-0.1 (every step ends with a live deploy, and deploys come from the new home).
**Files:** `artifacts/stt-benchmark/src/pages/Providers.tsx`
**Today:** the expandable catalog list renders all 19 Deepgram models as a flat list, so
`nova-2` and its eleven domain variants (`nova-2-phonecall`, `nova-2-drivethru`, …) look
like eleven unrelated engines.
**Change:** in `VendorModelsLine`'s `<details>` list, group models by their base engine.
The base is the `label` field the API already returns (`nova-2-phonecall` has
`label: "nova-2-phonecall"`; derive the base by stripping the trailing domain segment, or
group on the shared prefix among `nova-3` / `nova-2` / `nova`). Render one row per base
engine with its variant count, expandable to the variants. A vendor with no variants
(OpenAI, Cartesia) renders exactly as it does today.
**Acceptance:** WHEN the Deepgram catalog list is expanded THEN it SHALL show three base
rows (nova-3, nova-2, nova) with variant counts, and no vendor with a flat catalog SHALL
change appearance.
**Verify:**
```
cd artifacts/stt-benchmark && pnpm run test && pnpm run typecheck
```
Add a case to `src/pages/__render__/setup.test.tsx` using the existing
`ProviderModelList` fixture shape: a vendor with `nova-2` plus two `nova-2-*` variants
renders one base row reading "2 domain variants", and a single-model vendor renders one
plain row.
**Must not:** change which models are enabled, call any vendor API, or touch the provider
cards below the list.

---

### S-2 — Say what the catalog is and what the cards are

**PR:** one.
**Depends on:** nothing (independent of S-1).
**Files:** `artifacts/stt-benchmark/src/pages/Providers.tsx`
**Today:** the vendor block stacks two different kinds of thing with no explanation — the
vendor's catalog (a menu; costs nothing) and provider rows (what actually runs). A person
seeing it for the first time cannot tell them apart. This is the exact question that
produced PRD v5.
**Change:** two permanently visible one-line captions, not tooltips.
- Above the catalog list: "This vendor's own list — the models they sell. Enabling one
  adds it below. Nothing here costs money until you run a bulk with it."
- Above the provider cards: "What this tool can run. Each has its own price and its own
  results."
Both use the muted text style already used for `data-testid="agent-models-source"`.
**Acceptance:** WHEN the Setup page is open THEN both captions SHALL be visible without
hovering, clicking, or expanding anything.
**Verify:** `cd artifacts/stt-benchmark && pnpm run test` — add an assertion to
`src/pages/__render__/setup.test.tsx` that both caption strings are in the document on
first render.
**Must not:** put the explanation in a `title` attribute; the whole point is that it is
readable without interaction.

---

### S-3 — A disable action in the catalog list

**PR:** one.
**Status:** `blocked` — needs Abhishek to confirm the reading below before any code.
**Depends on:** nothing.
**Files:** `artifacts/stt-benchmark/src/pages/Providers.tsx`
**Today:** in the catalog list an unenabled model shows a clickable `enable`; an enabled
model shows the word `enabled` as dead text. The list can create a provider row but can
never switch one off — the only off switch is the button on the card further down.
**Change (pending confirmation):** every enabled row gets a `disable` action in the same
column. It sends `disabled: true` to `PATCH /benchmark/providers/{id}` for the row that
is actually enabled — **which is not always the id in the list.** For AssemblyAI,
ElevenLabs and Gladia the list shows a synthesised id that has no row behind it (see
S-4). So this step must land after S-4, or use the row id S-4 introduces.
**Acceptance:** WHEN an enabled model's `disable` is clicked THEN its provider row SHALL
read `disabled` on the card below and its historical results SHALL remain on Results.
**Verify:** `pnpm run test` in the UI package plus a live check on `nova-2`.
**Must not:** delete a provider row. Disabling keeps results (FR-P3).
**The question for Abhishek:** "give me open for disable as well" is read here as *an
option to disable from the catalog list*. If it meant something else — a detail view on
the card, or something on another page — say which screen.

---

### S-4 — Report a provider id that exists

**PR:** one.
**Depends on:** nothing.
**Files:** `artifacts/api-server/src/routes/benchmark.ts` (the `providers/models` handler,
around the `providerIdForModel` call), plus a new case in
`artifacts/api-server/src/routes/__integration__/`
**Today:** the handler always sets `providerId` to the synthesised
`<vendor>-<apiModel>`, while "is it enabled" can match the vendor's older row instead
(the `legacyDefault` path). Three ids in the live response today point at rows that do
not exist: `assemblyai-universal-3-5-pro`, `elevenlabs-scribe-v2`, `gladia-solaria-1`.
The real rows are `assemblyai-universal`, `elevenlabs-scribe`, `gladia-solaria`. Nothing
follows that id yet, so nothing is broken — it is a trap for the next consumer.
**Change:** when `enabledAs` resolves to the legacy row, report that id as `providerId`.
When the model is not enabled, keep the synthesised id (it is what the enable call will
create).
**Acceptance:** WHEN `GET /benchmark/providers/models` returns a model with
`enabled: true` THEN its `providerId` SHALL appear in `GET /benchmark/providers`.
**Verify:**
```
cd artifacts/api-server && TEST_DATABASE_URL=postgresql://postgres:postgres@localhost:5433/stt_evals_test pnpm run test:integration
```
New integration test seeds a legacy-named provider row, asks the models route, and
asserts every enabled `providerId` is in the providers list. Prove it by breaking:
restore the unconditional synthesised id and watch exactly that test fail.
**Must not:** rename any existing provider row, or change which models read as enabled.

---

### S-5 — Name a provider the vendor's list API does not return

**PR:** one.
**Depends on:** S-1 is not required; S-2 is not required.
**Files:** `artifacts/stt-benchmark/src/pages/Providers.tsx`
**Today:** `deepgram-flux-general-en` is a provider row here and is what the Rush
assistant runs in production, but Deepgram's model-list API never returns it, so it is
absent from the catalog and the "Newest" line structurally cannot see it. Nothing on
screen says so, which reads as the row being stale or wrong.
**Change:** in each vendor block, compare that vendor's provider rows against the models
in its catalog. For any row with no catalog entry, add one muted line naming it: "1
provider row is not in this vendor's list API (flux-general-en) — a separate product, not
a missing model." Plural when more than one.
**Acceptance:** WHEN the Deepgram block renders AND `deepgram-flux-general-en` exists as
a provider row THEN the block SHALL name it as absent from the vendor's list, and no
vendor whose rows all appear in its catalog SHALL show the line.
**Verify:** `cd artifacts/stt-benchmark && pnpm run test` — a fixture with one row absent
from the catalog shows the line; a fixture where every row is in the catalog does not.
**Must not:** mark the row stale, disabled, or in error. It works; it is just not listed.

---

## Part C — Naming and density

### S-6 — The Calls table says Org, not Vertical

**PR:** one.
**Depends on:** nothing.
**Files:** `artifacts/stt-benchmark/src/pages/Corpus.tsx`
**Today:** the Calls table has a **Vertical** column and an "All verticals" filter.
`vertical` is an internal tag (`rush`, `property_management`, `trucking`); the org — the
Vapi account, already grouped in the table — is what a person recognises.
**Change:** the column header and the filter become **Org**, showing
`sourceAccountLabel` (falling back to "Unlabelled org" as the grouping rows already do).
The filter's options come from the account labels present in the loaded calls. `vertical`
stays in the data, in the API, and in the CSV export — it is only leaving the screen.
**Acceptance:** WHEN the Calls page renders THEN no visible text SHALL contain the word
"vertical", and the filter SHALL narrow rows by account label.
**Verify:** `cd artifacts/stt-benchmark && pnpm run test`. Extend
`src/pages/__render__/calls.test.tsx`: the fixture already has two account labels
("Default", "Land And Apartment"); assert the header reads Org, filtering by one label
leaves only its rows, and `document.body.textContent` does not contain "ertical".
**Must not:** remove `vertical` from the API response, the CSV export, or the database.

---

### S-7 — One table style, properly spaced

**PR:** one.
**Depends on:** S-6 should land first so the Calls table is not restyled twice.
**Files:** `artifacts/stt-benchmark/src/components/ui/table.tsx`, and remove per-page
padding overrides in `artifacts/stt-benchmark/src/pages/Corpus.tsx`,
`artifacts/stt-benchmark/src/pages/Rankings.tsx`,
`artifacts/stt-benchmark/src/pages/Bulks.tsx`
**Today:** rows are cramped and column groups run together, so identity, measurements,
money and actions read as one undifferentiated band. Each page has its own padding
overrides, so the four tables do not match.
**Change:** in the shared table component set one row height, one cell padding scale, and
a group separator (a hairline left border on the first cell of a group, applied via a
`data-group-start` attribute the pages set). Delete the per-page overrides so all four
tables inherit it.
**Acceptance:** WHEN Calls, Results, Bulks and Setup are open at 1440px THEN their tables
SHALL share the same row height and cell padding, and column groups SHALL be visually
separated.
**Verify:** `pnpm run typecheck` and `pnpm run test` in the UI package (the render tests
must still pass — they assert content, not spacing), then a live browser pass on all four
pages at 1440px.
**Must not:** change any column's content, order, or sort behaviour.

---

## Not yet stepped — these need their own grill first

Per the standard, a feature becomes steps only after it has been grilled. These have been
described but not grilled, so they stay here with the questions that block them.

| Part | What it is | Blocking question |
|---|---|---|
| A5 | Move "import calls" out of Setup onto Calls | Changes navigation and two pages. Is the account/key panel staying on Setup, and does the old `/sources` deep link keep working? |
| B | Bulk creation as four steps + Advanced toggle | Which fields does a person actually change more than once a month? That list decides what is in step 2 versus Advanced. |
| D1 | Completion-time estimate | Is a rough estimate ("about 20 minutes") enough, or does it need to be a live countdown on the running card? |
| D2 | Cartesia ingest rate | Costs a handful of real transcription calls to measure. Approve the spend? |
| D3 | Fixed-cause failures stop reading as open | Should the 15 stale cells be retried once to clear them, or just relabelled? Retrying costs provider money. |
| E | Tune mode and the tuning report | The largest item. Needs a full grill: which client first, which provider, and what a person does with the report once they have it. |
| F | Write a transcriber back to Vapi | Dev accounts only, or production too? |
| v6 E4 | Vendor data-handling record in `docs/data-governance.md` §4 (six vendors already sent audio; every checkbox unticked) | Who signs the DPAs — Ellavox as processor for the client's callers? A legal answer the tool can only record. |
| v6 F2 | Deepgram keyterm cap test on the Rush assistant (120 terms sent; Deepgram caps at 100 / 500 tokens) | Three paid Deepgram calls — pre-approved as cents, or a "go spend" each time? |
| v6 E1 | Backup destination | Local folder only, or also a cloud bucket / iCloud Drive? Local-only dies with the laptop. |
| v6 E3 | Customer-word floor | 30 words as the default, or lower for the transfer-heavy Land And Apartment assistants (median 2 customer turns per call)? M-16 ships with 30 and the question stays open. |
