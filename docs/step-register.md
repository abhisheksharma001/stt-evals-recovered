# Step register — one step, one PR, one win

**Standard:** `~/.claude/skills/mystandard/SKILL.md`. Read it before adding a step.

Every step below stands alone. A model with no memory of the conversation that produced
it should be able to open this file, read one step, and do it — without asking what was
meant. If a step needs something only a past session knows, the step is wrong.

**Status legend:** `todo` · `blocked` (waiting on Abhishek, says why) · `done` (says what
was learned, not just a tick) · `split` (the step was wrong or was really several steps;
the header stays so nothing citing its id dangles, and the corrections are written into
it rather than quietly elsewhere).

**Ship a step:** branch → do exactly that step → typecheck + tests → prove by breaking →
self-review → PR → CI → squash-merge → fast-forward → deploy → verify live → mark done.

---

## Where the steps come from

`docs/PRD-v7-decide.md` (one verdict the corpus can carry — the denominator, the org as
the unit of decision, the judge's context, the triage seeds), `docs/PRD-v6-measure.md`
(measurement — the reference, the audio, the product under test) and
`docs/PRD-v5-optimize.md` (Setup polish, Tune mode) hold the reasoning. This
file holds the work. Only the parts that have been **grilled and settled** appear as
steps; the rest are listed at the bottom with the questions that must be answered before
they can be stepped. ~~Order as of 2026-09-04: Part M first (M-1 … M-21), then S-2 … S-7.~~
**Order as of 2026-09-08 (PRD v7): R-1 → R-3 → R-4 → M-11d → M-17 → R-6 → R-7 → M-20 →
M-19a → R-5 → M-12 → R-2 → M-19b / M-21. M-13 and M-14 are parked.**

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

### S-0.2 — The "use pnpm" guard rejects pnpm

**Status:** done 2026-09-06 (PR #95, `df00a56068ae`). Not deployed: the change is
install-time tooling and is not part of the API bundle, so the live build stays
`681483c03902`.
**PR:** one.
**Depends on:** nothing.
**Files:** `package.json` (the root `preinstall` script), plus two docs that told the
reader to work around this bug: `docs/runbooks/working-copy-location.md` and the entry
in `docs/backlog/good-to-have.md`.

**Three things this step said were wrong. Corrected here, where they were written:**

1. **Corepack is not the cause.** The step said pnpm launched through corepack "does not
   set that variable for lifecycle scripts". A plain single-package `pnpm install`
   through the same shim prints
   `UA=[pnpm/11.1.2 npm/? node/v22.22.2 darwin arm64]`. The variable is empty only for a
   **workspace root's** own lifecycle scripts, which pnpm 11 runs in a separate phase.
   Probed inside the real failing worktree: `. preinstall: UA=[]` while
   `. preinstall: EXECPATH=[.../corepack/v1/pnpm/11.1.2/bin/pnpm.mjs]`.
2. **The failed install is not an empty install.** pnpm 11 runs the workspace root's
   lifecycle scripts *after* linking, so the failing install still left all 579 packages
   linked. `node_modules` looked installed while `runDepsStatusCheck` silently re-ran the
   failing install before every `pnpm run` -- which is why the symptom read as "every
   command is broken" rather than "install is broken".
3. **The Verify command does not run.** `git worktree add ../stt-evals-guardcheck main`
   fails with `fatal: 'main' is already used by worktree at ...` -- `main` is checked out
   in the working copy. Use `git worktree add --detach ../stt-evals-guardcheck main`.

**Change (as built):** guard on the basename of `$npm_execpath`, which is set in both
phases. One line:
`case "${npm_execpath##*/}" in pnpm*) ;; *) echo "Use pnpm instead" >&2; exit 1 ;; esac`.
The guard was kept, not deleted, though the step allowed either.
**Acceptance:** WHEN `pnpm install --frozen-lockfile` is run in a freshly created
worktree with no `node_modules` THEN it SHALL complete without `--ignore-scripts`, and
`pnpm run typecheck` SHALL then run to completion in that worktree.
**Acceptance -- Met.** In a worktree created fresh from merged `df00a56068ae` with zero
`node_modules`: install exit 0, `preinstall: Done`, `Done in 5s using pnpm v11.1.2`;
then `pnpm run typecheck` exit 0 with 4 of 4 projects `Done`.
**Verify:** `git worktree add --detach ../stt-evals-guardcheck main`, then in it
`pnpm install --frozen-lockfile` and `pnpm run typecheck`; both finish. Guard truth
table over real execpath values -- allow `pnpm.mjs` (corepack) and `pnpm.cjs`
(`pnpm/action-setup`, proved for real by CI's own install); reject `npm-cli.js`,
`npm-cli.js` under `~/Library/pnpm/...`, `yarn-4.5.0.cjs`, and an unset value.
Proof by breaking, after the commit: old guard restored into the worktree with
`node_modules` wiped -> install fails again with `Use pnpm instead`; fixed guard
restored and wiped again -> install and typecheck both pass.
**Must not:** touch the lockfile; change any dependency version; weaken the guard to
the point that a plain `npm install` succeeds. **Held** -- lockfile and every dependency
version untouched, and the reject arm is tighter than before, not looser.

Learned:

- The guard matches the **basename** of `$npm_execpath`, not `*pnpm*` anywhere in the
  path, because npm installed under pnpm's own global directory
  (`~/Library/pnpm/global/5/node_modules/npm/bin/npm-cli.js`) carries "pnpm" in its
  execpath and would have been allowed. An unset value fails closed.
- `npm install` never reaches the guard in this repo anyway: npm dies first on the pnpm
  workspace with `Cannot read properties of null (reading 'isDescendantOf')`. The reject
  arm is therefore proved by the truth table, not by an npm run -- worth saying, because
  "npm install still fails" was true for a reason the step did not name.
- A step's own reason can be wrong while its symptom and its proposed fix are both
  right. The symptom here reproduced exactly as written; only the cause was mis-assigned.
  Reproducing before believing cost one probe and changed three sentences of docs.
- The first acceptance run was dishonest and had to be redone: the *failed* install had
  already populated `node_modules`, so "fresh worktree with no `node_modules`" was not
  the state being tested. Deleting them and re-running is the only version of that
  sentence worth reporting.

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

**Status:** `done` 2026-09-05 (PR #84, `b3aa91f`, deployed `b3aa91fbd994`).
Learned: **this row's `Files` list was wrong and the step could not have
worked as written.** `artifacts/stt-benchmark/package.json` passed
`--host 0.0.0.0` on the command line in both the `dev` and `serve` scripts,
and a Vite CLI flag beats `server.host` in the config — so editing
`vite.config.ts` alone would have shipped a change that read as a fix and
moved nothing. Proved it on purpose: with the config fixed and the flag put
back, the bind was still `*:5173` and the LAN still got 200 from
`/api/healthz`. The flag is gone from both scripts and the value now comes
from one place. The `Files` line below is corrected to match.
**Rule this leaves: a config value is not the setting until nothing on the
command line overrides it — read the script that starts the process, not just
the file it loads.**
**PR:** one.
**Depends on:** M-3 (done).
**Files:** `artifacts/stt-benchmark/vite.config.ts` (`server.host`,
`preview.host`), `artifacts/stt-benchmark/package.json` (the `--host 0.0.0.0`
flag on the `dev` and `serve` scripts — corrected 2026-09-05, see Status),
`docs/runbooks/deploy-and-rollback.md` ("Where it listens").
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

**Status:** `done` 2026-09-05 (PR #85, `36cd28a`, deployed `36cd28a861ba`).
Learned: **the guard is the whole step, and only breaking it showed that.**
`pg_dump` writing straight to the day's filename means one failed night
silently replaces a good 3.9 MB backup with a 0-byte file that still looks
like one — measured, not reasoned about. Dumping to `<name>.partial` and
renaming only on exit 0 is what holds; a `trap` clears the partial so a
failure leaves nothing at all. Two other things only a live run could say:
a launchd agent starts without `/usr/local/bin` and would never have found
`docker`, so the plist sets `PATH` explicitly; and macOS ships bash 3.2 at
`/bin/bash`, which is what launchd runs, so no `mapfile`. The restore was
exercised, not described — all 11 tables matched live.
**Rule this leaves: a backup nobody has restored is a guess, and a backup
script that has never been made to fail is an unproven one.**
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
docker exec stt-evals-pg psql -U postgres -d stt_evals_restore -c 'select count(*) from benchmark_calls'   # must equal the live count
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

**Status:** `done` 2026-09-05 (PR #86, `ee125e1`, deployed `ee125e1951c6`).
Learned: **the step's own spec contained a bug that only writing it out
revealed** -- "cells whose `audioSource` equals the bulk's (otherwise
`mono`)" cannot be right while the executor always prefers customer, because
a `requireCustomerAudio: false` bulk would then produce customer cells that
its own ranking filter throws away. Resolved by letting the bulk's frozen
flag drive the executor as well as the filter, which is also what makes
"a pre-M-5 template keeps producing its own numbers" true rather than
merely intended. The second thing only self-review caught: **wanting the
customer channel and refusing to run without it are two different flags.**
One flag would have failed every ad-hoc run over the 56 calls whose caller
track was never rescued -- typechecked fine, tests green, still wrong.
Third: the default had to be resolved *before* selection, not frozen after
it, or a bulk claims the caller-only track while holding calls that have
none. Live after deploy: the same corpus goes 106 -> 52 matched, and the 54
dropped calls are named on screen (`no customer-channel audio on file`), not
silently absent.
**Rule this leaves: a filter and the thing it filters must be driven by one
stored decision, or they will disagree the first time someone re-runs
something.**

---

### M-5a — The screen says which channel a number was measured on

**PR:** one.
**Depends on:** M-5 (`audio_source` is already on every new result row and
already on the API's run-results response).
**Files:** `artifacts/stt-benchmark/src/pages/Rankings.tsx`,
`artifacts/stt-benchmark/src/pages/Bulks.tsx`,
`artifacts/stt-benchmark/src/pages/Corpus.tsx`.
**Today:** M-5 records the channel and the API returns it, but no screen
renders it. A person reading a ranking cannot tell a caller-only measurement
from a mono one, which is exactly the confusion M-5 exists to remove -- so
"and say so" is currently only true of the API, not of the product.
**Change:** a bulk's card states its channel in words ("measured on the
caller-only channel" / "measured on the mono mix, which includes the
assistant's voice"), read from the bulk's frozen
`selectionCriteria.requireCustomerAudio`, never re-derived from the cells.
A result row shows its own `audioSource` where the cell's other provenance
already shows. A null `audioSource` on a cell that transcribed something
renders as "mono (recorded before this was tracked)", never as blank and
never as a confident "mono".
**Acceptance:** WHEN a bulk created after M-5 is opened THEN the page SHALL
name the audio channel it was measured on, and WHEN a result row written
before M-5 is shown THEN it SHALL say the channel was not recorded rather
than assert one.
**Verify:** `pnpm run typecheck`; open a bulk in the UI and read the line.
Prove by breaking: force `requireCustomerAudio` to undefined on the fixture
bulk, the "not recorded" wording appears instead of a channel name.
**Must not:** launch or execute a run; change any stored value; infer a
bulk's channel from its cells instead of from its frozen criteria.
**Status:** done 2026-09-05 (PR #87, cd47083, deployed cd47083ce7e4).
Three surfaces, two sources, no derivations: a bulk's line comes from its
own frozen `selectionCriteria.requireCustomerAudio`, a cell's chip from
its own `audio_source`, and the all-time Results view shows no line at
all -- it pools bulks measured on different channels, and one label over
a mixture is a claim about audio that was never all the same audio.

Three things learned.

(1) The step said `audio_source` was "already on the API's run-results
response", and it was -- but the surface the UI actually renders per row
is `GET /benchmark/calls/:id/comparison`, whose `ComparisonRow` did not
carry it. A field being on *an* endpoint is not the same as being on the
endpoint the screen reads. Check which response the component consumes
before assuming the data is reachable.

(2) A duplicate `<ChannelLine>` got pasted into the bulk detail dialog by
a half-applied edit. Typecheck was clean, 97 tests passed, and nothing
caught it, because no test ever opened that dialog. Self-review of the
diff caught it. **A surface with no test is a surface where "it compiles
and the suite is green" means nothing at all** -- the fix commit adds a
test that opens the dialog and counts, so the duplicate now fails loudly.

(3) Every bulk on the live system predates M-5, so every one of them now
renders "channel not recorded" rather than a channel name, and every
existing result cell renders "mono (recorded before this was tracked)".
That is the correct output, not a gap: those rows really were mono
because no other code path existed, but the row does not record it, and
the distinction between "it says so" and "we know it must be" is the
whole product. **Resisting a true-but-underived default is what makes the
recorded ones worth believing.**

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
**Status:** done 2026-09-05 (PR #88, 673908e, deployed 673908ee7de1).
Proved live, not only by test: one Leasing Dev call imported free (a Vapi
download, no provider) landed four files -- `.audio`, `.customer.audio`,
`.assistant.audio` and a 59.5K `.artifact.json` with 22 messages and a
`transcriberLatencyAverage` of 733.7 ms -- and `GET /benchmark/calls` reports
`customerAudioCached: true` for it. The corpus is 176 calls, 100 of which now
have a caller channel: the 99 rescued by hand plus the first one that got it
without anybody asking.

Four things learned.

(1) The step's own acceptance had no automated proof and never could have
had one cheaply: the import handler talks to Vapi, and nothing in the test
suite can reach it. So the guard set covers what is testable --
`cacheCallSidecars` itself, and the flag the UI reads -- and the wiring
between them was proved live. Naming that split up front is better than
letting a green suite imply the route was covered.

(2) **A test that cannot fail is worse than no test**, because it looks like
one. The first version of the `customerAudioCached` integration case seeded a
call with both files and a call with neither, so reading the flag off the
mono-file set -- the exact mistake it existed to catch -- would have passed
it. It needed a third call with the mono mix and no caller channel, which is
also the state 76 of the corpus's cached calls are actually in. Two files
without a third told me nothing.

(3) The suite failed twice on this branch, and the tempting move was to re-run
until green and ship. Measuring instead took forty runs and found three
failures in three different files, one of them on an untouched `main` -- which
is what made it honest to call this branch green, and what turned "flaky
tests" into M-6a with evidence attached. **"It passed the second time" is how
a real bug ships.**

(4) Looking at the bytes on disk, rather than at the test output, is what
found the fourth file's mode. Three files at 0600 and the mono mix beside
them at 0644, holding the same caller's voice. It is one argument to fix and
it was tempting, but the step forbade touching the mono path, so it is M-6b
instead. **The find came from `ls -l`, not from any assertion I would have
thought to write.**

---

### M-6a — When the integration suite fails, it must say what it actually got

**Status:** done 2026-09-05 (PR #89, `a191d26`, deployed `a191d2698c17`).

**PR:** one.
**Depends on:** nothing.
**Files:** `artifacts/api-server/src/routes/__integration__/small-reads.int.test.ts`,
`artifacts/api-server/src/routes/__integration__/riskiest-endpoints.int.test.ts`,
`artifacts/api-server/src/routes/__integration__/rankings.int.test.ts`.
**Today:** the suite fails roughly once in ten runs, in a different file each time, on
`main` as much as on a feature branch -- three failures in about forty runs, measured
2026-09-05 and written up in `docs/backlog/good-to-have.md`. Two of the three assert an
HTTP status (`expect(res.status).toBe(404)`, `toBe(400)`) and got something else, and the
assertion prints only the two numbers. Nobody knows what the server said, so every
occurrence costs a re-run and teaches nothing.
**Change:** in those three files, replace the bare status assertions with one that carries
the response: `expect({ status: res.status, body: res.body }).toMatchObject({ status: 404 })`
(or an equivalent that prints the body on failure). No behaviour, no fixture, no
production code changes -- this step exists only so the NEXT failure arrives with
evidence attached.
**Acceptance:** WHEN one of those assertions fails THEN the failure message SHALL include
the response body the server returned, not only the status number.
**Verify:** `cd artifacts/api-server && TEST_DATABASE_URL=... pnpm run test:integration`
passes. Prove by breaking: change one expected status to a wrong value and confirm the
failure output now contains the body.
**Must not:** loosen an assertion (a 500 must still fail the test that expected a 404);
retry, sleep, or otherwise paper over the intermittency -- the cause is still unknown and
hiding it is worse than the flake.

**Learned:**

(1) The form this step prescribed does not work. `expect({ status, body })
.toMatchObject({ status: 404 })` prints `(3 matching properties omitted from
actual)` and shows only the status -- exactly what it does today. It was written
into the step because it looked right, and it was never run. Vitest's second
argument to `expect()` does carry the message, so that is what shipped, and the
dead end is recorded in the helper's own header comment. **A step written by the
same person who will execute it can still specify something that has never been
executed.**

(2) The evidence lands in the one-line summary, which is the part CI keeps when
it truncates the rest, and CI does run this suite (`.github/workflows/ci.yml`,
against a postgres service) -- so the payoff is not only local.

(3) The suite failed twice more while this was being shipped, and both taught
something. The fourth occurrence was in a fourth file, `bulk-preview-cancel`,
with `Error: socket hang up` -- no answer to print at all, which disproves the
inference the backlog carried ("points at the response rather than at leftover
rows"). It is a different class, stepped as M-6c rather than folded in here.

(4) The fifth fired minutes later and I lost it, by piping the run through
`tail -4`: the exit code was seen and the failing test was not. **Making the
assertion talk is half the job; keeping the output is the other half**, and I
had just spent an hour on the first half. The backlog now says to `tee` the run.

(5) Applied to every status assertion in the three files, not only the bare
ones. Three of them already carried the path by comparing `` `${path} ->
${status}` `` strings -- which names the request and still never the answer, and
one of those loops is the case that failed on `main`.

---

### M-6c — A request that gets no answer at all must say why

**Status:** done 2026-09-05 (PR #90, `8bcd047`, deployed `8bcd047e77d7`).

**PR:** one.
**Depends on:** nothing (M-6a covered the half of the flake that has a response).
**Files:** `artifacts/api-server/vitest.integration.config.ts`,
`artifacts/api-server/src/routes/__integration__/setup.ts`.
**Today:** the fourth measured occurrence of the flake was
`bulk-preview-cancel.int.test.ts`'s "answers 404 for an unknown bulk and a sentence for
a malformed id" failing with `Error: socket hang up`, on a branch that had touched none
of the files involved. The request never got an answer, so M-6a's message argument has
nothing to print. A socket hang up from supertest means the server closed the connection
before responding -- an unhandled rejection, an error thrown out of the error handler, or
a process being torn down while a request is open -- and none of that reaches the test
output today.
**Change:** ~~add a `setupFiles` entry to `vitest.integration.config.ts` pointing at a new
setup file that registers `process.on("unhandledRejection")` and
`process.on("uncaughtException")` handlers which print the error with its stack, and an
`app`-level check that the express error handler is not itself throwing.~~ **Corrected
2026-09-05 before building, by measuring what vitest already does.** Both handlers are
redundant: vitest 3.2.7 prints an unhandled rejection and an uncaught exception with a
full stack, the source frame and the name of the running test, and adding a listener for
either would print a second copy of what is already there. Neither fires for a hang up
anyway -- a destroyed socket raises no error in this process at all.

What is actually missing is the other end of the socket. Add a `setupFiles` entry to
`vitest.integration.config.ts` pointing at a new setup file that wraps
`http.createServer` -- the one function supertest goes through to start a server for an
express app -- and, for every response whose socket closes before the response finished,
prints the method, the URL, whether headers had already gone out and with which status,
and how long the request had been open. The goal is one printed cause, not a fix: the
next hang up must name what closed the socket.
**Acceptance:** ~~WHEN a request in the integration suite fails with `socket hang up` THEN
the run output SHALL also contain the underlying error and its stack, rather than the
hang up alone.~~ **Corrected 2026-09-05: there is no underlying error to contain.** A
socket destroyed by the server produces an error object only in node's http *client*,
built after the fact and carrying no frame from the test; the server side raises nothing.
WHEN a request in the integration suite fails with `socket hang up` THEN the run output
SHALL also name that request's method and URL and say how far the server had got with it,
rather than the hang up alone.
**Verify:** `cd artifacts/api-server && TEST_DATABASE_URL=... pnpm run test:integration
2>&1 | tee /tmp/int.log` passes **and the log contains no `[integration]` line** -- a
healthy run has to stay quiet, or the check becomes noise nobody reads. Prove by
breaking, in two guards: (1) add `res.socket?.destroy(); return;` as the first two lines
of the cancel handler in `artifacts/api-server/src/routes/bulks.ts` and run
`bulk-preview-cancel.int.test.ts` -- both failures must each be accompanied by a line
naming their own request, including the `/api` prefix; (2) with that still armed, delete
the `setupFiles` entry from the config and confirm both failures fall back to a bare
`socket hang up` with no line at all. Restore each with `git restore --source=HEAD
--staged --worktree <file>`. ~~Prove by breaking: add a route (or a test-only handler)
that rejects asynchronously without awaiting, confirm the run prints the rejection, then
remove it.~~ **Corrected 2026-09-05: that proves vitest works, not this file** -- an
unhandled rejection is printed with or without the setup file.
**Must not:** retry a request, add a sleep, raise a timeout, or mark the test as flaky --
the cause is still unknown and every one of those hides it. Do not change any route's
behaviour; this step only makes the process talk.

**Learned:**

(1) **The second step in a row whose prescribed change did not survive being run.** M-6a
prescribed an assertion form that hides the body; M-6c prescribed two `process.on`
handlers that vitest 3.2.7 already installs, printing an unhandled rejection and an
uncaught exception with a full stack, the source frame and the name of the running test.
Both were caught the same way -- by running the prescribed thing before building on it.
The habit is now the rule: **measure what the tool already does before writing the file
that does it.**

(2) **The acceptance sentence was unachievable and had to be corrected, not met.** It
asked for "the underlying error and its stack". A socket destroyed by the server raises
nothing on the server side; the error object exists only in node's http *client*, built
after the fact, with no frame from the test in its stack. What vitest prints for a hang
up is one line -- `→ socket hang up` -- with no method, no URL and no stack, and it
prints the same line for two different failures. **An acceptance sentence can be wrong;
correct it in place rather than reaching for it.**

(3) **A `clientError` listener would have manufactured the failure it was meant to
explain.** It was written, then measured against a raw socket rather than against the
documentation: a malformed request line gets `HTTP/1.1 400 Bad Request` with no listener
and an **empty response** with one, because node disables its own default handling as
soon as a listener is registered. It is not in the file, and the measurement is in the
comment so nobody adds it back.

(4) **`http.createServer(app)` registers express as the first `request` listener, and
express rewrites `req.url` synchronously.** The first draft printed `/benchmark/...`
without the `/api` prefix for exactly that reason. Fixed with `prependListener` and by
capturing the method and URL when the request arrives rather than when the socket closes.

(5) **A diagnostic that also fires on a healthy run is noise nobody reads**, so the
check prints only when `res.writableFinished` is false -- verified as zero lines across
27 files and 119 passing tests, twice.

(6) CI runs `pnpm --filter @workspace/api-server run test:integration` against a
`postgres:16` service container in the same job as the typecheck (`.github/workflows/ci.yml`),
so the setup file is loaded there too and a hang up in CI will name its request as well.

(7) **What this did not do:** the flake is still undiagnosed. Five failures in roughly
fifty runs, in two shapes, and neither shape has a cause yet. M-6a and M-6c together buy
one thing -- the next occurrence of either shape is identifiable from the log instead of
costing a re-run.

---

### M-6b — The mono file gets the same file mode as the three beside it

**Status:** done 2026-09-06 (PR #91, `5561668`, deployed `556166893bf2`).

**PR:** one.
**Depends on:** M-6 (which established 0600 as the mode for cached call audio).
**Files:** `artifacts/api-server/src/lib/audio-cache.ts` (`getOrCacheAudioBytes`),
`artifacts/api-server/src/lib/audio-cache.test.ts`.
**Today:** the first M-6 import wrote four files for one call:
`<id>.customer.audio`, `<id>.assistant.audio` and `<id>.artifact.json` at 0600, and
`<id>.audio` at 0644. The mono mix carries the caller's voice exactly as the customer
channel does, so three locked files beside one open one protect nothing. The 0644 is not
a decision: `fs.writeFile` with no mode is 0666 minus the umask.
**Change:** pass `{ mode: 0o600 }` on the mono write in `getOrCacheAudioBytes`, and add a
case asserting the mode, next to the M-6 one that already asserts it for the other three.
Existing files keep whatever mode they have -- this step does not chmod the ~~176~~ already
on disk, because a sweep over a directory of caller audio is its own decision.
**Corrected 2026-09-06 while shipping this step: 156, not 176.** Counted on disk the day
the step ran: 156 mono `.audio` files at 0644, and 300 sidecars (100 each of
`.customer.audio`, `.assistant.audio`, `.artifact.json`) at 0600, 456 files in all. 156
is also what the numbers already written down predict -- `audio-cache.ts` records 155
cached calls at M-5 time and M-6's first import added one. 176 matches nothing on disk and was
never counted. **Where it came from, found while shipping M-7a:** the corpus holds
exactly **176 calls**. The number was true and attached to the wrong noun -- a call
count written down as a file count.
**Acceptance:** WHEN a call's mono audio is cached THEN the file SHALL be 0600, and every
file in the cache directory written from that point SHALL have the same mode.
**Verify:** `cd artifacts/api-server && pnpm test`. Prove by breaking: drop the mode
argument and watch the new case fail with `expected 420 to be 384`.
**Must not:** chmod files already on disk; change where the mono file is written, what it
contains, or when it is fetched.

**Learned:**
1. The step was right about the code, and wrong about one number. Every claim it made
   about the source held up when checked (`getOrCacheAudioBytes` is the only writer of
   the mono path, repo-wide), and the one claim about the world -- 176 files on disk --
   was wrong. A count is a fact about a machine at a moment; it goes stale in a way a
   code claim does not, and it has to be re-counted rather than quoted.
2. The acceptance sentence claims more than the one-line change does: "every file in the
   cache directory written from that point SHALL have the same mode" is about the whole
   directory, not this function. Checked all three production writers before marking it
   met -- `getOrCacheAudioBytes` (mono), `cacheCallSidecars` (the three sidecars) and
   `scripts/rescue-customer-audio.mjs` (artifact + two channels). All 0600. Met. The
   rescue script's artifact write briefly looked like a gap because a truncated grep line
   hid its `{ mode: 0o600 }`; reading the line in full is what settled it, not the grep.
3. `mode` on `fs.writeFile` applies at file creation only -- it never chmods a file that
   already exists. It does not matter here, because `getOrCacheAudioBytes` returns cached
   bytes without reaching the write when the file exists, but it means this step could
   not have fixed the 156 old files even if it had wanted to. A chmod sweep would be a
   different step doing a different thing.
4. The test had to stub `resolveFreshRecordingUrl`, because the only writer asks Vapi for
   a fresh URL before it writes. That is the single network reach in the file; the rest of
   `./vapi` stays real via `importOriginal`. Nothing was spent.
5. A cache test can pass on a file it did not write. The case `rm`s its target first and
   asserts the returned bytes as well as the mode, so a file left behind by a crashed
   earlier run cannot be the thing measured.
6. Self-review caught placement, not correctness: `vi.mock` is hoisted wherever it sits,
   so it worked at the bottom of the file, but nobody reading the imports would have
   known `./vapi` was stubbed. Moved under the imports.
7. **What this did not do:** the 156 files already on disk are still 0644. The directory
   is only as protected as its weakest file until a separate step sweeps them, and that
   step does not exist yet.
8. **The flake fired during this step and its evidence was thrown away** -- by me, piping
   the run through `tail -8`. M-6a and M-6c exist to make exactly that occurrence
   readable, and the very next one was discarded by the person who built them. See
   `docs/backlog/good-to-have.md`; the rule is now written down there rather than
   remembered.

---

### M-6d — The 156 mono files written before M-6b are still 0644

**PR:** one.
**Depends on:** M-6b (done -- new files are 0600; these are the old ones).
**Files:** new file scripts/chmod-audio-cache.sh (plain: not written yet).
**Today:** every file the server writes into `artifacts/api-server/audio-cache/` is
0600 since M-6b, but `mode` applies at creation only, so the 156 mono `<id>.audio`
files written before it are still 0644 -- world-readable caller audio beside 300
sidecars that are not. The directory is only as protected as its weakest file.
**Change:** a script that chmods `0600` every file under that directory, prints the
count it changed and the count already correct, and is a dry run unless given
`--apply`. It touches file modes only -- never contents, never names, never the
database.
**Acceptance:** WHEN the script has been run with `--apply` THEN
`find artifacts/api-server/audio-cache -type f ! -perm 600 | wc -l` SHALL be 0.
**Verify:** `find artifacts/api-server/audio-cache -type f ! -perm 600 | wc -l` before
(156) and after (0); `ls -l` on one known mono file shows `-rw-------`; the API still
serves that call's audio afterwards (`curl -s -o /dev/null -w '%{http_code}'` on the
audio route → 200).
**Must not:** delete or move a file; change any file's contents; chmod anything outside
that one directory; run without a dry run first.

**Status:** done 2026-09-06 (PR #96, `7907cdf`). Not deployed: the change is a shell
script, not part of the API bundle, so the live build stays `681483c03902`. The sweep
itself has already been run against the running server's own cache directory, and the
audio route was re-checked afterwards.

**Nothing this step claimed turned out to be wrong.** Counted on disk before touching
anything, 2026-09-06: 456 files -- 100 `<id>.artifact.json`, 100 `<id>.customer.audio`
and 100 `<id>.assistant.audio` at 0600, and exactly 156 mono `<id>.audio` at 0644. The
premise held too: the newest of the 156 is `2026-09-05 04:24:01` and M-6b merged
`2026-09-06 02:55:11`, so every one of them predates M-6b and no write path is still
producing 0644.

**Change (as built):** one new file, `scripts/chmod-audio-cache.sh`. Nothing else -- no
TypeScript, no route, no schema, no database read or write. It counts, it is a dry run
unless given `--apply`, it rejects any other argument, and it recounts afterwards and
exits non-zero if a single file is still not 0600. `-type f` so a symlink is skipped
rather than followed out of the directory; `-print0 | xargs -0` so an odd filename is
not mangled.

**Acceptance -- Met.** `find artifacts/api-server/audio-cache -type f ! -perm 600 | wc -l`
read **156** before `--apply` and **0** after. `ls -l` on a known mono file shows
`-rw-------`.

**Verify -- what was actually checked**

| check | result |
| --- | --- |
| not-0600 count, before → after | 156 → **0** |
| mode histogram after | 456 files, all `-rw-------` |
| sha256 of all 456 files, before vs after | identical |
| inode + size of all 456, before vs after | identical -- nothing recreated, moved or renamed |
| three of the 156 through the audio route | `200 300204` / `200 1516204` / `200 2509484`, byte-identical before and after |
| `Range: bytes=0-1023` | `206`, 1024 bytes -- the `<audio>` scrubber still works |
| second `--apply` | `456 already 0600 / 0 to change` |

**Proof by breaking, after the commit, three ways.** (1) In a throwaway sandbox of dummy
files -- never real caller audio -- the sweep line was changed to `chmod 644`: the script
ran, exited **1** with `!! 3 file(s) are still not 0600 after the sweep`, and never
printed its `done:` line, so the final recount is a real assertion. (2) With the
`--apply` early exit deleted from that sandbox copy, a plain no-argument run silently
changed 3 files -- against the real directory, with the guard in place, the same plain
run left 156 at 156. (3) One real mono file was put back to 0644: the committed script's
dry run said `1 would change`, `--apply` fixed it, the count returned to 0, and that
file's sha256 was unchanged.

**Must not -- Held.** No file deleted, moved or renamed (inode + size list identical);
no file's contents changed (sha256 list identical); nothing chmod'd outside that one
directory; the dry run ran first and was verified to be dry before `--apply`; the
database was not touched, no provider was called, nothing was spent.

**What was learned**

1. `writeFile(..., { mode })` sets the mode **at creation only**. M-6b's test proves a
   newly written file is 0600 and always will -- it can never catch a file that already
   existed, so a write-path fix and a sweep of what is already on disk are two different
   jobs, and M-6b only ever did the first.
2. Once every file is 0600 the sweep never needs to run again: an overwrite keeps the
   existing mode, and a fresh file is born 0600. That is why this is a one-shot script
   and not a scheduled job.
3. The break proof was done on dummy files in a sandbox, not on the cache. A destructive
   break test against 456 files of real caller audio is not a proof, it is a gamble --
   and the sandbox reproduces the layout exactly because the script derives its target
   from its own location (`$(dirname "$0")/..`), so a copy in a mirrored tree needs no
   override to point somewhere safe.
4. The one thing the step did not think about is the container: every file inside is now
   0600, but the directory is still `drwxr-xr-x`. See M-6e.

---

### M-6e — The audio cache directory itself is still world-listable

**Status:** done 2026-09-06 (PR #97, `4c729a4`). Not deployed: a `mkdir`
mode only matters on a machine where the directory does not exist yet, and the
sweep is a shell script outside the API bundle, so the live build stays
`681483c03902`. The sweep has been run against the running server's own cache
directory and the audio route was re-checked afterwards.

**Nothing this step claimed turned out to be wrong.** Measured before touching
anything: 456 files all `-rw-------`, directory `drwxr-xr-x`, both exactly as
the step said. The probe that mattered was the one about `mkdir`: a fresh
`mkdir(dir, { recursive: true, mode: 0o700 })` produces `drwx------` under this
machine's umask 022, and the same call against a directory that already exists
leaves it `drwxr-xr-x` — mode at creation only, the same rule M-6d learned about
`writeFile`. That is what makes the script's half of this step necessary rather
than tidy.

**Change (as built):** two things, one rule.
`ensureAudioCacheDir(dir = CACHE_DIR)` in
`artifacts/api-server/src/lib/audio-cache.ts` is now the only place the
directory comes into being, and it creates it 0700. There were FIVE copies of
`fs.mkdir(CACHE_DIR, { recursive: true })` — two in the app
(`getOrCacheAudioBytes`, `cacheCallSidecars`) and three in tests
(`audio-cache.test.ts`, `calls-list.int.test.ts`, `customer-channel.int.test.ts`)
— and on a fresh machine a test run creates that directory before the app ever
does. Fixing only the app's two would have left the mode decided by whoever ran
first. `scripts/chmod-audio-cache.sh` now reports and fixes the directory as
well as the files, counted separately, under the same `--apply` it already had.

**Acceptance — Met.** `stat -f '%Sp' artifacts/api-server/audio-cache`:
`drwxr-xr-x` → `drwx------`, and the API still answers 200.

**Verify — as run:**

| check | before | after |
| --- | --- | --- |
| directory mode | `drwxr-xr-x` | `drwx------` |
| files under it | 456, all `-rw-------` | 456, all `-rw-------` |
| `GET .../e2553079-…/audio` | `200` 300,204 bytes | `200` 300,204 bytes |
| `GET .../ca350e3f-…/audio` | `200` 1,516,204 bytes | `200` 1,516,204 bytes |
| `GET .../f443c8e0-…/audio` | `200` 2,509,484 bytes | `200` 2,509,484 bytes |
| `Range: bytes=0-1023` | `206`, 1024 bytes | `206`, 1024 bytes |
| `GET /benchmark/calls?limit=5` | `200` | `200` |
| server can write into it | yes | yes (probed with a real file, then removed) |
| second `--apply` | — | `0 to change -- nothing to do` |

**Proof by breaking — three ways, all after the commit:**

1. `mode: 0o700` removed from the helper → EXACTLY one test failed,
   `expected 493 to be 448` (0755 against 0700); the other 14 passed. The
   assertion is specific, not a smoke test.
2. The helper made to self-heal with a `chmod` → the OTHER new test failed, the
   one asserting an existing directory is left as found. That test is what says
   out loud why the script has to exist; without it, someone would "simplify"
   the script away.
3. Sandbox of DUMMY files, never real caller audio: `chmod 700 "$DIR"` deleted
   but the assertion kept → the run printed its optimistic
   `the directory changed to 0700` line and then exited **1** with
   `!! the directory is still drwxr-xr-x after the sweep`, never reaching
   `done:`. The dry-run default was re-checked in the same sandbox: a plain
   no-argument run left a 0755 directory and a 0644 file exactly as found.

**Must not — held.** No file's mode, name or contents changed (456 files,
`-rw-------`, before and after). No directory but that one was chmod'd. The
server still writes into its own cache.

**Learned:**

1. **A permission fix that only names files leaves the container at the
   process's umask.** M-6b and M-6d were both correct and both incomplete for
   the same reason: `-perm`, `chmod`, `writeFile mode` all take file paths, and
   nothing in that vocabulary makes you look one level up. The audio was
   unreadable and the index of 456 call ids was not.
2. **`mkdir`'s `mode` behaves exactly like `writeFile`'s: creation only.** Which
   means the same two-jobs split M-6d learned applies again — the write path and
   what is already on disk are separate fixes, and neither implies the other.
3. **Five copies of one `mkdir` meant the app did not actually own the
   directory's mode.** The three copies in tests are not incidental: on a fresh
   checkout the test suite runs long before the server writes its first cache
   file, so the test's `mkdir` is the one that decides. Deduplicating them was
   not tidiness, it was the difference between the fix working and the fix
   being true only on this laptop.
4. **A break test that touches a default argument pointing at live data is
   aimed at the wrong thing.** Break #2 added a `chmod` inside
   `ensureAudioCacheDir()`, whose default is the real `CACHE_DIR`, and the test
   file's own `write()` helper calls it with no argument — so the break ran
   against the live cache directory and set it to 0700 early. Nothing was lost
   and the end state was the intended one, but the script had not done it. The
   directory was put back to 0755 and the acceptance was re-run properly
   through the committed script. M-6d's lesson was "break in a sandbox"; the
   sharper version is "a sandbox is not a directory, it is every path the code
   under test can reach, including its defaults."

**PR:** one.
**Depends on:** M-6d (done -- every file inside is 0600 now; this is the container).
**Files:** `artifacts/api-server/src/lib/audio-cache.ts` (the `mkdir` that creates it),
`scripts/chmod-audio-cache.sh` (the sweep, so a re-run also fixes the directory).
**Today:** measured 2026-09-06, after M-6d: all 456 files under
`artifacts/api-server/audio-cache/` are `-rw-------`, and the directory holding them is
`drwxr-xr-x`. Nobody but this server's user can read a byte of caller audio, but any
local user can still `ls` the directory and walk away with 456 call ids and their file
sizes. A call id is the join key to a real caller's record, so the listing is not
nothing. M-6b and M-6d both reasoned about files and neither looked at the container.
**Change:** create the directory `0700` instead of letting it default to 0755, and have
the sweep script bring an existing directory down to 0700 as well -- reported and dry-run
under the same `--apply` flag it already has, and counted separately from the files so
the output still says plainly what it is about to do.
**Acceptance:** WHEN the sweep has been run with `--apply` THEN
`stat -f '%Sp' artifacts/api-server/audio-cache` SHALL read `drwx------`, and the API
SHALL still answer `200` on `GET /benchmark/calls/<a cached id>/audio`.
**Verify:** `stat -f '%Sp' artifacts/api-server/audio-cache` before (`drwxr-xr-x`) and
after (`drwx------`); `curl -s -o /dev/null -w '%{http_code}' localhost:8177/api/benchmark/calls/e2553079-0fd5-4abc-a205-2e14ff15ccaa/audio`
→ 200; the api-server unit tests still pass, including
`artifacts/api-server/src/lib/audio-cache.test.ts`.
**Must not:** change any file's mode, name or contents (M-6d already settled the files);
chmod any directory other than that one -- in particular not its parents; leave the
server unable to write into its own cache.

---

### M-7a — Production signals stored per call

**Status:** done 2026-09-06 (PR #92, `fce59ac`, deployed `fce59ac67359`).

**PR:** one.
**Depends on:** M-6 (the artifact file; the backfill reads the saved ones off disk).
**Files:** `lib/db/src/schema/benchmark-calls.ts`,
`artifacts/api-server/src/lib/production-signals.ts` (new -- the one reader),
`artifacts/api-server/src/lib/production-signals.test.ts` (new),
`artifacts/api-server/src/routes/benchmark.ts` (import handler + `serializeCall`),
`artifacts/api-server/src/backfill-m7a-production-signals.ts` (new) + its entry in
`scripts/apply-backfills.sh`, `lib/api-spec/openapi.yaml`.
**Today:** the tool knows which model production ran and nothing about how it did.
Every one of the 100 saved artifacts carries `performanceMetrics`, and what is in there
is thinner than M-7 assumed -- counted on disk 2026-09-06, not remembered:

| field | present | measured | median (measured) | max |
| --- | --- | --- | --- | --- |
| `transcriberLatencyAverage` | 100 of 100 | 77 (23 report `0`) | 378.3 ms | 6,651 ms |
| `endpointingLatencyAverage` | 100 of 100 | 72 (28 report `0`) | 120.3 ms | 1,577 ms |
| `numAssistantInterrupted` | 47 of 100 | 47 | 26 of the 47 are >= 1 | 9 |
| tool calls (`toolCalls` entries in `messages`) | 100 of 100 | 100 | 75 of 100 have >= 1 | 10 |

A `0` there is not a measurement. 21 of the 23 zero-latency calls carry an EMPTY
`turnLatencies` array -- no turn was timed at all -- and a transcriber that answers in
0 ms does not exist. `numAssistantInterrupted` is simply absent on 53 calls; absent is
not zero (docs/step-register.md's own standing rule). Tool calls are different: the
`messages` array is present on all 100, so "none" there IS a measurement, and 0 is the
honest value.
**Change:** four nullable columns on `benchmark_calls` --
`prodTranscriberLatencyMs` (real), `prodEndpointingLatencyMs` (real),
`prodAssistantInterruptions` (integer), `prodToolCalls` (integer) -- written by ONE
reader (`readProductionSignals` in `artifacts/api-server/src/lib/production-signals.ts`)
that takes the artifact object and returns those four values or nulls. The import
handler calls it with `call.artifact`; the backfill calls it with the parsed
`<callId>.artifact.json`, whose shape `cacheCallSidecars` and
`scripts/rescue-customer-audio.mjs` write field for field. Rules, in the reader and in
its tests: a latency of `0` or a missing/non-finite number becomes null; a missing
`numAssistantInterrupted` becomes null and a present `0` stays `0`; tool calls count
`toolCalls` ENTRIES (119 across the corpus), not `tool_calls` messages (116) -- the
count of `tool_call_result` messages is also 119, which is the cross-check -- and a
missing `messages` array becomes null while an empty one becomes `0`.
Exposed on `BenchmarkCall`. No UI in this step (that is M-7b).
**Acceptance:** WHEN the backfill has run THEN `GET /benchmark/calls` SHALL carry a
non-null `prodTranscriberLatencyMs` on exactly the calls whose saved artifact reports a
non-zero transcriber latency, and null on every other call -- including calls whose
artifact reports `0`.
**Verify:** `pnpm run typecheck`; `pnpm --filter @workspace/api-server test` (the reader's
unit tests cover each rule above, one case per rule);
`pnpm --filter @workspace/db run push`; `bash scripts/apply-backfills.sh` (dry run prints
counts and writes nothing), then `--apply`; then
`curl -s localhost:8177/api/benchmark/calls | jq '[.[]|select(.prodTranscriberLatencyMs!=null)]|length'`
equals the dry run's own measured-latency count, and
`jq '[.[]|select(.prodTranscriberLatencyMs==0)]|length'` is 0.
**Must not:** store a `0` as if it were a measurement; write `0` where Vapi sent no
field; compute a mean anywhere (one 6,651 ms call distorts it); call Vapi or any
provider -- the backfill reads the disk only and spends nothing.

**Live after the backfill** (`GET /benchmark/calls`, 176 calls, 2026-09-06):
`prodTranscriberLatencyMs` non-null on 77 with **0 stored zeros**, `prodEndpointingLatencyMs`
on 72, `prodAssistantInterruptions` on 47 (21 of them a real `0`), `prodToolCalls` on 100
(25 of them a real `0`). Median transcriber latency across the measured calls: **378.3 ms**.
Second `--apply` wrote 0.

**Learned:**

1. **Two steps in a row, the register's numbers did not survive the disk.** M-6b's file
   count was wrong and so were three of M-7's. The pattern is the same: a count written
   into a spec is a fact about one machine at one moment, and it decays. Counting first
   is now the first action of a step, not a check at the end.
2. **Where "176" came from.** M-6b's register line claimed 176 cached files. The corpus
   has exactly **176 calls**. The number was real and attached to the wrong noun -- a
   call count read as a file count. Worth remembering as a shape: a plausible number in
   a spec may be a true fact about something else.
3. **A zero is a claim, and this one was false.** 23 of the 100 artifacts report a
   transcriber latency of `0`; 21 of them carry an EMPTY `turnLatencies` array, so
   nothing was timed at all. Storing those as `0` would have put "0 ms" beside a
   client's slowest calls. Same for `numAssistantInterrupted`, absent on 53 calls: a
   stored `0` would have reported a calm call nobody observed. Both stay null. Tool
   calls went the other way -- `messages` is on every artifact, so "none" is a real
   measurement and 25 calls legitimately store `0`. Null and zero had to be decided
   field by field; there was no single rule.
4. **The contaminated median is the one that would have been quoted.** 272 ms (the PRD)
   and 274 ms (all 100) both count unmeasured calls as instant. The honest figure across
   the 77 measured calls is **378.3 ms** -- about a third higher. Had M-7b shipped in the
   same PR, that number was going straight onto an org card in front of a client.
5. **M-7 was two steps.** Its acceptance was two sentences about two systems (an API and
   a screen), which is the reliable tell. Split into M-7a (store and serve) and M-7b
   (show). The UI is now built on numbers that were verified first.
6. **One reader, or the corpus splits in half.** 100 calls got their artifact from M-6's
   importer, and the rest of the corpus was hand-rescued by
   `scripts/rescue-customer-audio.mjs`. `readProductionSignals` is called by both paths
   and `artifactCachePathFor` was exported rather than re-joined, so an imported call and
   a rescued one cannot be measured differently.
7. **Three independent counts agreed.** A standalone python pass over the artifact files,
   the backfill's dry run against the database, and the live API after the write all
   produced 77 / 72 / 47 / 100. Any one of them alone would have been a claim.
8. **Proof by breaking, twice.** `measuredLatency` relaxed from `> 0` to `>= 0` failed
   exactly one test (`expected +0 to be null`); `serializeCall` given the `|| null` a
   hurried reader writes failed exactly one other (`expected null to be +0`). The second
   break is the one worth keeping: `||` is the natural thing to type and it silently
   erases the 21 real zeros.
9. **What this did not do.** 76 of the 176 calls have no artifact file and never will --
   they aged out of Vapi's 14-day window before the rescue ran, so their four columns are
   null permanently and no future backfill can change that. And the backfill is the only
   door: a NEW rescue that saves an artifact does not fill the columns by itself, it
   needs `bash scripts/apply-backfills.sh --apply` run again.
10. **`real` is float4.** 378.3 comes back as 378.29998…; the test asserts with
    `toBeCloseTo` and M-7b must round to whole ms rather than print what the column holds.

**Corrected 2026-09-06 while splitting this step.** The original M-7 was written from
the PRD's numbers and three of them were wrong against the disk: the artifacts are
**100, not 99** (M-6's import added one); the median transcriber latency is **274 ms
counting the 23 unmeasured calls as 0 ms, and 378.3 ms across the 77 that were actually
measured** -- the PRD's "272 ms" is the contaminated figure, and quoting it on a client
page would understate real production latency by about a third; and
`numAssistantInterrupted` is **present on only 47 of 100 calls**, so "25 of 99 calls
interrupted" counted 53 calls that were never asked as if they had answered "no".
Tool calls: 75 of 100 have at least one, not 74 of 99.

---

### M-7b — The production signals on screen

**Status:** done 2026-09-06 (PR #93, `3af08f2`, deployed `3af08f2cfbbb`).

**PR:** one.
**Depends on:** M-7a (nothing to render until the columns are filled).
**Files:** `artifacts/stt-benchmark/src/lib/production-signals.ts` (new -- the rules,
stated once), `artifacts/stt-benchmark/src/lib/production-signals.test.ts` (new),
`artifacts/stt-benchmark/src/pages/Rankings.tsx` (`useProductionBaseline` and
`ProductionBaselineNote`), `artifacts/stt-benchmark/src/pages/Corpus.tsx`
(`ProductionTranscriberPanel`),
`artifacts/stt-benchmark/src/pages/__render__/results.test.tsx`,
`artifacts/stt-benchmark/src/pages/__render__/calls.test.tsx`.

**Two things this step said were wrong. Corrected here, where they were written:**

1. "the Calls row shows prod 378 ms in the **measurements group**" -- there is no
   measurements group on the Calls table. Its columns are Call ID / Label,
   Disagreements, Vertical, Duration, Status, Hard Cases, Actions. The signals went to
   `ProductionTranscriberPanel` instead, which already names the transcriber that
   produced them and renders in BOTH the expanded row and the details dialog, so one
   edit reaches two surfaces.
2. "**`verdict.ts` adds the medians** to the `production` object" -- deliberately not
   done, and `artifacts/api-server/src/lib/verdict.ts` was not touched. `bulkVerdicts`
   groups per ORG (`sourceAccountLabel`); the card this line renders on groups per
   ASSISTANT. Nothing renders `verdict.production`'s medians today, so adding them
   would have been an unrendered field at the wrong grain. If the exported
   `verdict.html` ever wants an org-level figure, that is its own step.

**Today (before this step):** the Calls row and its panels showed nothing about how
production performed, and the Results card's production line named the vendor and model
only.
**Change (as built):** four pure functions in
`artifacts/stt-benchmark/src/lib/production-signals.ts` -- `medianMs` (measured values
only, rounded to whole ms), `countMeasured`, `interruptedShare` (calls with an
interruption over calls Vapi gave a count for), `roundMs`. `useProductionBaseline`
computes them over the assistant's calls; `ProductionBaselineNote` appends
"`<n>` ms transcriber latency (median of `<n>` measured calls)." and "Assistant
interrupted on `<m>` of `<n>` measured calls." to the "Production today:" line, each
clause absent when nothing carries it. `ProductionTranscriberPanel` gains a Transcriber
latency and an Endpointing latency row on the same rule.
**Acceptance:** WHEN the Land And Apartment card renders THEN it SHALL read a median in
ms computed only from calls whose `prodTranscriberLatencyMs` is non-null, and WHEN no
call in the group carries one THEN the clause SHALL be absent -- the rendered output
SHALL NOT contain "0 ms". **Met**, and the absent path is live, not hypothetical: of the
32 assistant groups in the corpus, **8 render no latency clause at all**, including the
22-call `Default` group.
**Verify:** `pnpm run typecheck`; the Results render test asserts the line from a fixture
median, and a second case with every signal null asserts neither "0 ms" nor "0 of" is
rendered.
**Must not:** compute a mean; render a zero, a dash or a "not recorded" placeholder
where the number is absent -- drop the clause; execute a run.

**Live after deploy** (`GET /api/benchmark/calls`, 176 calls, 32 assistant groups):

| assistant group | calls | renders |
| --- | --- | --- |
| Land And Apartment `b3914788` | 39 | 495 ms (median of 19 measured) · interrupted on 3 of 16 |
| `Default` (no assistant) | 22 | nothing -- no call carries either column |
| Land And Apartment `8a0bd090` | 18 | 206 ms (median of 8) · interrupted on 1 of 3 |
| Land And Apartment `70f3da18` | 15 | 699 ms (median of 6) · interrupted on 2 of 2 |
| Land And Apartment `60522198` | 3 | no latency clause · **interrupted on 0 of 3** |
| Land And Apartment `2d08db3a` | 2 | 63 ms (median of 1) · **interrupted on 0 of 1** |

**Learned:**

1. **The corpus median describes no assistant.** M-7a's honest 378.3 ms is the median
   across all 77 measured calls; the per-assistant medians live between **63 ms and
   3,093 ms**. A single org number on a client card would have been true and useless.
   The grain of a number has to match the grain of the card it sits on.
2. **A rendered 0 is not always wrong.** Two groups show "interrupted on 0 of N measured
   calls" and that is the honest read: Vapi counted, the assistant did not interrupt.
   The same 0 in the latency clause would be a lie. Null-vs-zero stays a per-field
   decision on screen exactly as it was in storage (M-7a).
3. **The step's own Files list was the tell.** It named `verdict.ts`, a server file, for
   a change whose acceptance is a rendered card. Reading who actually feeds that card
   (`useProductionBaseline`, client-side, per assistant) is what surfaced the grain
   mismatch -- before any code was written, not after.
4. **`ProductionTranscriberPanel` renders twice.** The expanded Calls row and the
   details dialog both mount it. Putting the two rows there cost one edit and reached
   both, where a new table column would have reached neither dialog nor panel.
5. **Proof by breaking, twice, committed first.** (a) `medianMs`'s filter changed to map
   an unmeasured call to 0 -- the exact PRD bug -- fails 4 tests, including
   `expected 207 to be 378` and `expected '207 ms transcriber latency (median of...' to
   contain '378 ms transcriber latency'`: the contaminated median rendering on a
   client-facing card. (b) the latency clause rendered unconditionally with `?? 0` fails
   exactly one test, the acceptance one:
   `expected <span data-testid="prod-latency"></span> to be null`.
6. **114 tests in `@workspace/stt-benchmark`, was 102** -- 9 unit, 2 Results render, 1
   Calls render. No provider was called; nothing was spent.

---

### M-7c — Say once how many groups have no production measurement

**Status:** done 2026-09-06 (PR #94, `681483c`, deployed `681483c03902`).
**PR:** one.
**Depends on:** M-7b (the per-card clause exists and is correctly silent).
**Files:** `artifacts/stt-benchmark/src/pages/Rankings.tsx`,
`artifacts/stt-benchmark/src/pages/__render__/results.test.tsx`.
**Today (was):** M-7b's production line drops its latency clause when no call in the
group carries `prodTranscriberLatencyMs` -- right per card, invisible in aggregate. A
reader cannot tell "measured, and this is the number" from "nobody measured this group"
by scrolling. Logged in `docs/backlog/good-to-have.md` ("a silent card and a loud card
look the same").

**Two things this step said were wrong. Corrected here, where they were written:**

1. **The denominator.** The step said "**8 of the 32** assistant groups render no clause
   at all". 32 is the corpus's group count; the page does not render 32. Rankings are
   bulk-scoped, so Results shows **29** groups all-time and **17** on the newest bulk.
   Shipping "of 32" would have been a true number about a page nobody is looking at --
   the same grain mistake M-7b caught in its own step text one step earlier. The line
   counts the groups the page renders: live it reads **22 of 29** all-time and **11 of
   17** on the newest bulk.
2. **The cause.** The step gave one: "their audio aged out of the 14-day window before
   it could be saved." Probed on disk before the sentence was written -- 7 of the 8
   silent corpus groups have no artifact file at all, but group `60522198` has **three
   saved artifacts, every one reporting no turn latencies**. Vapi saved the call and
   gave no timings. Two causes, so the shipped line names both.

**Change (as built):** one muted line beside the Results legend, from the same
`useListBenchmarkCalls()` data the cards use: "Production latency is measured on
**N of M** assistant groups below. The other K carry no call with one: either no Vapi
artifact was saved before the 14-day window closed, or the artifact that was saved
reported no turn timings. Their cards say nothing rather than 0 ms." Absent when
N === M, and absent while rankings are still loading. The group is counted measured by
the card's own predicate -- `countMeasured(...) > 0`, the same function
`useProductionBaseline` medians with -- so the line and the cards cannot disagree. No
placeholder appears on any card.
**Acceptance:** **Met.** WHEN Results renders with at least one assistant group carrying
no `prodTranscriberLatencyMs` THEN the page SHALL state the covered-group count and the
total once, and WHEN every group carries one THEN that line SHALL NOT render. Live on
`681483c03902`: all-time reads "22 of 29 ... The other 7", newest bulk reads "11 of 17
... The other 6".
**Verify:** `pnpm run typecheck` (4 projects); `@workspace/stt-benchmark` **116 tests /
15 files**, was 114; `check:cycles`, `check:doc-paths`, `check:api-routes`,
`check:response-edge` all clean.
**Must not:** put a placeholder, a dash or a "not recorded" on any group card; change
what a card with measurements says; execute a run. -- Held: the diff is +56 lines, none
of them inside `ProductionBaselineNote`; no provider was called.

**Learned:**

1. **The denominator is the page, not the store.** Twice in two steps the register named
   a corpus-wide figure for a page-scoped claim. The check is one line: ask the endpoint
   the page actually calls (`/api/benchmark/rankings`, and with `?bulkId=`) and count
   the groups it returns -- 29 and 17, against the corpus's 32.
2. **Share the predicate, not the number.** The line asks `countMeasured(...) > 0`, the
   same function the card medians with. Any future change to what counts as measured
   moves both together; a second, parallel definition would have been free to drift.
3. **A one-sentence cause is worth probing.** The step's "aged out of the window" reading
   was right for 7 of 8 groups and wrong for the eighth, and the eighth is the one that
   already renders "interrupted on 0 of 3" -- artifact saved, timings absent. Reading
   the files cost one script and changed the copy that ships.
4. **Proof by breaking, twice, committed first.** (a) the line rendered unconditionally
   fails exactly one test, the acceptance one:
   `expected <p ...(2)><span ...(1)></span></p> to be null`. (b) the denominator swapped
   to the corpus's groups fails exactly one test:
   `Unable to find an element by: [data-testid="production-coverage"]` -- with the
   fixture's single corpus group, measured === total and the line vanishes entirely.
   The second break is the grain guard, and nothing else in the suite catches it.
5. **No new module.** Four lines reusing `countMeasured` beat a `lib/` helper with its own
   test file for a value used once; the two render cases are the enforcer.

---

### M-8a — Production's transcript is measured against the pack, not ranked in it

**Status:** done 2026-09-06 (PR #98, `a2a57b5`). Not deployed with the merge — see the
deploy note at the end of this block.
**PR:** one.
**Depends on:** M-2 (labels stripped), M-5 (customer cells — the CHANNEL, not the data:
no bulk has run on it yet, see Corrections).
**Files:** `lib/scoring/src/hybrid.ts`, `lib/scoring/src/hybrid.test.ts`,
`lib/scoring/src/index.ts`, `lib/scoring/src/index.test.ts`,
`artifacts/api-server/src/lib/verdict.ts`, `lib/api-spec/openapi.yaml` (+ generated
clients), `artifacts/api-server/src/routes/__integration__/verdicts.int.test.ts`, and
the two group fixtures in `artifacts/api-server/src/lib/verdict-artefact.test.ts` and
`artifacts/stt-benchmark/src/pages/__render__/`.

**Corrections to M-8 as it was written (2026-09-06, before any code):**

1. **"Vs production resolves to a provider row that has no cells" was wrong.**
   `productionProviderId` is `null` — it never resolves. `bulkVerdicts` hands
   `resolveProductionProviderId` only the providers that RAN
   (`inArray(benchmarkProvidersTable.id, allProviderIds)`), and Flux never ran, so the
   row is not in the list it searches. Live on 2026-09-06, both bulks:
   `production = {vendor: deepgram, model: flux-general-en, coverage: 50/56}` while
   `productionProviderId = null` and `vsProductionPct = null`. Two independent blockers
   were stacked; the step named the second one only.
2. **`computeHybridFlagsForRun` is not in `run-executor.ts`.** It lives in
   `artifacts/api-server/src/lib/hybrid-flagging.ts`; run-executor only calls it. The
   step's Files list would have sent a weaker model to the wrong file.
3. **No bulk has ever run on the customer channel.** All 630 cells across the two bulks
   carry `audioSource = null` = mono. M-5 built the capability and made
   `requireCustomerAudio` default true for NEW bulks; nothing has used it yet. So this
   step's number is null on every bulk that exists, by design, until the next bulk.
4. **The stored-on-the-run design was dropped** (Abhishek, 2026-09-06). No new jsonb on
   `benchmark_runs`, no executor change, no schema push, no re-execution — see Change.

**Today:** production (Deepgram Flux, 50 of 56 Land And Apartment calls) is
streaming-only, never runs here, and has no cells. The draft's `User:` lines ARE
production's customer-channel transcript for every call (present on 124 of the 126 calls
on disk; the only two line labels Vapi writes are `AI` and `User`).
**Change:** `computeCrossProviderDisagreement` takes
`options.nonVoting?: readonly string[]` — a candidate that is MEASURED against the
consensus without helping to FORM it. That is load-bearing, not stylistic: the
providers' `peerFlagCount` values are computed and stored at run time with production
absent, so a voting production would shift the plurality those stored numbers were
computed against and silently make the two incomparable. With `nonVoting` empty the
function is what it was. `productionCustomerTurns(draft)` in `lib/scoring/src/index.ts`
keeps only the `User:` turns, beside the M-2 label constant it shares. `bulkVerdicts`
computes a per-group `productionDisagreement` at read time — the same place and the same
pass the verdict is already computed in — and the group gains it on
`GET /benchmark/bulks/{id}/verdicts` as a required, nullable object
(`rate`, `leaderProviderId`, `leaderRate`, `calls`, `totalCalls`).
**Acceptance — Met:** WHEN a bulk that declares `requireCustomerAudio` is read THEN each
verdict group SHALL carry a `productionDisagreement` rate computed from the draft's
customer turns against the candidates' consensus, the candidates' own rates SHALL be
unchanged by it, and no `rates` row SHALL be named production. WHEN the bulk ran on the
mono mix THEN `productionDisagreement` SHALL be `null` — present and null, never a
number.

**The gate, and why it is not optional.** Measured on the real data before writing any
code, over the 126 calls of the two bulks:

| | median words per call |
| --- | --- |
| production's `User:` turns | 37 |
| a mono candidate (both speakers) | 126 |

Scoring 37 caller words against a 126-word all-speaker consensus reads as roughly 70 %
disagreement purely because the assistant's turns are absent. That number says nothing
about production and would be shown to a client. Hence null on a mono bulk.

**Verify:**
```
pnpm run typecheck                     # 4/4
pnpm run check:cycles                  # 80 files
pnpm run check:doc-paths
pnpm run check:api-routes              # 58 operations
pnpm run check:response-edge           # 6 files, 58 sites
pnpm -r --if-present run test          # scoring 136, stt-providers 41, ui 116, api 95
cd artifacts/api-server && TEST_DATABASE_URL=postgresql://postgres:postgres@localhost:5433/stt_evals_test pnpm run test:integration
                                       # 122 tests, 27 files
```

**Proved by breaking it** (all three against the committed code):

| Break | What failed |
| --- | --- |
| non-voting filter removed (production votes) | 3 tests, incl. `expected +0 to be 0.16666666666666666` — a **voter's own rate moved** |
| channel gate removed | exactly 1 integration test, the mono one; the customer case still passed |
| extractor keeps the `AI:` turns | the unit test, and end-to-end through the route `rate` went `0.25 → 0.5` |

**Must not — held:** no `benchmark_results` row for production; it is never in `rates`,
never rankable, never pickable; no run executed; nothing spent; no provider called; no
schema change; `vsProductionPct` untouched (it still means "production as a benchmarked
provider row", and is still null).

**Deploy:** the live build stays as it was at merge. The new field reads `null` on both
bulks in the database, so deploying changes nothing a person can see; it goes out with
M-8b, which is what renders it.

**Learned:**
1. **A step's "Today" is a claim, not a given.** M-8's named the wrong cause. Checking it
   against the live API took one curl and changed what the fix had to be.
2. **A capability shipped is not a capability used.** M-5 made customer-channel runs
   possible; nothing had run one. "Depends on M-5" was satisfied in code and empty in
   data, and only the data says whether a number can be trusted.
3. **Adding a voter changes everyone's score.** The consensus is a plurality, so the
   obvious design (throw production in with the rest) would have quietly invalidated
   every stored `peerFlagCount`. Non-voting is smaller AND more correct, and it removed
   the schema change and the re-run the step had asked for.
4. **The break that mattered most was the one that moved a number nobody was looking at.**
   Break 1's headline failure is not production's rate — it is provider `c`'s.

---

### M-8b — The Results page says how far production sat from the pack

**Status:** done 2026-09-06 (PR #99, `f294d2b`), deployed with M-8a.
**PR:** one.
**Depends on:** M-8a.
**Files:** `artifacts/stt-benchmark/src/components/verdict-headline.tsx` (the line, at
org level beside the verdict), `artifacts/stt-benchmark/src/pages/Rankings.tsx` (renders
it, plus the page-level line saying why it is absent),
`artifacts/api-server/src/lib/verdict-artefact.ts` (the same sentence in `verdict.html`),
`artifacts/stt-benchmark/src/pages/__render__/results.test.tsx`,
`artifacts/api-server/src/lib/verdict-artefact.test.ts`.

#### Corrections to M-8b as it was written

1. **It named the wrong component, and the mistake was one of GRAIN, not of path.**
   The step said `ProductionBaselineNote`. That path exists, that component exists, and
   `check-doc-paths.sh` passes — but it renders once per **assistant**, and
   `productionDisagreement` is a property of the verdict **group**, which is an **org**.
   Live proof before any code: `GET /benchmark/bulks/340400b2-.../verdicts` returns one
   group, `Land And Apartment`, with **22 assistant ids**. The number would have printed
   22 times on one page, each time reading as that assistant's own. `Rankings.tsx` had
   already settled the identical question for the verdict itself and says so in a comment
   at the org block: "it sits at org level once -- not repeated under every assistant"
   (T-55/T-88). Shipped at org level.
2. **Its "Today" quoted the wrong file.** `In production today: …` is
   `verdict-artefact.ts`'s sentence. The Results page says
   `Production today: <vendor> / <model> (43/54 of this group's calls)` and derives it per
   assistant from `GET /benchmark/calls`, not from the verdict group. Two different lines
   in two different files at two different grains.

**Change (as shipped):** when `productionDisagreement` is non-null, one org-level line
naming both numbers and the calls behind
them, with a second muted line saying production is measured against the candidates and
never ranked with them. When it is null, **nothing renders** — no zero, no dash, no "0%".
Why it is null on a bulk that did not run on the caller-only channel is said **once at
page level**, in the register the M-7c coverage line uses, reusing `audio-channel.ts`'s
own sentence so an untracked bulk is never described as mono. Same sentence in
`verdict.html`.
**Acceptance:** met. A customer-channel bulk's org block states production's disagreement
and the closest candidate's on one scale with the call count; a null renders no figure
anywhere; the output contains no `__production__` and no `rates` row is named production.

**Correction to M-8b, found while building R-3 (2026-09-09):** this block said the line
named both numbers "on the ranking table's own per-100-words scale", and the component's
own header said "on the same 100-word scale the ranking table uses". Neither was true.
Production's rate is mismatched WORDS over the aligned caller words a plurality existed
at; the table's is peer FLAGS -- a filtered subset -- over the whole call's word basis.
On `42769f26` the same provider reads 2.6 in the line and 0.40 in the table. What M-8b
actually shipped, and what stays true, is that production's rate and the closest
candidate's rate are on one scale **with each other** -- both come out of
`computeCrossProviderDisagreement` over the same calls. The claim is struck above; R-3
made the sentence name its own units and `docs/scoring-policy.md` now carries the
two-rate table.
**Verify (copy-pasteable):**
```
pnpm run typecheck                                              # 4/4
cd artifacts/stt-benchmark && pnpm run test                     # 118 (was 116)
cd artifacts/api-server   && pnpm run test                      # 97  (was 95)
curl -s localhost:8177/api/benchmark/bulks/<id>/verdict.html | grep -c 'Production, measured'   # 0 on a mono bulk
grep -rlF '__production__' artifacts/stt-benchmark/dist/public/assets                            # nothing
```
**Break-proofs (all post-commit, fixtures only — no database, no provider, no spend):**

| Break | What failed |
| --- | --- |
| render the line inside the assistant card as well | `expected 3 to be 1` — the org line plus two per-assistant copies. Correction 1, as an assertion. |
| null renders a `0.0` instead of nothing | the mono test: a `production-disagreement` node exists where none should |
| the artefact prints a `0.0` instead of staying silent | `expected … not to contain 'Production, measured'` |

Each break failed **exactly one** test.

**Must not — held:** `vsProductionPct` untouched; production is in no `rates` row, no rank
and no pickable candidate; no schema change; no run executed; nothing spent.

**Deploy:** `bash scripts/deploy-api.sh` — `681483c03902 -> f294d2bcf2ab`, which carried
M-8a out with it. Live checks: `productionDisagreement` present-and-null on all 4 groups
of the 3 bulks; `verdict.html` unchanged apart from the absent line; the built UI bundle
contains all five new strings and no `__production__`.

**Learned:**

- **A doc path check cannot catch a grain error.** M-8a's lesson was that a Files list can
  name a file whose *contents* the claim is wrong about. This is the sharper version: the
  path, the file and the component were all real, and the step was still wrong, because
  the component renders at a different grain than the data. The only thing that caught it
  was reading the live payload and counting `assistantIds`.
- **The corpus's shape is the argument.** "22 assistants in one org group" turned an
  arguable design preference into a fact. Grill with the running system, not with taste.
- **The codebase had already answered.** T-55/T-88 put the verdict at org level for
  exactly this reason and left a comment saying so. A step that contradicts a comment
  already in the file it edits is a step to re-read, not to execute.
- **The absence explanation belongs where the cause lives.** The reason is the bulk's
  channel, which every org on the page shares, so it is said once at page level. Repeating
  it per org would have been the same mistake as correction 1, one level up.

**Left for later (not smuggled in):** a customer-channel bulk whose number is null for a
*per-call* reason — no caller turn on the draft, or fewer than three candidates — renders
nothing and explains nothing. The step scoped the explanation to the channel; the per-call
case has no words yet.

### M-9 — "Least disagreement", not "Winner", and the line that says what it is

**Status:** done 2026-09-06 (PR #100, `b9a96ef`), deployed `f294d2bcf2ab -> b9a96efd5e0f`.
**PR:** one.
**Depends on:** nothing.
**Files (as shipped — five render sites, not the two this step first named):**
`artifacts/stt-benchmark/src/components/verdict-headline.tsx` (`DECISION_META.winner.label`,
the legend paragraph, and the new relative line),
`artifacts/stt-benchmark/src/pages/Rankings.tsx` (the per-row marker and two comments),
`artifacts/stt-benchmark/src/pages/Landing.tsx` (the example chip and legend),
`artifacts/api-server/src/lib/verdict-artefact.ts` (`DECISION_META`, the legend, the new
relative line, the header comment),
`artifacts/stt-benchmark/src/pages/__render__/results.test.tsx`,
`artifacts/api-server/src/lib/verdict-artefact.test.ts`,
`artifacts/api-server/src/routes/__integration__/riskiest-endpoints.int.test.ts`.

**Corrections to M-9 as it was written** (all three found by grilling, before code):

1. **The Files list named 2 of 5 render sites.** It named `Rankings.tsx`'s chip and
   `verdict-artefact.ts`'s label. It missed `verdict-headline.tsx`'s
   `DECISION_META.winner.label` — *the verdict chip itself*, the most prominent "Winner"
   on the page — plus that file's legend paragraph, and both of `Landing.tsx`'s (a static
   example captioned "what a client sees"). Following the step exactly would have left
   the acceptance sentence false on the page it is about.
2. **The proposed copy said "on the same customer audio". No bulk on file is
   customer-channel.** All three live bulks return `requireCustomerAudio` unset, and
   `verdict.ts:186` reads unset as `"mono"` — every provider ran the mono mix. Shipped as
   **"on the same audio"**.
3. **The proposed copy said "no transcript here was checked by a person". That is already
   false.** `select count(*), count(gold_transcript) from benchmark_calls` → **2 of 176**
   carry a human-written gold; both differ from their draft (so both count under D4's own
   rule) and both sit in runs. Shipped as **"nothing here is scored against a
   human-checked transcript"** — a claim about the *scoring*, true by construction
   (gold-free hybrid flagging since 2026-08-27; `wer`/`entityAccuracy` no longer read),
   and one that cannot rot the next time somebody golds a call.

**Change (as shipped):** chip, row marker and artefact label read **"Least
disagreement"**. Both legends begin "Least disagreement = fewest disagreements per 100
words…". One permanent muted line renders **once per surface**, beside the legend:
*"Relative: how often each provider disagreed with the others on the same audio. Not a
measured accuracy — nothing here is scored against a human-checked transcript."* It sits
at page/document grain, never per org and never per assistant, because it describes the
method (M-8b's lesson applied before coding, not after).

**Acceptance:** WHEN Results or `verdict.html` renders a settled verdict THEN the word
"Winner" SHALL NOT appear anywhere in the rendered output, and the relative line SHALL
be visible without interaction. — met.

**Verify (copy-pasteable):**
```
pnpm run typecheck                                    # 4/4
cd artifacts/stt-benchmark && pnpm run test           # 119 (+1)
cd artifacts/api-server   && pnpm run test           # 99 (+2)
cd artifacts/api-server && TEST_DATABASE_URL=postgresql://postgres:postgres@localhost:5433/stt_evals_test pnpm run test:integration   # 122
grep -rn "Winner" artifacts/stt-benchmark/src artifacts/api-server/src lib | grep -v test
#   -> verdictWinnerId identifiers + one comment only
curl -s http://localhost:8177/api/benchmark/bulks/340400b2-42a0-41bc-a5a8-154f5dff8072/verdict.html | grep -c Winner   # 0
```

**Proved by breaking it** (post-commit, fixtures only — no DB writes, no provider, no spend):

| Break | Result |
| --- | --- |
| UI chip label back to `"Winner"` | 1 failed / 119 |
| UI relative line deleted | 1 failed / 119 |
| artefact label back to `"Winner"` | 1 failed / 99 |
| artefact relative line deleted | 1 failed / 99 **and** 1 failed / 122 integration |

**Must not — held:** `decision: "winner"` in `lib/scoring/src/verdict.ts` untouched; it
is code, not copy.

**Verified live after deploy:** `verdict.html` on bulk `340400b2` → `Winner` **0**,
`Least disagreement` 1, relative line 1, `same customer audio` 0. Deployed UI bundle
(17 chunks): the phrase in 3 chunks, the relative line in 2, and the single `Winner`
match is the preserved prop name `verdictWinnerId`, not copy.

**Learned:**

- **A step can be wrong by *undercount* as well as by grain.** M-8b's step named a real
  component at the wrong grain; M-9's named real components but only 2 of 5. Both pass
  `check-doc-paths.sh` and both would pass a symbol resolver. The thing that catches an
  undercount is a case-sensitive grep for the literal string across *every* package
  before believing the Files list — 20 seconds, and it was the whole difference here.
- **A step's Verify can be red on arrival.**
  `riskiest-endpoints.int.test.ts:185` asserted `toContain("Winner")` on the artefact
  HTML. M-9's Verify listed the two unit suites and a grep, never the integration suite,
  so a weaker model executing this step faithfully would have opened a red PR and had no
  instruction telling it where to look. **A step that changes rendered copy must run the
  integration suite in Verify**, because the artefact is asserted end-to-end there.
- **Prefer a claim about the method over a claim about the corpus.** Correction 3 is the
  general rule: "no transcript was checked by a person" is data that drifts; "nothing is
  scored against a human-checked transcript" is code that can be read. The first needs a
  guard nobody wrote; the second is true as long as the scoring is.
- **A marketing example is a render site.** `Landing.tsx` is captioned "what a client
  sees". Renaming the product's words everywhere except the page that teaches them is
  the same bug as not renaming at all.

**Left for later (not smuggled in):** the whole lowercase `winner` family — see M-9b.

### M-9b — the lowercase `winner` family, decided once

**Status:** done 2026-09-06 (PR #101, `b4941a0`), deployed `b9a96efd5e0f -> b4941a07703d`.
Step corrected first in `41836d1`.

**Decided by Abhishek, 2026-09-06** — all three recommendations taken:

1. Row tag `winner` → **`fewest`**. Six characters, same cell, and it names the
   disagreements-per-100-words column beside it.
2. The verb changes: `X wins N of M orgs outright` → **`X has the least
   disagreement in N of M orgs`**. "outright" dropped — the chip and legend
   already carry what it meant.
3. The denials change too, so one vocabulary holds: `No clear winner` →
   **`Nothing decided`**, `Ahead, not a winner` → **`Ahead, but not decided`**,
   `No winner named.` → **`Nothing decided.`**, `no winner is named on this
   evidence` → **`nothing is decided on this evidence`**.

**Corrections to M-9b as it was written** (all made before any code, in `41836d1`):

- **It named 4 files and "eight places". There were 22 rendered strings across
  6 files.** Third occurrence of the undercount class (M-8a named the wrong
  file, M-9 named two of five sites).
- **The biggest miss was reachable only through the `Must not`.** The verdict
  sentence is built in `lib/scoring/src/verdict.ts` (~348) and printed by
  `artifacts/stt-benchmark/src/components/verdict-headline.tsx` twice,
  `artifacts/api-server/src/lib/verdict-artefact.ts` once, and by
  `artifacts/stt-benchmark/src/pages/Dashboard.tsx` at 2xl on the Overview.
  The step mentioned that file **only** as `Must not: touch decision:
  "winner"`, with no line named. Read faithfully that says "leave the file
  alone", and leaving it alone makes the step's own acceptance false on the
  largest text in the product while every guard still passes.
- **`artifacts/api-server/src/lib/verdict-artefact.ts` line ~103** (`— winner
  has N% fewer disagreements than production`, now `— the named provider
  has …`) was in none of the step's descriptions of that file.

**Change, as shipped:** 22 strings across
`lib/scoring/src/verdict.ts`,
`artifacts/stt-benchmark/src/components/verdict-headline.tsx`,
`artifacts/stt-benchmark/src/pages/Rankings.tsx`,
`artifacts/stt-benchmark/src/pages/Landing.tsx`,
`artifacts/api-server/src/lib/verdict-artefact.ts`, plus the four suites that
assert them. `artifacts/stt-benchmark/src/pages/Dashboard.tsx` needed no edit —
it prints the scoring sentence, which changed upstream.

**Verify (copy-pasteable):**
```
pnpm run typecheck
pnpm --filter @workspace/scoring test          # 136
pnpm --filter stt-benchmark test               # 119
pnpm --filter @workspace/api-server test       # 102
TEST_DATABASE_URL=postgresql://postgres:postgres@localhost:5433/stt_evals_test \
  pnpm --filter @workspace/api-server run test:integration   # 27 files, 122 tests
```
Note the filter is `@workspace/api-server`. `--filter @stt/api-server` matches
no project **and still exits 0** — it prints "No projects matched the filters"
and passes. Read the log, never the exit code.

**Proved by breaking it** (post-commit, fixtures only — no DB write, no
provider call, no money):

| Break | Failed |
|---|---|
| row tag `fewest` → `winner` | 2 / 102 api-server |
| scoring sentence → `wins:` | 1 / 136 scoring |
| Rankings marker → `Ahead, not a winner` | 3 / 119 stt-benchmark |
| counts strip `decided` → `winner` | 1 / 119 stt-benchmark |
| `winner` reinserted in the artefact legend | 1 / 122 integration |

**Must not — held:** `decision: "winner"` and its literal, `winnerProviderId`,
the generated types in `lib/api-zod/` and `lib/api-client-react/`, the
`data-decision="winner"` attribute, the `.chip.winner` CSS class. All code, not
copy; all still present, and the guards strip exactly them before asserting.

**Verified live** (`b4941a07703d`):
- Bulk `f5324fd4-0184-4aa3-ac1f-80c9302ca05c` (decision `winner`) renders
  "AssemblyAI has the least disagreement in 1 of 1 org.", the headline
  "…has the least disagreement: 2% fewer disagreements per 100 words than
  Gladia.", the counts strip "1 decided", and the row tag `fewest`.
- Bulk `340400b2-42a0-41bc-a5a8-154f5dff8072` (decision `too_close`) renders
  "Nothing decided: …" and "Ahead, but not decided: AssemblyAI."
- Both artefacts: **0** visible "winner", **0** visible "wins" (with the
  `<style>` block and `class` attributes stripped, since both carry the enum).
- Deployed UI bundle, all 17 chunks: the new copy present, and all 16
  `winner`/`wins` matches are the enum literal or an identifier
  (`winnerProviderId`, `verdictWinnerId`, `counts.winner`).

**Learned:**

1. **A `Must not` that names a file without naming a line reads as a
   prohibition on the file.** It is the one field a careful executor treats as
   absolute, so a path that appears *only* there is a path that will not be
   opened. Any step forbidding part of a file must say which part, and say
   plainly that the rest is in scope.
2. **The undercount is now a class with three instances, and it is
   scriptable.** Walk `artifacts/*/src` and `lib/*/src`, regex the phrase, and
   compare the file set found against the file set the step names. It found
   the scoring lib in one run. Worth a second mode on `check:doc-paths`:
   *the paths named exist* is only half of it; *the paths that match are
   named* is the half that keeps failing.
3. **A wrong pnpm filter exits 0.** `--filter @stt/api-server` printed "No
   projects matched the filters" and returned success — the integration suite
   never ran, and only reading the log caught it. The standing rule to `tee`
   and read the file, not the exit status, is what saved this step.
4. **Every test asserting verdict copy uses a literal fixture.** Both unit
   suites hand-build a `HeadlineVerdict`; the one integration test that fetches
   `verdict.html` seeds a bulk with no scored calls. So the guards prove the
   renderers, and the scoring string is proved only by its own unit assertion.
   Queued as **S-9** rather than fixed here.
5. **Two of the three live bulks do settle on a winner**, so the `fewest` tag
   and "has the least disagreement" render on real data — verified by hand
   above. It was the *tests*, not the data, that never exercised the path.

### S-9 — a settled verdict, rendered end-to-end, at least once

**Status:** done 2026-09-06 (PR #102, `2067ed5`), deployed `b4941a07703d -> 2067ed5f5644`
**PR:** one.
**Depends on:** M-9b.
**Files:**

- `artifacts/api-server/src/routes/__integration__/verdicts.int.test.ts` — the new
  test goes inside the existing `describe("GET /api/benchmark/bulks/:bulkId/verdict.html")`
  block, beside the self-contained-document test, and uses that file's existing
  `Fixtures` instance and `afterAll` cleanup.
- `artifacts/api-server/src/routes/__integration__/riskiest-endpoints.int.test.ts` —
  **comment only, line ~194.** Its M-9b NOTE reads "No test anywhere renders a real
  scoring-built winner sentence into HTML; that gap is S-9, not this step." This step
  makes that sentence false, so it is corrected where it was made rather than quietly
  elsewhere (mystandard §5.4).

_Corrected 2026-09-06, before any code._ The first draft of this step named
`riskiest-endpoints.int.test.ts` "or a new `verdict-artefact.int.test.ts` beside it",
reusing "the seeding helpers already in `verdicts.int.test.ts`". Three things were
wrong with that: `seedBulk()` in `verdicts.int.test.ts` is a **local, non-exported**
function, so no other file can reuse it (the only cross-file helper is the `Fixtures`
class in `artifacts/api-server/src/routes/__integration__/fixtures.ts`); a new file
would make this step's own **Verify** count wrong (a new file is 28, not 27); and a
new file would stand up a second `Fixtures` instance and a second `pool.end()` to
hold one test. The right home is the file that already owns this route's describe
block.

**Today:** every test that asserts verdict copy uses a literal fixture. The
unit suites build a `HeadlineVerdict` object by hand and pass it to the
renderer; the one integration test that fetches `verdict.html` seeds a bulk
with **no scored calls**, so the page it asserts on contains only the summary
and the legend. Found while writing M-9b's break tests: the composed path
`score() -> computeVerdict() -> renderVerdictArtefact() -> HTTP` has never
been exercised **by a test** for `decision === "winner"`. It was verified by
hand on 2026-09-06 against bulk `f5324fd4-0184-4aa3-ac1f-80c9302ca05c`, which
does settle — so the gap is coverage, not correctness. Every phrase M-9 and M-9b changed
in `lib/scoring/src/verdict.ts` is therefore guarded by one unit assertion on
the string, and by nothing that proves the string reaches a client.

**Change:** add one test that seeds a bulk which settles, then asserts the settled
wording came out of the route.

Seed: one org label, two providers, **6 calls both providers scored** (the floor is
`MIN_SHARED_CALLS_FOR_VERDICT = 5` in `lib/scoring/src/verdict.ts`). Give every cell
the same transcript so the two providers' word counts match, and give the runner-up
strictly more `peerFlagCount` than the leader on **every** call — the noise floor is a
*paired* bootstrap that resamples calls, so a gap present on every call keeps the 95%
interval clear of zero in every resample and `decision` is `winner` deterministically,
with no seed-dependence. Leave `sourceTranscriberProvider` unset on the calls so
`productionProviderId` is null and the settled sentence carries no production clause;
production resolution is already covered by the first test in this file.

Then, in that one test:

1. `GET /api/benchmark/bulks/{id}/verdicts` and assert the group's
   `verdict.decision === "winner"` with a non-null `winnerProviderId`.
   **This assertion is what stops the rest of the test being vacuous.** If the seed
   ever drifts under the floor, the page renders "Nothing decided", and every
   no-winner assertion below would pass for the wrong reason — exactly the near-miss
   M-9b found in `riskiest-endpoints.int.test.ts`.
2. `GET /api/benchmark/bulks/{id}/verdict.html` and assert the rendered wording:
   the row tag `<span class="tag">fewest</span>` is present in the raw HTML; the
   visible text contains "has the least disagreement" and the counts strip "1 decided";
   and the visible text matches neither `/winner/i` nor `/\bwins\b/i`. Visible text
   means the `<style>` block and every `class="..."` stripped first — the same seam the
   M-9b guards use, because both carry the `winner` **enum**, which is code, not copy.

**Acceptance:** WHEN the integration suite runs THEN at least one test SHALL
fetch a `verdict.html` whose verdict decision is `winner` and assert that its
rendered wording carries the `fewest` row tag and "has the least disagreement"
and no form of "winner" or "wins".

**Verify:** `TEST_DATABASE_URL=postgresql://postgres:postgres@localhost:5433/stt_evals_test pnpm --filter @workspace/api-server run test:integration`
→ **27 files, 123 tests**, all passing. The package filter is
`@workspace/api-server`; `@stt/api-server` matches nothing **and exits 0**, so read
the count, never the exit code. Then break it twice, restoring with
`git checkout -- <file>` after each:

1. change the row tag in `artifacts/api-server/src/lib/verdict-artefact.ts` from
   `fewest` back to `winner` → the **new** test fails, not only the unit one.
2. cut the seeded call count from 6 to 4 → `decision` becomes `too_few_calls` and
   step 1's precondition assertion fails, proving the precondition is load-bearing
   and the wording assertions are not passing on an undecided page.

**Must not:** call a provider, spend money, or write to the dev database
(`stt_evals`) — the integration suite runs against `stt_evals_test` only.
**Must not** ship a change to `artifacts/api-server/src/lib/verdict-artefact.ts` or
`lib/scoring/src/verdict.ts`: this step is coverage only. The break proofs above do
edit those two files and restore them, so the committed diff touches test files
alone — this prohibition is on what gets committed, not on opening the files.


**Done 2026-09-06.** One test, in
`artifacts/api-server/src/routes/__integration__/verdicts.int.test.ts`, plus a
comment correction in `riskiest-endpoints.int.test.ts`. Integration 27 files /
**123 tests**, was 122. Everything else unchanged: typecheck 4/4, all four guards,
scoring 136, stt-providers 41, stt-benchmark 119, api-server 102. No provider call,
no money, no schema change, `stt_evals_test` only.

**Break proofs**, both after the commit, both restored with `git checkout -- <file>`:

| Break | Result |
|---|---|
| row tag `fewest` → `winner` in `verdict-artefact.ts` | 1 of 123 failed — the new test |
| seeded calls 6 → 4 | 1 of 123 failed, `expected { decision: 'too_few_calls' } to match { decision: 'winner' }` |

**Must not — held.** The committed diff is two test files. `verdict-artefact.ts` and
`lib/scoring/src/verdict.ts` were edited only for the breaks and restored; `git status`
was clean before the push.

**Live check.** `GET /benchmark/bulks/f5324fd4-.../verdict.html` on the deployed build:
`<span class="tag">fewest</span>` present, "has the least disagreement" ×3, "1 decided"
present, **0** visible `winner`, **0** visible `wins`. The fixture and production render
the same shape — the test is not asserting a shape only a fixture can make.

**Learned:**

1. **Fourth step in a row that was wrong before code.** After M-8a (wrong file), M-9
   (two of five places) and M-9b (eight of twenty-two), S-9's Files list was wrong three
   ways at once: it told a weaker model to reuse `seedBulk()` from another file, and
   that function is **local and non-exported**; a new file would have contradicted the
   step's own Verify count (28 files, not 27); and it omitted the one place this step
   falsifies an earlier claim. The undercount class from F-100 is not only about
   counting occurrences — it is about naming the *right* artefact at all.
2. **The exit code lied again, in a new way.** `pnpm ... | tee "$LOG" >/dev/null; echo $?`
   printed `exit=0` on a run that failed 1 of 123, because `$?` after a pipeline is
   `tee`'s status. One step after F-103 (a wrong `--filter` exits 0). Two steps, two
   different ways for the same command shape to report unearned success. `set -o pipefail`,
   and read the counts out of the log — the count is falsifiable, the exit code is not.
3. **The precondition assertion buys less than it looked like, and saying so is the
   point.** On an undecided page the *positive* assertions (`fewest` tag, "has the least
   disagreement", "1 decided") already fail — only the two `not.toMatch(/winner/i)`
   negatives would have passed vacuously. What `decision === "winner"` really buys is a
   failure message that names the cause instead of a missing-substring. Kept for that
   reason, not for the one the step originally gave.
4. **A paired bootstrap settles deterministically only when the gap is on every call.**
   Making the runner-up worse *on average* is not enough: a resample can draw only the
   calls where it is not. Worse on every call means every resample keeps the interval
   clear of zero, so the fixture settles by construction rather than by the seed
   `20260829` happening to be kind.
5. **The flake has a third class.** `run-create.int.test.ts` timed out at 30010ms on a
   route that answers in ~103ms, on the first run; the re-run was 123/123. F-49's two
   known classes were a wrong status and a socket hang-up. Logged against **S-8** with
   the note that any fix must now explain a 30-second hang, not only a wrong status.
   Not silenced: no retry, no raised timeout, no `.skip`.
6. **Still not covered, on purpose:** the UI side. `Rankings.tsx` and
   `verdict-headline.tsx` assert their settled copy against literal fixtures, and closing
   that needs a rendered React tree fed by a real API response — a different seam, and a
   different step if it is ever worth one.

### M-10a — Latency stops deciding rank, because it does not mean the same thing twice

**Status:** `done` 2026-09-06 (PR #103, `f2665de`; follow-up PR #104, `f816da4`), deployed `2067ed5f5644 -> f816da453032`.

**PR:** one.
**Depends on:** nothing. (M-5 is done; nothing in this step reads `audioSource`.)
**Files:**
- `lib/scoring/src/hybrid.ts` — `HYBRID_RANKING_WEIGHTS`, `HybridCompositeInput`,
  `hybridCompositeScore` (bottom of the file, from the `--- Ranking composite ---` banner).
- `lib/scoring/src/hybrid.test.ts` — the first tests `hybridCompositeScore` has ever had.
  Grep it: today the word `composite` appears once, in a comment about a different
  function. The composite that orders every ranking table in the product is untested.
- `artifacts/api-server/src/lib/run-executor.ts` — two places, both in this one file:
  the `hybridCompositeScore({ ... })` call site (~line 1320) drops the two latency
  fields, and the T-6 comment at ~line 128 stops citing latency as a ranking input.
- `artifacts/stt-benchmark/src/pages/Rankings.tsx` — `SORT_TITLES.rank` (~line 84),
  `SORT_TITLES.latencyFinalMs` (~line 89), **and the group-card "Ranked by" line at
  ~line 925 — both its visible text and its `title`.**
  _Corrected 2026-09-06, after shipping. This bullet originally read "Two strings.
  Nothing else on the page." It was wrong: the card header says
  `Ranked by disagreements, price, speed` in visible text on every group, which is the
  most-read statement of the ranking basis on the page. PR #103 shipped without it and
  the page contradicted itself for one deploy. Found by the post-deploy bundle grep,
  fixed in PR #104. Same undercount this project has now logged seven times — and the
  first time in a step written in the same session as the grill that was supposed to
  catch it._
- `artifacts/stt-benchmark/src/pages/__render__/results.test.tsx` — a guard on both.
- `docs/PRD-v6-measure.md` line 40 and `docs/PRD-v3-technical.md` line 257 — both state
  the old formula in prose and are falsified by this step.

_Corrected 2026-09-06, before any code was written. This step replaces **M-10 — "Latency
means end-of-speech latency, or nothing"**, which was wrong in six ways. The title was
right; the body was not, and the body is what a weaker model would have executed:_

1. _It claimed the Cartesia adapter "already measures end-of-audio → final ... from the
   last chunk". **It does not.** `lib/stt-providers/src/adapters/cartesia.ts:414` sets
   `finalAt` when the whole promise settles, and `submittedAt` at line 195 is set before
   the first byte is sent. Nothing anywhere timestamps the last audio chunk —
   `finalizeSent` is a boolean, not a time. Measuring end-of-speech latency is real,
   unstarted work; it is now **M-10b**._
2. _Its own recipe did not achieve its own stated goal. Batch rows at flags 0.85 / cost
   0.15 and streaming rows at flags 0.70 / latency 0.15 / cost 0.15, sorted against each
   other in one table, still leaves Cartesia scoring at most 0.85 against a clean batch
   row's 1.00 — because its latency number is still the whole real-time session. The step
   said it existed to stop punishing the streaming adapter, and would have kept punishing
   it while claiming otherwise._
3. _It put `mode` in the database. Whether a row streams is decided by **our adapter** —
   cartesia.ts opens a WebSocket, every other adapter posts a file — and that is already
   written down at `lib/stt-providers/src/types.ts:57`. A `benchmark_providers` column is
   operator-editable data that can disagree with the code: set `mode = 'streaming'` on
   OpenAI and the number becomes a lie with nothing to catch it. If a mode field is ever
   needed it belongs on `ProviderAdapter`, resolved through `getProviderAdapter()`._
4. _Files undercount, the sixth step running. A `lib/api-spec/openapi.yaml` change
   regenerates `lib/api-zod/src/generated/**` and `lib/api-client-react/src/generated/**`,
   both committed; a new `benchmark_providers` column needs a drizzle push, a default for
   the 11 live rows, and the Providers.tsx write path. None were listed._
5. _Its last clause — "production's own transcriber latency (M-7) is printed in the column
   header" — is already shipped. M-7b renders it per group (`Rankings.tsx:266-269`,
   `data-testid="prod-latency"`) and M-7c already says how many groups lack it._
6. _It had no evidence. The numbers under **Today** below were not in it, and they are the
   whole argument._

**Today:** rank is `providerAggregates.sort((a, b) => (b.composite ?? -1) - (a.composite ?? -1))`
at `run-executor.ts:1350`, and `composite` is `hybridCompositeScore` — flags 0.70,
latency 0.15, cost 0.15. `latencyFinalMs` is `finalAt - submittedAt` (`run-executor.ts:927`),
which is:

- for the six batch adapters, how long a vendor took to hand back a file;
- for Cartesia, the length of the call, because our adapter streams it at real time.

Read off `benchmark_rankings` on 2026-09-06 — mean `latency_final_ms` per provider:
openai 4 613 · deepgram-nova-3 5 487 · gladia 10 665 · assemblyai 12 326 ·
**cartesia 80 754** (max 335 316). One provider's number is 16× the others' because it is
a different quantity, not because it is slow.

And it decides real ranks. Of the **62** assistant groups in `benchmark_rankings` with a
`bulk_id`, **33 have every provider tied on flag badness** — `avg_peer_flag_count +
avg_peer_flag_severity_score` identical across all five. In a tied group the flag term
cancels, so ordering comes from latency and cost alone. In **all 33**, rank 1 is
`deepgram-nova-3`, which is not the cheapest ($0.0043 against Cartesia's $0.0022). It wins
on file turnaround. In 53 % of the groups on screen, the leading candidate is chosen by a
number that means nothing to a voice agent.

**Change:** latency leaves the ranking composite. Not for batch rows — for every row,
which is what the retired step's own title asked for ("or nothing").

1. `HYBRID_RANKING_WEIGHTS` becomes `{ flags: 0.85, cost: 0.15 }`. The `latency` key is
   removed, not set to zero: a zero weight is a weight someone will restore without
   re-deriving why it was zero.
2. `HybridCompositeInput` drops `latencyFinalMs` and `maxLatencyFinalMs`, and
   `hybridCompositeScore` drops `latencyComponent`. Leaving an ignored input in the type
   is a trap — a caller passes a real number and reasonably believes it counted.
3. `run-executor.ts` ~1320: delete the two fields from the call site. Nothing else in
   `aggregateRankingRows` changes — `latencyFinalMs` is still averaged and still written
   to `benchmark_rankings`, because the column is still shown.
4. `run-executor.ts` ~128: the T-6 comment ends "and since latency feeds the ranking
   composite, a self-inflicted storm doesn't just slow the bulk down, it corrupts the
   ranking it's producing." The semaphore singleton is still right; that reason is not.
   Rewrite it to the reason that survives — a 429 storm fails cells, and a failed cell is
   evidence lost from the comparison.
5. `Rankings.tsx` `SORT_TITLES.rank` today reads "From disagreements (cross-provider
   disagreement + wrong entities only), price and speed." Drop the speed clause. It
   becomes false the moment this merges.
6. `Rankings.tsx` `SORT_TITLES.latencyFinalMs` today reads "Time from sending the audio to
   the final transcript." True, and useless, because it is turnaround for a batch API and
   call length for a streaming one. Replace it with something that says both what the
   number is and that it does not affect Rank. Suggested, not mandated — keep it plain and
   keep both facts: `"Time from sending the audio to the final transcript. Batch APIs
   return a file, Cartesia streams at real time, so these are not the same measurement --
   shown for reference, not used for Rank."`
7. `docs/PRD-v6-measure.md` line 40 reads "70 % peer-consensus flags · 15 % batch
   turnaround time · 15 % list price". Two of the three terms need correcting: latency is
   gone, and the third has been the **paid** rate, not list price, since T-116. Say
   85 % / 15 % and say `paid`.
8. `docs/PRD-v3-technical.md` line 257 — "Since latency is 15% of the composite, a
   self-inflicted 429 storm ... corrupts the ranking it's producing." Same correction as
   the code comment, in the place the claim was made.

**Acceptance:** WHEN two providers differ only in `latencyFinalMs` THEN
`hybridCompositeScore` SHALL return the same number for both, and WHEN the Results page
renders THEN no tooltip SHALL say speed feeds Rank.

**Verify:**
- `pnpm run typecheck` from the repo root — 4 projects, clean. The dropped fields on
  `HybridCompositeInput` are what makes this a real check: a missed call site fails here.
- `set -o pipefail; pnpm --filter @workspace/scoring run test` — baseline is **8 files,
  136 tests**; this step adds tests, so expect 8 files and >136. Read the count lines out
  of the output. **Do not** trust an exit code behind a `| tee` (it reports tee's status,
  not the suite's — see the backlog), and **do not** write `--filter @stt/scoring`: a
  filter that matches no project exits 0 with everything skipped. The package name is
  `@workspace/scoring`.
- `set -o pipefail; pnpm --filter stt-benchmark run test` — baseline **15 files, 119
  tests**; expect 15 files and >119.
- Prove by breaking, **after committing**:
  1. Put `latency: 0.15` back in the weights and the latency term back in the formula.
     The new "latency is inert" test must fail. Restore with `git checkout -- <file>`.
  2. Put the words "and speed" back in `SORT_TITLES.rank`. The new render guard must
     fail. Restore.
- There is no live check for this one, and that is not an oversight. `benchmark_rankings`
  rows are written only by `computeRankingsForBulk`/`computeRankingsForRun`, which run
  only when a bulk or run executes. There is no recompute route. **The 33 groups already
  on screen keep their old ranks until a bulk is re-executed, which costs provider money.**
  Say that in the PR body rather than implying the page changed.

**Must not:** no schema change, no `openapi.yaml` change, no regenerating
`lib/api-zod/**` or `lib/api-client-react/**`, no provider call, no re-running a bulk, no
`UPDATE` against `benchmark_rankings`. Do not touch the flag thresholds
(`DISAGREEMENT_FLAG_THRESHOLD`, `DISAGREEMENT_HIGH_THRESHOLD`) or `flagBadnessOf`. Do not
remove the Speed column or stop writing `latency_final_ms` — the number stays visible,
it just stops voting. Do not fix the recommendation sentence here; that is M-10c, and
mixing it in would hide which change moved which rank.

---

**Done.**

| break | result |
|---|---|
| restore the latency term and the 0.70 / 0.15 / 0.15 weights | 2 / 140 fail — `expected 0.7649571428571428 to be 0.6212931428571428`, plus the weight-keys assertion |
| put "price and speed" back in `SORT_TITLES.rank` | 1 / 120 fail — `expected 'From disagreements (cross-provider di…' to match /not from speed/i` |
| put `disagreements, price, speed` back in the visible card line (#104) | 1 / 121 fail — `expected 'Ranked by disagreements, price, speed' not to match /speed/i` |

**Must not — held.** No schema change, no `openapi.yaml` change, no regenerated clients,
no provider call, no `UPDATE` against `benchmark_rankings`. Verified after deploy: the
table still holds 355 rows and the 33 tied groups are still led by `deepgram-nova-3`.
Ranks change only when a bulk is next executed, which is what the step said would happen.

**Live check** on `f816da453032`, against the built bundle: `price and speed` 0,
`disagreements, price, speed` 0, `Not from speed` 1, `does not affect Rank` 1,
`Speed is shown but not ranked on` 1. Every remaining mention of the word was read: the
column label, the direction legend (`Lower is better ... for disagreements, flags, speed
and price` — a direction, not a ranking claim, and still true), and Corpus's own Speed
column, which is a different page and is noted under M-10b.

**Learned.**

1. **The grill's value was the evidence, not the file list.** The retired M-10 named the
   right problem and would have shipped a fix that did not fix it. What settled the
   design was not reading the code — it was querying it: 33 of 62 groups tied on flags,
   so the term that was supposed to decide the rank cancelled, and latency decided it.
   No amount of reading `hybrid.ts` produces that number.
2. **A false parenthetical is more dangerous than a missing file.** "(what the Cartesia
   adapter already measures from the last chunk)" is nine words, and a weaker model would
   have built the whole step on it. The undercount defects logged so far cost extra files;
   this one would have cost a wrong product.
3. **The number that orders every ranking table had no test.** Its three input signals are
   thoroughly covered; the function that turns them into a rank was not called once in 136
   tests. Worth looking for the same shape elsewhere: well-tested inputs, untested combiner.
4. **A guard scoped to an element cannot see the page.** #103's render guard checked the
   two table-header tooltips and passed while the card header said the opposite in visible
   text. #104's guard asserts over every `[title]` in the document and every element whose
   text starts with `Ranked by` — it does not name what it is checking, so it catches the
   site nobody thought of. That is the difference between a guard and a spot-check.
5. **The post-deploy bundle grep is not ceremony.** It was the only thing in the whole loop
   that caught the miss — typecheck, four guards, 403 unit tests, 123 integration tests and
   two CI checks were all green on a page that contradicted itself.
6. **Removing a key beats zeroing it.** `latency: 0` would have read as a tuning decision
   somebody could reverse in one character. Deleting the key from `HYBRID_RANKING_WEIGHTS`
   and both fields from `HybridCompositeInput` means the compiler stops any caller who
   still thinks latency counts — which is exactly how the orphaned `maxLatencyFinalMs`
   surfaced.
7. **Say plainly that the fix does not fix the screen.** There is no recompute route, so
   the 33 groups keep their old ranks until a bulk re-runs, and re-running costs money.
   That belongs in the PR body, not in a footnote nobody reads.

**Evidence — Speed column that is shown but not scored** (`visual-and-research`,
2026-09-06):
- _Pattern to use:_ show the number plainly beside the score and say in the column's own
  tooltip that it does not feed the score — ranked tables put the score column next to
  plain value columns and use a dash where a value is missing rather than a stand-in
  number ← [Profound screen](https://mobbin.com/screens/65d2d37b-bcec-4a75-85d2-3cb0933b4c57),
  [OKX screen](https://mobbin.com/screens/616a128d-2240-490e-9204-749e7902aef3).
- _Patterns to avoid:_ two different weightings inside one sorted table — the retired
  M-10's batch-0.85 / streaming-0.70 recipe. Every ranked table found scores every row by
  the same formula ← [Profound screen](https://mobbin.com/screens/65d2d37b-bcec-4a75-85d2-3cb0933b4c57).
- _What operators say:_ Jessica Lachs (VP Analytics & Data Science, DoorDash): a metric
  "people can talk about across the company ... is going to be a much better metric in
  terms of driving real outcomes than your made up composite score that nobody
  understands." — "Building a world-class data org", Lenny's Newsletter podcast,
  2024-07-14, https://www.youtube.com/watch?v=D4PDb_C8Dww
- _Changes to the plan:_ drop latency for every row rather than adding a second,
  mode-dependent weighting; keep Speed visible with an honest tooltip instead of hiding
  the column.
- _No evidence found for:_ a dedicated "shown but not scored" badge or affordance on a
  ranking table. No screen found marks a column that way, so this step says it in the
  tooltip rather than inventing a badge.

---

### M-10b — Measure end-of-audio latency, then let it count again

**Status:** `done` 2026-09-07 (PR #105, `3d05093`), deployed `f816da453032 -> 3d05093493b6`.

**Retitled while shipping.** It said "end-of-speech". It measures end-of-AUDIO: the
anchor is the end of the recording, so trailing silence inflates it. Leaving the title
alone would have shipped a column whose name overstates it — the exact defect M-10a
existed to remove.

**PR:** one.
**Depends on:** M-10a.
**Files:** `lib/stt-providers/src/types.ts` (`ProviderTranscribeResult`),
`lib/stt-providers/src/adapters/cartesia.ts` (the `ws.send("finalize")` branch, ~line 331),
`lib/db/src/schema/benchmark-scores.ts`, `artifacts/api-server/src/lib/run-executor.ts`,
`lib/api-spec/openapi.yaml` **and the two generated clients it regenerates**
(`lib/api-zod/src/generated/**`, `lib/api-client-react/src/generated/**`), plus
`artifacts/stt-benchmark/src/pages/Rankings.tsx`.

**Today:** M-10a took latency out of the ranking because the tool cannot measure the only
latency a voice agent cares about — the gap between the caller stopping and the final
transcript arriving. Cartesia is the one adapter that streams, and it does not record when
the last chunk went out: `cartesia.ts` sets `finalizeSent = true` and never stamps a time.
`latencyFinalMs` is therefore the whole session, dominated by real-time playback.

**Change:** stamp the moment the last audio chunk is sent; carry it out of the adapter as
a new nullable field on `ProviderTranscribeResult` (batch adapters leave it null, exactly
as they already leave `firstPartialAt` null); store the derived
`end-of-audio → final` figure in its own column on `benchmark_scores`, never overwriting
`latencyFinalMs`; show it in its own column. Only once a real number exists for at least
one provider is it worth arguing about whether it re-enters the composite — and that
argument is a separate step, not this one.

**Acceptance:** WHEN a Cartesia cell completes THEN the score row SHALL carry an
end-of-speech latency smaller than the call's duration, and WHEN a batch adapter's cell
completes THEN that column SHALL be null, never zero.

**Verify:** unit test on the adapter's event reducer with a synthetic event list — no
provider call. `pnpm run typecheck`. A live check needs one paid Cartesia call and is a
**go-spend**, not part of the step.

**Also on the page, found 2026-09-06 while verifying M-10a:**
`artifacts/stt-benchmark/src/pages/Corpus.tsx` shows the same per-call number in its own
Speed column, titled "Time to the final transcript. Lower is better." For a Cartesia row
that number is the length of the call, so "lower is better" is misleading there in exactly
the way M-10a fixed on Results. Not fixed as a drive-by; it belongs to this step, because
this step is what makes the number mean something.

**Must not:** must not overwrite `latencyFinalMs`, must not put the new number into
`hybridCompositeScore` (that is a later step, with its own argument), must not call a
provider without an explicit go-spend, must not write a zero where nothing was measured.

**Must not — held.** `latencyFinalMs` untouched (999 rows still populated, unchanged).
Nothing added to `hybridCompositeScore`; `benchmark_rankings` still 355 rows, unchanged.
No provider called, nothing spent. Null, never 0, on every unmeasured path.

**Split while shipping.** The step as written was adapter + type + schema + executor +
openapi + two regenerated clients + two pages. That is not one PR, and the display half
has nothing to display: the column is null on all 999 existing score rows, null forever
on six of seven providers, and null on Cartesia until a bulk re-runs, which costs money.
Shipped the measurement; the display became **M-10d**, which also carries the
`Corpus.tsx` "Lower is better" fix this step had adopted.

**What was learned:**

1. **The step named the wrong anchor, and only the database could say so.** "Store the
   derived `end-of-audio → final` figure" sounds right. `finalAt` is stamped when the
   socket settles — *after* this adapter's own `IDLE_CLOSE_MS = 2000` wait. Across 207
   live Cartesia rows the end-of-audio-to-`finalAt` gap is p25 2,580 ms / median
   2,983 ms / p75 3,358 ms: clustered around our own timer, not around Cartesia. Built
   literally, it would have reported ~3,000 ms for a vendor tail of roughly 600–1,400 ms.
   No amount of reading `cartesia.ts` produces that distribution — the query does.
2. **A number contaminated by a constant we chose is worse than no number.** It is
   plausible, it is stable, and it is wrong. The end anchor that measures the vendor is
   the last final segment that carried *text* — the instant the transcript stopped
   growing.
3. **Sixth step running that the grill found wrong before code.** The class keeps
   changing: wrong file (M-8a), undercounted files (M-9, M-9b), wrong artefact (S-9),
   false parenthetical (M-10), and now a plausible-but-contaminated anchor. The reading
   that catches this one is not "is the claim true" but "is the number this claim
   produces the number its name promises".
4. **Put the arithmetic where a test can reach it.** Computing the delta inline in
   `transcribe()` would have made it unreachable without a live socket. A named pure
   `endOfAudioLatencyMs()` beside the existing reducer costs nothing and is provable.
5. **Prove the schema, not just the code.** The column was added by `ALTER`, not
   `drizzle-kit push`, so drift was a live risk that would surface only on a paid
   Cartesia call. Dropping the column from the test database fails **14** integration
   tests with `column "latency_end_of_audio_ms" ... does not exist`. Free proof of the
   expensive failure.
6. **Null has to survive contact with the pipeline.** Zero would rank as the fastest
   provider possible. Both the helper and the integration test assert null, not 0, for a
   batch adapter and for a truncated stream (11% of the 207 live rows show the truncated
   shape).
7. **The 207 existing rows cannot be backfilled.** `rawOutput` stores the messages
   without their arrival timestamps, so the anchors are gone. Worth knowing before
   anyone promises a retroactive chart.

**`visual-and-research`:** skipped — backend only (adapter, schema, executor), no copy
and no screen. It belongs to M-10d, which is where the number becomes visible.

---

### M-10c — Rank 1 says it won on flags when it tied on flags

**Status:** `done` 2026-09-07 (PR #106, `25f7c9f`), deployed `3d05093493b6 -> 25f7c9f7f41c`.

**Widened while shipping, in two ways, both because the live data said so.** The step
scoped the fix to rank 1 and to the all-tied case. Neither held up:

1. **The count was a 3x undercount.** The step said the sentence was false on 33 of 62
   groups (every provider tied). Measured on 2026-09-07, rank 1 had the fewest flags in
   **1 of 62** groups. In 26 it was tied for fewest with *some* of the others -- a case
   the step's predicate does not cover at all -- in 33 with all of them, and in 2 it had
   **more** flags than the provider directly below it. False on **61 of 62 (98%)**, not
   53%.
2. **The runner-up sentence carries the same lie.** "Behind rank 1 on hybrid flag
   composite (more or more-severe ... flags)" is wrong in those same 61 groups, and in
   all 33 all-tied groups it sat on `cartesia-ink-whisper` -- identical flag badness and
   **half the price** ($0.0022 against rank 1's $0.0043). The single most misleading cell
   on the page. It is the same expression in the same file, so it was fixed here rather
   than deferred: one defect, not two steps.

Its parenthetical also still blamed confidence spans, which **T-2 removed from the
composite on 2026-08-27**. Corrected in passing because the sentence was being rewritten
anyway.

**PR:** one.
**Depends on:** M-10a (which changes how often the tie happens, so fixing this first would
have to be re-verified after).
**Files:** `artifacts/api-server/src/lib/run-executor.ts` (~line 1409, the `recommendation`
template), and whichever integration or unit test asserts on that string.

**Today:** rank 1's stored recommendation reads "Leading candidate for this assistant's
calls — fewest/least-severe hybrid flags among ready providers." In **33 of 62** groups
every provider is tied on flag badness, so nobody had the fewest and the sentence is
false. It is stored in `benchmark_rankings.recommendation` and rendered as-is. Found
2026-09-06 while grilling M-10; logged in `docs/backlog/good-to-have.md`.

**Change:** the sentence must describe what actually decided the rank. When the flag term
is tied across every provider in the group, say so and name what broke the tie (price);
when it is not tied, the existing sentence is correct and stays.

**Acceptance:** WHEN every provider in a group has equal flag badness THEN rank 1's
recommendation SHALL NOT claim fewest or least-severe flags.

**Verify:** unit test on the tied case and the untied case. Prove by breaking: force the
tied branch to emit the old sentence and watch the tied test fail.

**Must not:** must not change the ordering, must not touch the composite, must not rewrite
stored rows.

**Shipped as:** a new pure module `artifacts/api-server/src/lib/ranking-recommendation.ts`
(`rank1Recommendation`, `runnerUpRecommendation`), called from `aggregateRankingRows`.
13 unit tests, 2 integration tests. api-server 102 -> 115, integration 124 -> 126.

**What was learned:**

1. **The step's own number was the thing to check first.** "33 of 62" came from a
   backlog entry written while grilling M-10, and it was measuring the wrong predicate:
   *every provider tied* rather than *rank 1 tied with anyone*. The second is the one the
   sentence is a claim about. Grilling a step now includes re-deriving the number the
   step quotes, not just reading it.
2. **Weights do not tell you which term decided.** With `flags 0.85 / cost 0.15` it looks
   safe to say flags decided. It is not: `flagComponent` is normalised into 0..1, so a
   small flag gap is worth less than the full 0.15 the cost term can swing, and 2 live
   groups have a flaggier provider ranked first. A sentence about cause has to be derived
   from the values, never from the weights.
3. **A tie is a third answer, not a rounding of the first two.** Flags tied *and* price
   tied means nothing decided the order and it is whatever the sort left (bug-register
   B-96). The old sentence had no way to say that, so it said the false thing instead.
4. **"Absent is not zero" applies to causes.** `hybridCompositeScore` scores a null
   `costPerMinute` as the *best possible* cost. The sentence deliberately does **not**
   mirror that: an unknown price is unknown, and calling such a provider "cheapest" would
   be the composite's bug leaking into English. Mirroring the code you sit next to is not
   automatically correct.
5. **A group of one was printing a comparison.** 2 live groups have a single provider and
   still read "fewest ... among ready providers". Nobody had reported it; it fell out of
   enumerating the branches honestly.
6. **The number the composite ranks on was not on the aggregate.** `flagBadness` had to
   be added: `avgPeerFlagCount + avgPeerFlagSeverityScore` is *not* it, because those two
   average independently over their own non-null cells. Reconstructing a number instead
   of carrying it is how a sentence quietly stops matching the ordering it explains.
7. **The writer of the row had no integration coverage.** `rankings.int.test.ts` inserted
   its rows directly and only ever tested the GET route, so nothing had ever executed
   `aggregateRankingRows` in a test. Same shape as M-10a's untested combiner, one file
   over. The break that mattered was unwiring run-executor from the new module and
   watching the new integration test fail -- the unit tests all still passed.
8. **This fix is invisible today.** There is no recompute route, and the step forbids
   rewriting stored rows, so the 355 existing rankings keep the old sentence -- 63 rows
   still read "fewest/least-severe" after deploy, verified. It stops the falsehood being
   written; it does not retract what was written. A step that corrects generated text is
   worth nothing to a reader until the generator runs again, and that should be said out
   loud when such a step is registered.

**Evidence (`visual-and-research`, run because this is copy a non-technical reader
quotes):**
- **Pattern to use:** state the coarser truth rather than a precise-sounding false one --
  Linear deliberately ships half-year buckets instead of dates "so you never feel like you
  have to give this sense of false precision ... that ends up with a whole bunch of
  miscommunication down the line". *"Linear's secret to building beloved B2B products"*
  (Nan Yu, 2025-01-30) https://www.youtube.com/watch?v=nTr21kgCFF4
- **No evidence found for:** a UI pattern that explains a broken tie. Four Mobbin web
  leaderboards ([Circle](https://mobbin.com/screens/d2ab497c-5477-4f03-a672-745bc497bc00),
  [Whop](https://mobbin.com/screens/59002773-8028-402f-8d53-289a371704cb),
  [Dub](https://mobbin.com/screens/689c21bf-97f4-4fce-a478-dafd48f8b3d1),
  [Fey](https://mobbin.com/screens/8ef3e642-9067-472c-8d1a-5779fc403fd6)) show ranked
  tables with no tie language at all; Fey's analyst table lists many equal ratings and
  simply makes no claim about which is best. Circle explains its *ranking rule* in a
  separate "How do points work?" modal -- adjacent, not the same thing.
- **Changes to the plan:** none to the shape. It reinforced saying "tied" plainly rather
  than reaching for a softer word, and reinforced that making no claim (Fey) beats making
  a confident wrong one.

---

### M-10d — Stop calling the Speed number "lower is better"

**Status:** `done` 2026-09-07 (PR #107, `f7dbd70`), deployed `25f7c9f7f41c -> f7dbd704ddcb`.

**Retitled and halved while shipping.** It was written as one step covering both the copy
fix and the display of `latencyEndOfAudioMs`. The display half moved to **M-10e** (see
below): it needs a column on `benchmark_rankings` that does not exist and that the step
never named, and it has nothing to show -- **0 of 999 score rows carry a value**, and 6
of the 7 providers can never carry one.

**The step named the wrong file, and the wrong file was a trap.** It said the offending
tooltip is in `artifacts/stt-benchmark/src/pages/Corpus.tsx`. It is not: it is in
`artifacts/stt-benchmark/src/components/provider-comparison-section.tsx`, which Corpus is
the only page to import. `Corpus.tsx` does contain the phrase "Lower is better" -- at line
373, on **disagreements**, where it is **true**. Following the step literally edits the
correct copy and leaves the wrong copy untouched.

**Its acceptance was unachievable.** The Verify line said to grep the built bundle for
"Lower is better" and **expect 0**. Ten occurrences are correct statements about
disagreements, unsure words, flags and cost. Meeting the step as written meant deleting
true sentences. The check actually run after deploy asserts the *five* false forms are
gone, the *new* honest copy is present, and the total count is **greater than zero** --
verified: 5 x 0, 3 x present, 10 total.

**Three false claims, not one.** The step named the Speed tooltip. Also live:
- `Rankings.tsx` `DIRECTION.latencyFinalMs = "↓"`, rendered as a span whose `aria-label`
  reads "lower is better" -- in the same cell as M-10a's tooltip disclaiming the number.
- `Rankings.tsx` page legend: "Lower is better for disagreements, flags, **speed** and
  price".
- `provider-comparison-section.tsx` section header: "Lower is better on every number in
  this table", as visible text **and** as its own tooltip, with Speed in that table.

**PR:** one.
**Depends on:** M-10b.
**Files:** `lib/api-spec/openapi.yaml` **and the two generated clients it regenerates**
(`lib/api-zod/src/generated/**`, `lib/api-client-react/src/generated/**`),
`artifacts/api-server/src/routes/benchmark.ts`,
`artifacts/stt-benchmark/src/pages/Rankings.tsx`,
`artifacts/stt-benchmark/src/pages/Corpus.tsx`,
`artifacts/stt-benchmark/src/pages/__render__/results.test.tsx`.
**Today:** `benchmark_scores.latency_end_of_audio_ms` exists and is written by
run-executor, but nothing reads it — it is not in the OpenAPI schema, not in either
generated client, and not on any page. Separately, `Corpus.tsx` titles its Speed column
"Time to the final transcript. Lower is better." over `latencyFinalMs`, which for a
Cartesia row is the length of the call — misleading in exactly the way M-10a fixed on
Results, and misleading **today**, independent of this step's new column.
**Change:** serialise the column, regenerate both clients, show it in its own column
distinct from Speed, and correct the `Corpus.tsx` tooltip.
**Acceptance:** WHEN a page renders a Cartesia row THEN no visible text and no tooltip
anywhere SHALL describe `latencyFinalMs` as lower-is-better, AND the end-of-audio column
SHALL render a dash, never a number, where the value is null.
**Verify:** `pnpm run typecheck`; the render suite; after deploy, grep the built bundle
at `artifacts/stt-benchmark/dist/public` for "Lower is better" and expect 0 —
`Rankings.tsx` shipped wrong once under a guard scoped to one element (M-10a, PR #103),
so the guard here must sweep every `[title]` on the document.
**Must not:** must not put the new number into `hybridCompositeScore`, must not render 0
or "—" as if it were a measurement, must not re-run a bulk to populate the column.

**Shipped as:** `Rankings.tsx` (DIRECTION now `"↓" | "↑" | null`, Speed null, header
renders no arrow; legend rewritten), `provider-comparison-section.tsx` (header + Speed
column), `ComparisonBody` exported, new jsdom test
`components/provider-comparison-section.test.tsx`, and the Results page-wide sweep widened.
stt-benchmark 121 -> 124.

**What was learned:**

1. **A guard is only as wide as the attribute it reads.** M-10a built a page-wide sweep
   over `[title]`. The claim that survived lived in an `aria-label` and in visible legend
   text, one and three elements away. The sweep now covers both -- and asserts the *other*
   columns keep their arrows, so it cannot pass by stripping every direction on the page.
2. **A page-wide sweep cannot reach a page with no render test.** Corpus has none; the
   component it renders had none either. That, not subtlety, is why this survived. The fix
   was a component-level test, not a wider grep.
3. **"Expect 0 occurrences" is almost always the wrong acceptance for a copy fix.** The
   same words are true somewhere else on the same page. An acceptance written as a count
   pressures the executor into deleting correct statements to go green -- proved by
   breaking: stripping every "Lower is better." from the component satisfies the step as
   written and fails the test that guards true copy.
4. **A disclaimer next to a recommendation is worse than either alone.** M-10a's tooltip
   said the number means two different things; the arrow in the same cell said minimise
   it. A reader trusts the arrow -- it is shorter, and it is the thing the column is
   sorted by.
5. **The register's own file paths need re-deriving, not reading.** Third time a step
   named a file the string was not in (M-8a, M-9, now this). The new part is that the
   named file contained a *correct* instance of the exact phrase to remove.

**visual-and-research:** not run. This is removing a false direction claim, not choosing
new copy -- the honest wording already existed in M-10a's approved `latencyFinalMs`
tooltip on the same page, and was reused verbatim.

---

### M-10e — Serialise and show the end-of-audio latency

**Status:** `done` 2026-09-07 (PR #108, `e02b35e`), deployed `f7dbd704ddcb -> e02b35e5f4cd`.

**This step's own dependency reasoning was wrong, corrected here rather than quietly
elsewhere.** It said M-11 "would otherwise write a number nothing can display". M-11's
numbers already had somewhere to **land** -- `benchmark_scores.latency_end_of_audio_ms`,
shipped by M-10b. What was missing was somewhere to **look**. The sequencing conclusion
(do this before M-11) is still right, for the corrected reason: M-11's first streaming
numbers are visible the moment they exist instead of sitting unread in a column no page
reads.

**PR:** one.
**Depends on:** M-10b (the column on `benchmark_scores`), M-10d (the Speed copy it sits
beside). Best done **before M-11**, so the first Deepgram streaming numbers are visible
the moment they are written rather than landing in a table nothing displays.

**Files:** `lib/db/src/schema/benchmark-rankings.ts`,
`artifacts/api-server/src/lib/run-executor.ts` (`aggregateRankingRows`),
`lib/api-spec/openapi.yaml` **and the two generated clients it regenerates**
(`lib/api-zod/src/generated/**`, `lib/api-client-react/src/generated/**`),
`artifacts/api-server/src/routes/benchmark.ts`,
`artifacts/stt-benchmark/src/pages/Rankings.tsx`,
`artifacts/stt-benchmark/src/components/provider-comparison-section.tsx`,
`artifacts/stt-benchmark/src/pages/__render__/results.test.tsx`.

**Today:** `benchmark_scores.latency_end_of_audio_ms` exists (M-10b) and run-executor
writes it, but **nothing reads it**. It is not in the OpenAPI schema, not in either
generated client, and on no page. `benchmark_rankings` carries `latency_first_partial_ms`
and `latency_final_ms` and has **no end-of-audio column at all** -- M-10b added the column
to `benchmark_scores` only, so the aggregate has nothing to serialise. M-10d's step text
missed this; it listed neither the rankings schema nor run-executor.

**Data state, and why this step is not urgent:** `select count(latency_end_of_audio_ms)
from benchmark_scores` = **0 of 999**. Six of the seven providers are batch adapters and
will always be null. Cartesia rows can only be filled by a paid re-run, and the 207
existing ones can never be backfilled (`rawOutput` drops `receivedAtMs`, O-35). Shipping
this today renders a column of dashes.

**Change:** add the nullable column to `benchmark_rankings`, average it in
`aggregateRankingRows` the way `latencyFinalMs` is averaged, serialise it, regenerate both
clients, and show it in its own column distinct from Speed -- with a dash, never a zero,
where it is null, and a tooltip that says end-of-**audio**, not end-of-speech (trailing
silence is included).

**Acceptance:** WHEN a ranking row has no end-of-audio latency THEN the column SHALL
render a dash and no number, AND WHEN a Cartesia row has one THEN it SHALL render distinct
from the Speed column and SHALL NOT feed Rank.

**Verify:** `pnpm run typecheck`; the render suite; the post-deploy bundle check written
for M-10d, extended to assert the new column's honest tooltip is present. A live number
needs one paid Cartesia call and is a **go-spend**, not part of this step.

**Must not:** must not put the number into `hybridCompositeScore`, must not render 0 or a
dash as if it were a measurement, must not re-run a bulk to populate the column, must not
relabel it "end-of-speech".

**Shipped as:** `benchmark_rankings.latency_end_of_audio_ms` (nullable `real` -- a mean,
not the `integer` the scores column stores), averaged in `aggregateRankingRows` over only
the cells that carry it, serialised through `lib/api-spec/openapi.yaml` and both
generated clients into `GET /benchmark/rankings`, and rendered on `Rankings.tsx` as its
own column **"After audio ends"** beside Speed, plus a CSV column. 6 breaks, 1 failing
test each. typecheck 4/4, 4 guards, scoring 140, stt-providers 47, stt-benchmark **126**
(was 124), api-server 115, integration **128** (was 126). Nothing spent, no provider
called.

**Live after deploy:** the field is present on all **145** ranking rows and **null on
every one of them**, exactly as forecast -- `count(latency_end_of_audio_ms)` is still 0 of
999 scores. Post-deploy bundle check: 5 M-10d false forms absent, 7 new strings present,
"lower is better" total 10 (must be > 0). PASS.

**Learned:**

1. **A break test caught a bug in the test, not the code.** The legend guard passed with
   the column removed from its lower-is-better list, because the legend names the column
   **twice** -- once in the direction list, once explaining why it compares when Speed
   does not -- and `toMatch(/wait after audio ends/)` was satisfied by the second mention.
   Asserting a string is *present* is the wrong shape whenever the string has more than
   one role on the page; the assertion must be scoped to the clause making the claim.
   Second time this shape has bitten in three steps (M-10d's "expect 0 occurrences" was
   the same mistake pointing the other way). Fixed in `d55ef9a` and re-broken to confirm.
2. **`benchmark_providers.supportsStreaming` is a trap for anyone explaining the dash.**
   It is `true` on **10 of 11 rows**. It describes the vendor's API, not how our adapter
   runs it -- only `cartesia.ts` opens a WebSocket. Explaining an empty cell from that
   flag gets it wrong for 5 of the 6 batch providers. There is no column that answers
   "can this provider report end-of-audio"; the copy therefore explains the dash
   generically and names no provider.
3. **A null that is permanent by construction is a different object from a null that is
   missing this run.** Every other dash in the Results table means "not measured on this
   run, a later run may fill it". This one means "never, for this kind of provider". Same
   glyph, different promise -- so the cell says which, not just the header.
4. **Sorting is what makes a by-construction null dangerous.** Sorted by this column, six
   dashes sit under one number and read as six providers losing a race they were never
   in. The header explains it, but sorting detaches a cell from its header, so the
   explanation had to go in the cell too.
5. **Adding the field to OpenAPI's `required` list broke the render fixture at
   typecheck** -- free proof the field is genuinely required end to end, the same free
   proof M-10b got when a missing DB column failed 14 integration tests at once.
6. **Break F (re-sorting rankings by this latency) failed exactly one test -- the one
   written in this step.** The ranking order comparator in `aggregateRankingRows` is
   otherwise unguarded: a change to it does not reliably fail anything. Logged.
7. **The dashes-today decision was deliberate, not an oversight.** Shipping a column that
   is 100% empty was weighed against waiting for M-11. Shipped because the alternative is
   M-11 producing numbers no page reads, and because a permanently-visible "we do not
   have this" is the project's own stated principle (absent is not zero), not a gap.

**Evidence -- the "After audio ends" column**

**Pattern to use:** mark a cell that cannot have a value with a neutral, low-contrast
dash and put the reason on the label, never a zero and never a red ✕ -- ✕ reads as a
deficiency, a dash reads as not-applicable, which is the true state for a batch adapter.
← [Slite](https://mobbin.com/screens/bc7f1ea9-d17b-4d67-b263-baf7284fa7a7) (plain "-" plus
an ⓘ on every row label),
[Lyssna](https://mobbin.com/screens/00564053-4aaa-41bc-9bbd-8acd898b1bb1) (greyed glyph)
**Patterns to avoid:** the red-✕ treatment used by
[Relevance AI](https://mobbin.com/screens/e0501a17-5d16-464a-bc12-16e4f58a4b78),
[NordVPN](https://mobbin.com/screens/9882de2a-0f73-4863-9d7b-d60ef2e73dd4) and
[Discord](https://mobbin.com/screens/474948b0-8725-4632-aa5d-26f8828daeaa) -- correct when
a plan withholds a feature, wrong here, because a batch API is not failing to report
end-of-audio, it structurally has none.
**What operators say:** naming what a number stands for is what lets a reader ask "are we
missing data? was this a bad proxy?" instead of silently mistrusting the whole board --
"How to measure AI developer productivity in 2025" (Nicole Forsgren, 2025-10-19)
https://www.youtube.com/watch?v=SWcDfPVTizQ
**Changes to the plan:** the explanation moved from the header alone into the cell as
well (Slite puts it on the row label; a column-oriented sortable table detaches the cell
from its header, so the label alone is not enough).
**No evidence found for:** how a **sortable numeric leaderboard** should treat rows that
cannot report a metric. All six comparison tables found were static feature grids, not
sortable. The sort behaviour here (nulls sink, dash explains itself) is reasoned from the
repo's own existing rule, not from evidence.

---

### M-10f — Show the end-of-audio number on the per-call comparison

**Status:** `done` 2026-09-07 (PR #109, `5d1a6ad`), deployed `e02b35e5f4cd -> 5d1a6ada1de0`.

**This step's own Files list named the wrong serialiser, corrected here rather than
quietly elsewhere.** It said `artifacts/api-server/src/routes/benchmark.ts`, "near
`latencyFinalMs: score.latencyFinalMs`". That line is real, and it is the **wrong one**:
it belongs to the run-results serialisation (`ScoreDetail`), an endpoint no comparison
view reads. The per-call comparison is built in `artifacts/api-server/src/lib/call-comparison.ts`,
which carries a nearly identical line (`latencyFinalMs: score?.latencyFinalMs ?? null`).
Grep cannot tell the two apart; only following the endpoint can. `routes/benchmark.ts` was
not touched by this step. The same sentence said "the second and third `latencyFinalMs`
entries" in the spec -- only the **third** (`ComparisonRow`) was this step's; the second
(`ScoreDetail`) belongs to that other endpoint and is still un-carried, which is
deliberate: nothing renders it.

**PR:** one.
**Depends on:** M-10e (the column, the copy and the dash treatment to match).
**Files (as shipped):** `lib/api-spec/openapi.yaml` **and the two generated clients it
regenerates** (`lib/api-zod/src/generated/**`, `lib/api-client-react/src/generated/**`),
`artifacts/api-server/src/lib/call-comparison.ts`,
`artifacts/api-server/src/routes/__integration__/call-comparison.int.test.ts`,
`artifacts/stt-benchmark/src/components/provider-comparison-section.tsx`,
`artifacts/stt-benchmark/src/components/provider-comparison-section.test.tsx`.

**Today:** M-10e put the averaged number on the Results ranking table only. The per-call
comparison on Corpus (`provider-comparison-section.tsx`, whose `ComparisonBody` M-10d
exported as a test seam) still shows only `latencyFinalMs` -- the number that is call
length for Cartesia. A reader comparing one call's providers side by side sees the
measurement with no direction and not the one with a direction.

**Why this is its own step, not part of M-10e:** the per-call table reads a **different
endpoint with its own response schema** (the provider-result shape, `openapi.yaml` around
the second and third `latencyFinalMs` entries), so this is a second serialisation path,
not a second render of an already-serialised field.

**Change:** serialise `latencyEndOfAudioMs` on the per-call provider result, regenerate
both clients, and add a column to `ComparisonBody` using **exactly** M-10e's dash
treatment: a dash that explains in the cell that only a streamed provider can report it
and that a dash is not a slow score.
**Acceptance:** WHEN the per-call comparison renders a batch provider THEN its
end-of-audio cell SHALL be a dash carrying its own explanation, AND WHEN it renders a
streamed provider with a value THEN the cell SHALL show milliseconds distinct from the
Speed column.
**Verify:** `pnpm run typecheck`; `pnpm --filter stt-benchmark run test`; break it by
replacing the cell's explaining title with the generic "Not measured in this run" and
watch the component test fail.
**Must not:** must not describe `latencyFinalMs` as lower-is-better (M-10d), must not
render 0 for a batch provider, must not call it "end-of-speech", must not spend.

**Shipped as:** 8 files, +174/-8. A seventh column, "After audio ends ↓", between Speed
and Cost on the per-call comparison; `latencyEndOfAudioMs` on `ComparisonRow` in the spec
and both generated clients (additive only, +12/-0); read straight off the score row in
`call-comparison.ts`, never derived and never defaulted to 0.

**Live after deploy:** `GET /api/benchmark/calls/<id>/comparison` -- field present on all
5 rows of the most-attempted call, **0 non-null, 0 zeros**, `latencyFinalMs` non-null on
all 5. Post-deploy bundle scan of `artifacts/stt-benchmark/dist/public` (1,214,814 chars):
6 new strings present, 5 M-10d false forms all 0, "After audio ends" twice (Results and
the comparison). RESULT: PASS.

**Learned:**

1. **A step's Files list can be wrong and nothing catches it.** Typecheck, the four
   guards and CI all pass whichever of the two files you edit -- they only disagree about
   which endpoint changes. Two serialisation blocks in different files carry near-identical
   `latencyFinalMs: score...` lines. The check that works is following the route to the
   function that builds the response, not grepping the field name.
2. **`openapi.yaml` has three `latencyFinalMs` properties, one per schema** -- `Score`
   (rankings, group average), `ScoreDetail` (run results, per cell), `ComparisonRow`
   (per-call comparison, per cell). "Add the metric everywhere" is a decision per schema,
   not per file. M-10e did `Score`; this did `ComparisonRow`; `ScoreDetail` is
   deliberately still without it, because nothing renders it.
3. **`ComparisonRow` now carries two structurally different nulls.** The `"missing"`
   placeholder row (the run promised this provider and it never wrote a cell -- nothing
   ran) and a scored batch cell (it ran fine; there was no moment the audio ended). Both
   serialise `null`. The integration test asserts each separately with its own comment so
   a later refactor cannot collapse them into one "no data" branch.
4. **M-10e's reason for a per-cell tooltip does not hold here, and the tooltip is still
   right.** M-10e argued the explanation had to live in the cell because *sorting*
   detaches a cell from its header. This table does not sort. The tooltip stayed for a
   different and better reason: it is the only column here whose blank is structural,
   while every neighbouring dash means "not recorded on this run". An inherited reason
   had to be re-derived rather than copied.
5. **Seven breaks, one failing test each** -- three against the serialiser (batch null as
   0; end-of-audio served from `latencyFinalMs`; the `"missing"` placeholder as 0), each
   failing exactly **one** of 129 integration tests; four against the component (generic
   dash title; header stops explaining the dash; column loses its arrow; the number stops
   rendering).
6. **A break test that fails to apply its mutation reports as a pass.** Break G's script
   mangled a backtick template literal inside a shell heredoc, the `assert count == 1`
   fired, nothing was edited -- and the suite then printed "128 passed", which reads
   exactly like a guard doing its job. Only the traceback above it said otherwise. Second
   consecutive step where the break *harness*, not the code, was the thing at fault
   (M-10e: an assertion satisfied by a phrase's second occurrence). A break run must
   confirm the mutation landed before its result means anything.
7. **No schema change and no `drizzle-kit push`.** `benchmark_scores.latency_end_of_audio_ms`
   has existed since M-10b; this step only carried it further. Nothing spent, no provider
   called.

**Evidence — end-of-audio column on the per-call comparison** (`visual-and-research`,
2026-09-07)

**Pattern to use:** put the explanation on the column label and keep the dash as the
blank mark -- feature-comparison tables consistently use `—` for "not in this row" and
hang an `ⓘ` off the *label*, never off the cell ← [Toggl Track plan comparison](https://mobbin.com/screens/d08c4a1a-c25b-4730-b8f5-e13b039ab997),
[Webflow plans](https://mobbin.com/screens/1f702cb2-bd88-41e0-a1c1-9fa54542f3de),
[Uxcel compare features](https://mobbin.com/screens/c0904ed2-237b-4c9e-ba9d-52ce7f01640f).
**Patterns to avoid:** one mark for two different kinds of absence. Suno writes "Not
available" as words for a hard no and uses a padlock for "upgrade to unlock" -- two
absences, two marks ← [Suno compare plans](https://mobbin.com/screens/a82bb800-07e6-4717-9006-8073219e687b).
Zendesk's alternative is a footnote symbol plus a legend under the table ← [Zendesk compare Support plans](https://mobbin.com/screens/9403349b-1892-4a69-abab-6d2a57d92258).
**What operators say:** thin. The closest is Nicole Forsgren on making measurement legible:
once a number is in a box on a screen, people start asking of it "is the data poor quality?
are we missing data? was this a bad proxy?" -- an empty box invites the question, so the
answer belongs next to it ← "How to measure AI developer productivity in 2025" (Nicole
Forsgren, 2025-10-19) https://www.youtube.com/watch?v=SWcDfPVTizQ
**Changes to the plan:** the dash treatment survived, but its *justification* changed --
see learning 4. Suno's two-marks-for-two-absences is why the cell tooltip stayed rather
than being folded into the header alone.
**No evidence found for:** a numeric comparison table where a metric is unreportable for
most rows by construction. Every match was a plan/feature matrix, where a blank means "you
did not pay for this", not "this cannot be measured". The pattern was borrowed across that
gap knowingly, not because the match was close.

---

### M-11 — Deepgram streaming rows: nova-3 and Flux

**Status:** `split` 2026-09-07 into M-11a…M-11d below. Kept as a header so nothing that
cites "M-11" dangles. The grill before building found four claims in this step wrong and
one piece of work that was really four. Corrections are written here, in the place the
claims were made, per the standing rule.

**Correction 1 — this was two adapters, not one.** The step said "a WebSocket adapter"
serving both nova-3 and Flux. Verified against the real API 2026-09-07: they speak two
different protocols with nothing shared to parse.
- nova-3: `wss://api.deepgram.com/v1/listen`, messages `{"type":"Results","is_final":…,
  "channel":{"alternatives":[{"transcript":…}]}}`, client flushes with
  `{"type":"Finalize"}` then `{"type":"CloseStream"}`.
- Flux: `wss://api.deepgram.com/v2/listen`, messages
  `{"type":"TurnInfo","event":"EndOfTurn","transcript":…,"words":[…]}` — no `is_final`,
  no `channel`, events `Update` / `StartOfTurn` / `EagerEndOfTurn` / `TurnResumed` /
  `EndOfTurn`. Client closes with `{"type":"CloseStream"}`.
  (https://developers.deepgram.com/reference/speech-to-text/listen-flux and
  .../listen-streaming, both read 2026-09-07.)

**Correction 2 — the nova-3 streaming price was wrong.** This step said $0.0043/min.
That is Deepgram's *batch* nova-3 price, which is what the existing `deepgram-nova-3`
row already carries. Streaming nova-3 is **$0.0048/min promotional, $0.0077/min
regular** (deepgram.com/pricing, read 2026-09-07). Flux English streaming is $0.0065/min
promotional, $0.0077/min regular — this step quoted the promotional figure while the
`deepgram-flux-general-en` row already in the database carries 0.0077, the regular one.
This matters beyond tidiness: cost is 15% of the ranking composite since M-10a, and a
row priced at the batch rate would have been ranked cheaper than it is.

**Correction 3 — `mode: streaming` does not exist.** This step said both rows are
"created `mode: streaming`". There is no such field. `ProviderCatalogEntry` is
`{ adapterId, apiModel }` and nothing more; `benchmark_providers` has `id`, `name`,
`model`, `status`, `supports_streaming`, `supports_diarization`, `cost_per_minute`,
`keyword_boosting`, `config_note`, `manually_disabled` and the timestamps. The one
field that sounds like it — `supports_streaming` — is already `true` on 10 of the 11
rows because it records the *vendor's* API capability, not how our adapter runs (M-10f).
A row is marked not-for-use with `manually_disabled`, which is what M-11a actually does.

**Correction 4 — the Flux row already exists.** `deepgram-flux-general-en` is a live
`benchmark_providers` row (`manually_disabled = t`, cost 0.0077) *and* a `providerCatalog`
entry pointing at the batch `deepgramAdapter` — an adapter that cannot serve it, since
Flux has no batch endpoint. So this is a broken mapping to repair, not a clean new id to
add; creating `deepgram-flux-general-en-streaming` beside it would leave two Flux rows,
one of them permanently unrunnable. M-11c repairs it.

**Found while grilling, and the reason the rows ship disabled:** `timed-words.ts` and
`provider-confidence.ts` both branch on `vendorOfProviderId(...) === "deepgram"` and then
read the *batch* response shape (`results.channels[0].alternatives[0].words`). A
streaming row stores `{ events: [...] }`, so both return null — safely, but silently. No
per-word confidence means no confidence contribution to hybrid flagging, and flags are
85% of the ranking composite. Enabling a streaming row before M-11b lands would put a row
in the ranking whose flag score was computed from less evidence than every row beside it.

---

### M-11a — Deepgram nova-3 streaming adapter (no live call)

**Status:** `done` 2026-09-07 (PR #110, `aca8280`), deployed
`5d1a6ada1de0 -> aca8280fa40f`. 4 files, +733/-1. `lib/stt-providers` 47 -> 65 tests.

**Shipped as:** `lib/stt-providers/src/adapters/deepgram-streaming.ts` (new, 470 lines),
plus the registry entry, the package re-export and 18 tests. No provider was called, no
`benchmark_providers` row was created (confirmed live after the deploy: the four
`deepgram%` rows are unchanged), nothing was spent.

**Live after deploy:** `/api/healthz` reports `aca8280fa40f`, and
`GET /api/benchmark/providers/models` returns **exactly one** `deepgram` vendor card
(`adapterId: deepgram-nova-3`, 19 models) -- the live counterpart of the guard test that
a second adapter declaring `listModels` would have broken.

**Learned:**

1. **Two adapters for one vendor is a registry problem, not a file problem.** The whole
   risk of this step lived in `adapterByVendorPrefix()`, which returns the *first*
   adapter whose vendor prefix matches an id. `deepgram-nova` is a live enabled row that
   is in no catalog and resolves by prefix alone, so it hangs entirely on declaration
   order in an object literal. Order preserved, and pinned by a test.
2. **The right way to say "not this one" is to declare less, not more.**
   `/benchmark/providers/models` filters to adapters with `listModels` and groups them by
   vendor; a second Deepgram adapter declaring one would have put two Deepgram cards on
   Setup. Omitting `listModels` fixes it, and the ids come from `providerCatalog`
   instead, as `elevenlabs-scribe-v2` already does.
3. **A constant that encodes an assumption about the input is a bug waiting for a
   different input.** `cartesia.ts`'s 6400-bytes-every-190ms is 200 ms of audio only at
   16 kHz 16-bit mono. Deriving the chunk from the WAV header makes "never faster than
   real time" a property of the code instead of a property of the corpus. The test
   asserts 200 ms at five sample rates, not a byte count.
4. **Copying an adapter means copying its close sequence, which is vendor-specific.**
   `cartesia.ts` sends `close` and calls `ws.close()` in the same tick. Deepgram answers
   `CloseStream` by flushing what is left and *then* closing, so the same code would
   have silently dropped the last segment of every call -- and a slightly short
   transcript scores as recognition error, not as a bug.
5. **Sameness with the batch row is a feature, not laziness.** `smart_format`, `diarize`
   and the coarse diarization rule are copied from `deepgram.ts` on purpose: the two
   nova-3 rows exist to answer "does streaming cost us accuracy", and any difference in
   settings turns that into a different question.
6. **The key-in-URL is forced, so the throw path has to be closed.** Neither streaming
   adapter can set an `Authorization` header, so both put the key in the URL. A throw
   out of `new WebSocket(url)` lands in `run-executor.ts`'s `if (!result)` branch, which
   writes `err.message` verbatim into a persisted, rendered field. Found by reading the
   executor, not by reading the adapter. `cartesia.ts` has the same shape and is still
   open (backlog).
   **Corrected 2026-09-07 (M-11e).** "Forced" was wrong, and so is the claim in this
   step's own Change text below that "Deepgram documents the query parameter for Listen
   v1/v2 exactly for that case." Re-read that day: the v1 `/listen` reference lists every
   query parameter the endpoint accepts -- callback, callback_method, channels,
   detect_entities, diarize, diarize_model, dictation, encoding, endpointing, extra,
   interim_results, keyterm, keywords, language, mip_opt_out, model, multichannel,
   numerals, profanity_filter, punctuate, redact, replace, sample_rate, search,
   smart_format, tag, utterance_end_ms, vad_events, version -- and `token` is not one of
   them. The Flux v2 reference documents an `Authorization` header only. What Deepgram
   does document for a client that cannot set headers is the subprotocol pair
   `Sec-WebSocket-Protocol: token, <API_KEY>`, and Node 22's global `WebSocket` accepts a
   protocols array (checked locally: the constructor takes it without throwing) -- so
   nothing forced the key into the URL. The evidence note below even cites the
   subprotocol page among the pages read, which makes this a reading error rather than a
   gap in the sources. M-11e moves the key out of the URL. The throw-path guard stays:
   the reasoning about `error_message` holds whatever the URL carries.
7. **Register the hazard your own change creates.** Every guard in this step exists
   because of something this step introduced -- a second vendor-prefix match, a second
   possible model list, a second key-bearing URL. None of them would have been worth a
   test before this commit.
8. **The break harness was fixed, and this time it was checked.** Each of the nine
   mutations was confirmed landed on disk with `git diff --numstat` before its result was
   read, after two consecutive steps where a mutation silently failed to apply and the
   resulting all-green run read exactly like a guard holding. 9 of 9 caught.

**Evidence note:** `visual-and-research` deliberately not run -- a provider adapter, a
registry entry and unit tests, with no screen, no copy and no label involved. Verified
instead against the vendor's own live documentation on 2026-09-07
(developers.deepgram.com/reference/speech-to-text/listen-streaming, .../listen-flux,
.../docs/using-the-sec-websocket-protocol, and deepgram.com/pricing), which is what
caught corrections 1 and 2 in the M-11 block above.

**PR:** one.
**Depends on:** M-10b (`latencyEndOfAudioMs`).
**Files:** new file lib/stt-providers/src/adapters/deepgram-streaming.ts (plain: not
written yet), `lib/stt-providers/src/registry.ts`, `lib/stt-providers/src/index.ts`,
`lib/stt-providers/src/adapters/parsers.test.ts`.
**Today:** every Deepgram row calls `POST /v1/listen` (batch). `cartesia.ts` is the only
adapter in the package that opens a socket, so the end-of-audio column M-10e/M-10f built
has exactly one provider that can ever fill it.
**Change:** a Deepgram **v1** streaming adapter modelled on `cartesia.ts`.
`wss://api.deepgram.com/v1/listen?model=<catalog apiModel>&encoding=linear16&
sample_rate=<from the WAV header>&channels=1&interim_results=true&punctuate=true&token=<key>`.
Auth goes in the `token` query parameter, not the `Authorization` header: the global Node
`WebSocket` cannot set request headers (the same reason `cartesia.ts` uses `access_token`),
and Deepgram documents the query parameter for Listen v1/v2 exactly for that case.
Chunk size is **computed from the WAV header** — `sampleRate × bytesPerSample × 200 ms` —
and sent on a 200 ms interval, so the stream runs at real time at any sample rate.
(`cartesia.ts` hardcodes 6400 bytes every 190 ms, which is real time only for 16 kHz
16-bit audio and 5% faster than real time even then; logged, not changed here.)
Reuses `parseWavPcm` and `endOfAudioLatencyMs` from `cartesia.ts` rather than
re-deriving them — one definition of the measurement is the whole point of M-10b.
Registers `providerCatalog["deepgram-nova-3-streaming"]`. The adapter declares
`vendor: "deepgram"` (same account, so the same concurrency bucket and the same
confidence/timed-word treatment) but **must not** declare `listModels`: the
`/benchmark/providers/models` route groups adapters by vendor, so a second adapter with
`listModels` and vendor `"deepgram"` would render two Deepgram cards on Setup.
**Acceptance:** WHEN a recorded Deepgram v1 message sequence is reduced THEN the adapter
SHALL return the concatenated `is_final` transcripts, a first-partial offset taken from
the first message carrying text, and a last-final offset taken from the last message that
contributed text — AND `getProviderAdapter("deepgram-nova-3-streaming")` SHALL return the
streaming adapter while `getProviderAdapter("deepgram-nova-3")`,
`getProviderAdapter("deepgram-nova")` and `getProviderAdapter("deepgram-flux-general-en")`
SHALL all still return the batch adapter.
**Verify:** `pnpm run typecheck`; `pnpm --filter @workspace/stt-providers run test`.
**Must not:** call the Deepgram API — this step spends nothing and opens no socket;
create the `benchmark_providers` row enabled, or at all (M-11d does that, after M-11b);
declare `listModels` on the new adapter; change `cartesia.ts`; change the batch
`deepgram.ts`.

---

### M-11e — Authenticate the Deepgram socket the way Deepgram documents it

**Status:** `done` 2026-09-07 (PR #111, `f879ebe`), deployed
`aca8280fa40f -> f879ebe430a7`. 2 files, +149/-29. `lib/stt-providers` 65 -> 70 tests.

**Shipped as:** `deepgramStreamSocketArgs(apiKey, opts)` in
`lib/stt-providers/src/adapters/deepgram-streaming.ts`, which builds the URL *and* its
query parameters and returns `{ url, protocols }`. The credential rides in the
`Sec-WebSocket-Protocol: token, <API_KEY>` subprotocol pair. Nothing else about the
request changed: same endpoint, same parameters, same values. No provider was called and
nothing was spent.

**Live after deploy:** `/api/healthz` reports `f879ebe430a7`;
`GET /api/benchmark/providers/models` still returns exactly one `deepgram` vendor card
(`adapterId: deepgram-nova-3`); the four `deepgram%` rows in `benchmark_providers` are
unchanged, so still nothing can select the streaming adapter. The deployed bundle
contains `protocols: ["token", apiKey]` and exactly two `new WebSocket` calls -- one with
a subprotocol (this adapter) and one without (`cartesia.ts`, untouched by design).

**Break test:** 11 mutations, 11 caught, each confirmed landed on disk with
`git diff --numstat` before its result was read, tree clean after. The first pass ran 7
and **2 survived**; both are closed, which is why the PR has two commits.

**Learned:**

1. **Citing a source is not the same as reading it.** M-11a's evidence note lists
   `docs/using-the-sec-websocket-protocol` among the pages checked, and the adapter still
   authenticated with a query parameter that page does not describe and that the v1
   `/listen` parameter list does not contain. The page was fetched; what it said did not
   reach the code. A citation in a note proves a page was opened, nothing more.
2. **The defect surfaced while grilling a different step.** Nothing about M-11e was
   suspected. M-11b's Must-not forced a return to the vendor reference to check the
   streaming message shape, and re-reading the same pages M-11a claimed to have read is
   what turned up the auth error. Grilling the next step audits the last one for free.
3. **A break test that finds holes is worth more than one that finds none.** Two of the
   first seven mutations survived, and one of them -- putting `token` back into the
   parameter block -- was *the exact bug this step exists to fix*. A step can fix a bug
   and still leave the bug free to return.
4. **An unused binding is not a guard here.** I expected a destructured-but-unused
   `protocols` to fail the build; `tsconfig.base.json` sets `noUnusedLocals: false`, so
   reverting to `new WebSocket(url)` typechecks clean. Checked rather than assumed, after
   the mutation survived.
5. **Closing a hole by construction beats closing it with a test.** Moving the parameter
   building inside the helper leaves one place a credential could be added to the URL,
   instead of two places and a test watching only one.
6. **A constructor stub that throws is a cheap wiring test.** `new WebSocket` is the one
   point in `transcribe()` that settles before any timer is created, so a stub that
   records its arguments and throws proves the subprotocol reaches the socket while
   opening nothing, waiting for nothing and leaving no handle pending.
7. **Removing a hazard beats guarding it.** M-11a guarded a key-bearing URL against
   `run-executor.ts` writing it into a rendered field. M-11e takes the key out of the
   URL. The guard stays and is now an assertion rather than a comment -- mutation J,
   which puts the key into the connect error message, is caught -- but it is defence in
   depth instead of the only thing between a credential and the screen.

**Evidence note:** `visual-and-research` deliberately not run -- an adapter's
authentication method, with no screen, no copy and no label involved. Verified instead
against the vendor's live references on 2026-09-07:
developers.deepgram.com/reference/listen-live (the v1 parameter list, which has no
`token`), .../reference/speech-to-text/listen-flux (v2, `Authorization` header only) and
.../docs/using-the-sec-websocket-protocol (the subprotocol pair), plus a local check that
Node 22's global `WebSocket` accepts a protocols array.

**Still unproven:** the handshake itself. No Deepgram socket in this repo has ever been
opened. This step swaps an undocumented method for a documented one; only M-11d proves
either works.

**PR:** one.
**Depends on:** M-11a.
**Files:** `lib/stt-providers/src/adapters/deepgram-streaming.ts`,
`lib/stt-providers/src/adapters/parsers.test.ts`.
**Today:** `deepgram-streaming.ts` puts the raw API key in the socket URL as `token=<key>`
and carries a comment asserting that "Deepgram documents the query parameter for Listen
v1/v2 for exactly that case." That is false, verified 2026-09-07 against both references:
the v1 `/listen` parameter list does not contain `token`, and the Flux v2 reference
documents an `Authorization` header only. The documented method for a client that cannot
set request headers is the subprotocol pair `Sec-WebSocket-Protocol: token, <API_KEY>`,
and Node 22's global `WebSocket` accepts a protocols array. So the adapter authenticates
by a method the vendor does not document, and pays for it by carrying a live credential
in a URL.
**Change:** export a pure `deepgramStreamSocketArgs(apiKey, params)` returning
`{ url, protocols }`; drop `token` from the query string; pass `["token", apiKey]` as the
second argument to `new WebSocket(...)`. Correct the two comments that assert the old
method, including the guard's, which says the URL carries the key.
**Acceptance:** WHEN the socket arguments are built for a key THEN the returned URL SHALL
NOT contain that key in any parameter or anywhere in its text, AND `protocols` SHALL be
exactly `["token", <key>]`.
**Verify:** `pnpm run typecheck`; `pnpm run typecheck:libs`;
`pnpm --filter @workspace/stt-providers test`.
**Must not:** call the API -- the handshake is proved in M-11d, not here; touch
`cartesia.ts`, whose `access_token` is Cartesia's own documented parameter and a separate
backlog item; remove the `new WebSocket` guard, whose reasoning about `error_message`
holds whatever the URL carries.

---

### M-11b — Read timed words and confidence out of a Deepgram streaming response

**Status:** `blocked` -- on M-11d's captured message log, by this step's own Must-not.

**Why (2026-09-07):** no real Deepgram streaming response exists anywhere in the repo.
`docs/provider-data-samples.md` section 3 is the batch shape; section 5 is Cartesia's
streaming shape, captured from a real call. Both files this step edits open with the same
in-code rule -- "every shape here was read off a real captured response ..., not a doc
page" -- so filling the streaming branch in from the vendor's reference would break the
convention those files are built on, in the two functions that feed hybrid flagging,
which is 85% of the ranking composite. **Waiting is safe, and that was checked rather
than assumed:** with no extractor, `hybrid-flagging.ts` passes
`confidenceAvailable: false` (its T-2 comment), so a streaming row reads as "confidence
not reported" rather than as reported-and-clean -- exactly how Cartesia reads today.
Nothing is silently wrong meanwhile; the row simply cannot yet participate in
confidence flagging.

**Corrected 2026-09-07:** this step's Depends on was wrong when the split was written.
It said M-11a, but its own Must-not makes it depend on M-11d, the step that makes the
call. The M-11 split therefore ordered M-11b before the step that unblocks it.

**PR:** one.
**Depends on:** M-11d (its captured message log), and M-11a.
**Files:** `artifacts/api-server/src/lib/timed-words.ts`,
`artifacts/api-server/src/lib/provider-confidence.ts`, and their tests.
**Today:** both files branch on `vendorOfProviderId(...) === "deepgram"` and read
`results.channels[0].alternatives[0].words`. A streaming row stores `{ events: [...] }`,
so both return null — no timed words, no per-word confidence.
**Change:** inside the existing `deepgram` branch of each, fall through to the streaming
shape when the batch shape is absent: walk `events`, keep `type === "Results"` with
`is_final === true`, read `channel.alternatives[0].words[]` (`word`, `start`, `end`,
`confidence`; seconds, same units as the batch shape). Keep returning null — never an
empty array — when neither shape is present.
**Acceptance:** WHEN a stored streaming raw output is passed to
`extractProviderTimedWords` and `extractProviderConfidenceWords` THEN each SHALL return
the words from the `is_final` messages, AND a batch response SHALL still return exactly
what it returns today.
**Verify:** `pnpm run typecheck`; the api-server unit tests.
**Must not:** change the batch code path; invent a shape not present in a captured
response — if no real streaming response has been captured yet, this step waits for
M-11d's message log rather than guessing.

---

### M-11c — Deepgram Flux adapter, and repair the broken Flux mapping

**Status:** `done` 2026-09-07 (PR #112, `4748e99`), deployed
`f879ebe430a7 -> 4748e99b3f9d`. 4 files, +810/-3. `lib/stt-providers` 70 -> 89 tests.

**Shipped as:** `lib/stt-providers/src/adapters/deepgram-flux.ts`, a v2 `/listen` adapter,
with `providerCatalog["deepgram-flux-general-en"]` repointed at it. No new provider id --
the adapter's own `providerId` is the id that already existed. No API call, nothing spent,
no schema change; the row stays `disabled` / `manually_disabled`, so no enabled row's
behaviour changed.

**Live after deploy:** `/api/healthz` reports `4748e99b3f9d` and now lists
`deepgram-flux-general-en` among `providersConfigured` (adapter and env-var NAMES only,
per that route's standing rule -- 7 entries became 8);
`GET /api/benchmark/providers/models` still returns exactly ONE `deepgram` vendor card
(`adapterId: deepgram-nova-3`), so a third Deepgram adapter did not split the Setup page;
the four `deepgram%` rows in `benchmark_providers` are unchanged. The deployed bundle
contains exactly one `v2/listen`, two `new WebSocket(url, protocols)` calls (this adapter
and the v1 streaming one) and one `new WebSocket(url)` (`cartesia.ts`, untouched by
design), and zero occurrences of `token=`.

**Break test:** 18 mutations, 18 caught, each confirmed landed on disk with
`git diff --numstat` before its result was read, tree clean after. The first pass ran 16
and **3 survived**; all three are closed, which is why the PR has two commits.

**Learned:**

1. **The bug came back for free, again, and for a new reason.** As in M-11e, the mutation
   that reintroduced the exact defect being fixed -- repointing the catalog at the batch
   adapter -- survived the first break pass. The cause was structural: `getProviderAdapter`
   checks the exact registry key BEFORE the catalog, and this id is now both, so the
   catalog's `adapterId` is never read for it. Two structures were free to state
   different things about the same row with only one consulted. Fixed with an invariant
   over every catalog entry, not an assertion about Flux, because the trap springs for any
   id that is also an adapter's own id.
2. **A guard that cannot fire, plus a test that passes on someone else's error, looks
   exactly like working code.** The mono check written here could never run --
   `parseWavPcm` already refuses non-mono -- and the test written to prove it worked was
   matching `parseWavPcm`'s message, which also contains the word "mono". Both green,
   both meaningless. Only the mutation exposed it. When a test asserts on an error
   *message*, check which line actually threw.
3. **The most dangerous mutation was the one that produced no wrong text.** Halving the
   send interval streams at 2x real time: the transcript is unchanged and every latency
   is halved. A wrong number that looks plausible is worse than a missing one, and
   nothing in either streaming adapter asserted pacing until now. M-11d's acceptance
   requires it and a live run cannot check it on itself, so it is checked here with fake
   timers and a stub socket.
4. **Grilling paid again, and in the same shape.** The block as split said to authenticate
   "the way M-11e establishes". Reading the actual page showed it names the Listen
   WebSocket, links to the **v1** reference, and never mentions v2 or Flux -- so applying
   it here is an inference, not an established fact. Writing it down as established would
   have been the M-11a defect a second time, one step after correcting it.
5. **Copying a sibling adapter's parameter block is the specific hazard here.** Four
   parameters the v1 adapter sends -- `channels`, `smart_format`, `diarize`,
   `interim_results` -- are undocumented on v2. Each now has a test asserting its absence,
   because "I did not add it" is not a property the next edit inherits.
6. **Absent is not zero, and it needed a function to say so.** Flux documents no
   `diarize`, so its diarization score is null. Zero is what the v1 adapter gives a
   response that could have carried speaker labels and did not; scoring Flux the same way
   would rank it below a provider that tried and failed. A one-line function returning
   null makes the reason greppable and the mutation to `0` catchable.
7. **A test can pin a bug.** `getProviderAdapter("deepgram-flux-general-en")` was asserted
   to return the batch adapter. The mapping was wrong, the assertion was green, and the
   assertion is why nobody looked. Flipping it was part of the acceptance, not a side
   effect.

**Evidence note:** `visual-and-research` deliberately not run -- a provider adapter and a
registry mapping, with no screen, copy or label involved. Verified instead against the
vendor's live reference on 2026-09-07:
developers.deepgram.com/reference/speech-to-text/listen-flux (the v2 parameter list,
message types and `TurnInfo` shape) and .../docs/using-the-sec-websocket-protocol (which
names the Listen WebSocket and links to the v1 reference, and never mentions v2).

**Still unproven:** every claim in this adapter about what the server actually sends. No
Deepgram socket in this repo has been opened, so the authentication, the `FatalError`
frame name, the turn sequence and the latencies are all reference-derived. M-11d is the
step that finds out.

**PR:** one.
**Depends on:** M-11a, and M-11e for the authentication method.
**Files:** new file lib/stt-providers/src/adapters/deepgram-flux.ts (plain: not written
yet), `lib/stt-providers/src/registry.ts`, `lib/stt-providers/src/index.ts`,
`lib/stt-providers/src/adapters/parsers.test.ts`.

**Corrected 2026-09-07:** as written at the split, this step asked for "one real,
redacted Flux message" recorded in `docs/provider-data-samples.md` while its own Must-not
forbids calling the API -- it cannot record what it may not fetch. That sample moves to
M-11d, the step that makes the call. This step builds and unit-tests the adapter against
reference-derived sequences, exactly as M-11a did.
**Today:** `providerCatalog["deepgram-flux-general-en"]` points at the batch adapter,
which has no endpoint that can serve Flux. The row exists in the database, disabled.
**Change:** a **v2** adapter — `wss://api.deepgram.com/v2/listen?model=flux-general-en&
encoding=linear16&sample_rate=…` — reducing `TurnInfo` messages: transcript from the
`EndOfTurn` events, first partial from the first event carrying text, last-final from the
last `EndOfTurn` that contributed text. Repoint the existing catalog entry at it rather
than adding a second id. Authenticate the way M-11e establishes -- the
`Sec-WebSocket-Protocol: token, <API_KEY>` subprotocol pair -- because the Flux v2
reference documents an `Authorization` header and no query-string credential at all.
Two v2 facts to build to, read off that reference on 2026-09-07: Flux documents **no
`diarize` parameter**, so the adapter reports a null diarization score rather than 0
(absent is not zero); and the client closes with `CloseStream`, with `ForceEndTurn`
available to end a turn early.
**Acceptance:** WHEN a recorded Flux `TurnInfo` sequence is reduced THEN the adapter
SHALL return the `EndOfTurn` transcripts joined in order, and `getProviderAdapter(
"deepgram-flux-general-en")` SHALL return the Flux adapter.
**Must not:** call the API; treat `EagerEndOfTurn` as final (`TurnResumed` retracts it);
add a second Flux provider id; send a query parameter the v2 reference does not document.

**Grilled 2026-09-07, before building.** Five corrections, each read off the vendor's
live reference rather than off this block:

1. **The authentication method is an inference for v2, not a documented fact, and this
   block previously read as though it were one.** The subprotocol page names "Deepgram's
   Listen WebSocket endpoint" and links to the **v1** streaming reference; it never
   mentions v2, `/v2/listen` or Flux, and the Flux reference itself documents only an
   `Authorization` header and no subprotocol at all. So the adapter uses the M-11e
   subprotocol pair because it is the only header-less method Deepgram documents
   anywhere -- and marks it UNVERIFIED in code, per the `docs/provider-matrix.md`
   convention that `deepgram-streaming.ts` already uses for its error frame. M-11d
   confirms or refutes it. Saying "M-11e establishes it" for a v2 endpoint would be the
   same move that produced the M-11a defect: carrying a claim across an endpoint
   boundary the vendor never crossed.
2. **v2 documents no `channels` parameter.** The v1 adapter sends one. This adapter must
   not invent it, and must therefore fail loudly on anything but mono rather than send
   interleaved stereo to an endpoint that cannot be told the audio is stereo -- that
   would be decoded as noise and scored as recognition error. Every cached corpus file
   checked is 16 kHz, 16-bit, mono PCM, so this is a guard, not a limitation.
3. **v2 documents no `Finalize`.** The v1 adapter sends `Finalize` and then `CloseStream`.
   Flux documents `CloseStream`, `ForceEndTurn` and `Configure` as its only client
   messages, so the end-of-audio path sends `CloseStream` alone.
4. **v2 documents no `interim_results`, and does not need one.** Partial text arrives as
   `Update` / `StartOfTurn` `TurnInfo` events by default, so the first-partial anchor
   exists without a parameter. On v1 that parameter was load-bearing; here asking for it
   would be sending an undocumented one.
5. **`TurnInfo` carries `transcript` and `words` at the top level**, alongside `event`,
   `turn_index`, `sequence_id`, `audio_window_start`, `audio_window_end`,
   `end_of_turn_confidence`, and `trigger` (`model` | `manual` | `timeout`) on
   `EndOfTurn` only. It is NOT the `channel.alternatives[0]` shape -- that is v1/batch.

**Also found:** `lib/stt-providers/src/adapters/parsers.test.ts` currently *pins the bug*
-- it asserts `getProviderAdapter("deepgram-flux-general-en")` returns the batch adapter.
Flipping that assertion is part of this step's acceptance, not a side effect. And the
seed row for this id in `artifacts/api-server/src/routes/benchmark.ts` declares
`supportsDiarization: true`, which correction 5's sibling fact (no `diarize` on v2) makes
wrong; the row already exists in the database, so editing the seed would not fix it.
Logged in `docs/backlog/good-to-have.md` and flagged for M-11d, not fixed here.

**Deliberate duplication.** The ~180 lines of socket machinery -- real-time chunking,
connect and response timeouts, idle close, close handling -- are duplicated from
`deepgram-streaming.ts` rather than extracted into a shared runner. Extracting it would
edit an adapter that has never been run against the live service, so a failure in M-11d
could no longer be attributed to the auth, the Flux mapping, or the refactor. Logged as a
post-M-11d candidate in `docs/backlog/good-to-have.md`.

---

### M-11d — First live streaming call, then enable the rows

**PR:** one. **This is the step that spends money.**
**Depends on:** M-11a, M-11b, M-11c.
**Files:** `artifacts/api-server/src/lib/default-providers.ts` (the seed rows — moved
there by R-12), `artifacts/api-server/src/lib/default-providers.test.ts` (the
seeded-disabled assertion has to be relaxed in the same PR that enables a row),
`docs/provider-data-samples.md`, `docs/step-register.md`.
**Today:** the adapters exist and are unit-tested against recorded messages. Nothing has
been sent to Deepgram over a socket, so the handshake, the finalize sequence, the real
message shapes and the real latencies are all unverified.
**Change:** stream ONE cached Land And Apartment call to `deepgram-nova-3-streaming` and
one to `deepgram-flux-general-en` (≈ $0.02 total at $0.0048–$0.0065/min). Read the two
result rows. Record both latencies, and record two redacted message logs into
`docs/provider-data-samples.md` as new streaming sections: the nova-3 `Results` log --
**this is what unblocks M-11b**, which may not read a shape off a doc page -- and one
Flux `TurnInfo` message, the sample M-11c is forbidden from fetching for itself. This is
also the first step that proves the M-11e subprotocol handshake against the real
service; until it runs, no Deepgram socket in this repo has ever been opened. Only if both are green,
create/enable the rows at the **regular** prices ($0.0077/min for both — the promotional
rates expire and would silently drift the cost column, which is 15% of the ranking
composite).
**Acceptance:** WHEN one cached call is streamed to each row THEN each cell SHALL store a
final transcript, a `latencyEndOfAudioMs` under 2,000 ms, a `firstPartialAt` and a raw
message log, AND the adapter SHALL never have sent audio faster than real time.
**Verify:** the two result rows read back out of `benchmark_provider_call_results`;
latencies quoted in the PR body.
**Must not:** run a second call before the first is green; enable the rows for bulks
before Abhishek has seen the numbers; run without an explicit go-spend for this step.
**Blocked on Abhishek:** the go-spend. The 2026-09-04 "spend $3–5" go predates this
split and is not being treated as covering it.

**Grilled 2026-09-08, before the go-spend is asked for a second time.** One ordering
hole, found while checking what the next step could be:

1. **There is no `deepgram-nova-3-streaming` provider row to stream to.** The adapter
   exists (`lib/stt-providers/src/registry.ts`), but the id appears nowhere in
   `defaultProviders` and the dev database holds four `deepgram%` rows -- nova, nova-2,
   nova-3, flux-general-en -- none of them the streaming one. So the step as written
   ("stream ONE cached call to `deepgram-nova-3-streaming` ... only if both are green,
   create/enable the rows") cannot start: the row it streams to is created by its own
   last sentence. The Flux row does exist (disabled, `manually_disabled`), so only half
   the step has this problem. Fix when the step runs: create BOTH rows disabled first,
   stream to them while disabled, and let "enable" stay the thing that waits on the
   numbers. Creating a disabled row spends nothing.

   **Corrected 2026-09-09 (R-12), and this fix was wrong.** The row half was right and
   is now done: `deepgram-nova-3-streaming` is seeded `manuallyDisabled`, free. The
   *ordering* half does not work. `syncProviderReadiness()` derives `status: "disabled"`
   from `manuallyDisabled`, and `POST /benchmark/runs` pushes "provider credentials and
   models must be configured" onto its `blockers` list for any provider whose status is
   not `ready` — so **a disabled row cannot be streamed to at all** (true only of that
   one route when this was written; see R-13, which made it true of every path), and
   "stream to them while disabled" describes a run that is created blocked and never
   executes. Enabling
   has to happen BEFORE the first live call, which means the protection in this step's
   **Must not** cannot be "don't enable". It is: enable, stream exactly one call, read
   the numbers, and the thing that waits on Abhishek is whether the row **stays** enabled
   and whether it joins any bulk template. Both rows go back to `manuallyDisabled` if the
   call is not green, and the seed guard (`default-providers.test.ts`) fails the suite if
   either is ever committed enabled.
2. **Confirmed no Deepgram socket has ever been opened**, so the "still unproven" note on
   M-11a/M-11c/M-11e is exactly true rather than merely cautious:
   `select provider_id, count(*) from benchmark_provider_call_results where provider_id
   like '%streaming%' or provider_id like '%flux%'` returns zero rows.

### M-12 — AssemblyAI Universal-Streaming row

**PR:** one.
**Depends on:** M-11d, not M-11. Corrected 2026-09-08: this line used to read
"M-11 (the streaming adapter pattern and the `mode` plumbing are proven)", and the
parenthetical is the dependency -- *proven*, not *written*. M-11a, M-11c and M-11e wrote
two streaming adapters and never opened a socket; the pattern is unit-tested against
reference-derived messages only. Building a third streaming adapter on it before M-11d
runs would copy an unverified pacing, lifecycle and finalize sequence a third time, and a
later failure would be unattributable across three adapters at once. Same correction
applies to M-13 and M-14.
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

**Status:** `blocked` — parked 2026-09-08 (PRD v7, "Deliberately not doing"): production
is Deepgram on 154 of 176 calls, no Deepgram socket has been opened yet (M-11d), and a
third streaming adapter before the first is proven copies an unverified pattern once
more (O-62). Built when a client names ElevenLabs; until then it waits on Abhishek
saying so, and on M-11d.

**PR:** one.
**Depends on:** M-11d (see the correction under M-12: the streaming pattern is written,
not proven).
**Files:** new file lib/stt-providers/src/adapters/elevenlabs-streaming.ts (plain),
`lib/stt-providers/src/registry.ts`, `lib/stt-providers/src/adapters/parsers.test.ts`,
`docs/provider-data-samples.md`.
**Change:** Scribe v2 Realtime WebSocket; row `elevenlabs-scribe-v2-realtime`, $0.39/hr
(ElevenLabs API pricing, read 2026-09-04); otherwise as M-11.
**Acceptance / Verify / Must not:** as M-11, one call.

---

### M-14 — Gladia live row

**Status:** `blocked` — parked 2026-09-08, same reason and same condition as M-13.

**PR:** one.
**Depends on:** M-11d (see the correction under M-12: the streaming pattern is written,
not proven).
**Files:** new file lib/stt-providers/src/adapters/gladia-streaming.ts (plain),
`lib/stt-providers/src/registry.ts`, `lib/stt-providers/src/adapters/parsers.test.ts`,
`docs/provider-data-samples.md`.
**Change:** Gladia live v2 WebSocket (init via `POST /v2/live`, then the socket); row
`gladia-solaria-live`, $0.75/hr self-serve (read 2026-09-04); otherwise as M-11.
**Acceptance / Verify / Must not:** as M-11, one call.

---

### M-15 — Confirmed-entity references from tool calls — grill script first

**Status:** `done` 2026-09-08 (PR #113, `6beffc1`), deployed
`4748e99b3f9d -> 6beffc12538e`. 3 files, +569/-0. `artifacts/api-server` 115 -> 136 tests.

**Answer: no.** 8 usable references, 10 counting matches short enough to be substring
accidents. The bar was 10. Every one of them comes from a single tool,
`fly-APPFOLIO_CREATE_SHOWING` (firstName / lastName), across 5 calls. **The feature D2
describes is not worth building on this corpus**, and D2 now carries the numbers.

**What the counts say**, from `pnpm --filter @workspace/api-server exec tsx
--env-file-if-exists=.env ./src/mine-confirmed-entities.ts` against the dev database and
the 100 saved artifacts:

- 119 tool calls across 75 of the 100 artifacts, 176 calls in the database.
- Results: **41 succeeded, 1 failed, 77 status unknown.** Two thirds of tool calls cannot
  confirm anything, whatever they carry.
- **Every phone number passed to a tool appears in zero customer turns** -- 18 arguments
  across `CREATE_WORK_ORDER`, `FIND_SHOWING`, `FIND_TENANT` and the maintenance tools,
  all from succeeded calls, none of them spoken. The assistant passes the caller's number
  off call metadata, not something it heard. The most obvious candidate never works.
- The largest single argument in the corpus is `destination` (52), the transfer target,
  and no transfer result reports a status at all.

**Shipped as:** `artifacts/api-server/src/lib/confirmed-entities.ts` (the rules, unit
tested) and `artifacts/api-server/src/mine-confirmed-entities.ts` (the runner, which
reads disk and the database and prints counts). The split is not what the Files line
said; it is the same split `lib/production-signals.ts` has from
`backfill-m7a-production-signals.ts`, and it is what lets the rules be proved without a
test reading real caller PII.

**Break test:** 22 mutations, 22 caught, all by tests, tree clean after each. The first
pass ran 18 against the rules and caught 18 -- which was the signal to move the harness,
not to stop.

**Learned:**

1. **The step's own success rule was inverted, and only counting the whole corpus showed
   it.** The block said to "read three real results first and write the rule down".
   77 of the 119 results carry no status at all, so three random reads had roughly a 1 in
   4 chance of never showing the `successful` key the rule depends on -- and the rule
   that would have been written from the other three is the word search that marks every
   honestly-reported result as failed. Sampling three is not the same as counting 119.
2. **A grill script earns its keep by saying no.** One PR, no schema, no provider call,
   nothing spent, and a feature that would have been built on 8 references is not being
   built. The register's own instruction to grill before building is what produced that.
3. **A break test that catches everything means the harness is pointed at the wrong
   file.** 18 of 18 caught against the tested rules; moving the same harness one level up
   found a `console.log(argument.value)` in the runner passing typecheck and all 132
   tests. The corpus is a real caller's phone number and a real caller's words, and
   "must not print argument values" was guarded by nothing but a reviewer noticing.
4. **A PII rule has to be structural or it is not a rule.** Closed the way M-11e closed
   its credential: `tallyToolCall()` returns counts per argument name, so a value cannot
   enter the runner's scope. `.value` appears zero times in the runner now. What could
   not be closed is said plainly rather than papered over -- the runner still holds
   `row.draftTranscript`, because it comes from the row it queries.
5. **The most useful finding was a negative one.** Nothing in the plan predicted that
   phone numbers -- the entity everyone assumes is confirmable -- appear in zero customer
   turns. It was invisible until the counts were per argument name rather than per tool.
6. **Numbers next to the code that produced them survive; numbers copied into a plan
   drift.** `production-signals.ts` had 119 across 75 of 100 in its own header, correct
   since 2026-09-06, while the register still said "74 of 99". The code was right.

**Evidence note:** `visual-and-research` deliberately not run -- a read-only script that
prints counts to a terminal, with no screen, no copy and no label involved.

**Still unproven:** nothing about the numbers themselves; they were read from the live
dev database and the artifacts on disk. What is untested is the runner, on purpose: its
job is to print, its output is read by a person, and the part of it that could be wrong
was moved into the tested file instead.

**PR:** one (the script and its findings; the feature is a later step only if the numbers
justify it).
**Depends on:** M-6 (artifact files exist for the 99).
**Files:** new file artifacts/api-server/src/mine-confirmed-entities.ts (plain: not
written yet, same shape as `artifacts/api-server/src/mine-reading-pairs.ts`),
`docs/PRD-v6-measure.md` (Part D2 gets the numbers).
**Today:** 119 tool calls across 75 of the 100 saved artifacts.
`fly-APPFOLIO_FIND_TENANT`, `CREATE_SHOWING`, `FIND_SHOWING`, `AVAILABILITY`,
`CREATE_WORK_ORDER`, `SEND_SMS`, `dynamic_send_email` carry arguments the customer said
(phone, email, name, date). Whether those values appear verbatim in the customer's turns
— the condition for using them as a reference — is unknown.
**Change:** the script reads every `<callId>.artifact.json`, collects `(tool, argument
name, value)` for string arguments, decides whether the tool result reports success by
the rule grilled below, and checks whether the value (after `normalizeEntity()`) occurs
in the joined `User:` turns of the draft. Prints counts only: candidates, confirmed,
present-in-customer-turns, by tool and argument name. No values printed.
**Acceptance:** WHEN the script runs THEN it SHALL print the counts per tool, separating
succeeded from status-unknown, and the PR SHALL state whether ≥ 10 usable references
exist.

**Grilled 2026-09-08, before building.** Four corrections, all counted on the 100 saved
artifacts rather than recalled:

1. **The corpus numbers were wrong and the right ones were already in the repo.** Not
   "74 of 99": **119 tool calls across 75 of the 100** saved artifacts, which is what
   `artifacts/api-server/src/lib/production-signals.ts` counted on 2026-09-06 and wrote
   into its own header. The register and the code disagreed, and the code was right.
2. **The seven named tools are a minority of the corpus.** They account for 38 of the
   119 calls. The single largest tool is `transfer_call_waterside` (25), and the most
   common argument name of all is `destination` (52) -- a transfer target the assistant
   chose, not a value the customer said. Counting arguments without separating
   customer-said from assistant-chosen would overstate the pool by roughly 3x.
3. **The success rule as written inverts the answer on the only rows that can be
   judged.** Three facts. (a) No result anywhere in the corpus contains "not found".
   (b) There is no status *field* at the level the rule looks at: every parsed result is
   either an MCP content block `{type, text}` (49), a nodemailer object (8), or plain
   text (52+). (c) Unwrapping the `text` block and parsing it again is where the status
   lives -- **a boolean `successful`, alongside `data` and `error`, on 34 of the 119
   rows**. Those 34 rows therefore contain the substring "error" *and* the substring
   "success" in every case, because those are its key names. A substring rule of "text
   without `error`" marks all 34 as failed: the only honestly-reported rows in the
   corpus, scored backwards. The rule is: unwrap, parse, read boolean `successful`;
   the 8 nodemailer results report `accepted`/`rejected` arrays instead; the remaining
   77 carry no status at all and are **unknown, never success**. Absent is not success,
   the same way absent was not zero in M-11c.
4. **"The joined `User:` turns of the draft" is not available for every call.** 175 of
   176 `benchmark_calls` rows have a `draft_transcript` and 175 carry an `AI:` label,
   but only **161 carry a `User:` label** -- 14 drafts are assistant-only. A call whose
   draft has no customer turn cannot confirm or deny a reference, and must be reported
   as its own bucket rather than folded into "not present".
**Verify:** `pnpm --filter @workspace/api-server exec tsx --env-file-if-exists=.env
./src/mine-confirmed-entities.ts`. Corrected 2026-09-08: without the env flag the command
this line used to give exits 1 with "DATABASE_URL must be set" -- `artifacts/api-server`
keeps its own `.env`, and `backfill-m7a-production-signals.ts` already invoked itself the
working way. Ignore the `.env not found. Continuing without it.` line the flag prints:
`pnpm --filter ... exec` runs with cwd set to the package directory, the file IS read, and
dropping the flag still kills the script — checked both ways 2026-09-08 while grilling
M-16.
**Must not:** write to the database; print argument values (PII); decide success by
searching the result for a word (see correction 3); count a status-unknown result as a
success.

---

### M-16 — The selection band counts customer words

**Status:** `done` 2026-09-08 (PR #114, `7f015e1`), deployed
`6beffc12538e -> 7f015e116814`. 15 files, +497/-14. `artifacts/api-server`
136 → 141 tests, `stt-benchmark` 128 → 129, integration 129 → 131.

**Live, against the real API with the default 60–120 s band** — the grill's
predictions and the running server agree to the call:

| floor | matched | named bucket |
| --- | --- | --- |
| none (`minCustomerWords: 0`) | 38 | — |
| **20, applied because nobody asked** | **35** | fewer than 20 customer words 3 |
| 30 (what this step originally specified) | 31 | fewer than 30 customer words 7 |

T-14's invariant holds in all three: `35 + 121 + 17 + 3 = 176`.

**Shipped as:** `artifacts/api-server/src/lib/customer-words.ts` (the count,
unit tested), `minCustomerWords` on the criteria, `withCustomerWordsDefault`
and one bucket in `exclusionBucketFor`, a field in the create dialog, and a
`minCustomerWords` property in `lib/api-spec/openapi.yaml` regenerated
through orval. No migration — the criteria are jsonb.

**Break test:** 18 mutations, 18 caught, all four mutated files restored.

**Learned:**

1. **The first harness pass caught 13 of 18, and every hole was in a file
   with no test.** Three would have shipped: `DEFAULT_MIN_CUSTOMER_WORDS = 0`
   passed the entire suite, preview and create were free to disagree about
   the default, and the page could drop `minCustomerWords` whenever it was 0
   — the one value that means "no floor". That is M-15's lesson arriving on
   schedule: point the harness at the untested caller, not only at the
   tested rule.
2. **Making every test state a new default out loud is what hides the
   default.** Five existing cases had to say `minCustomerWords: 0` because a
   fixture call has no draft — and once they all did, nothing anywhere
   exercised the default. The fix was one case that deliberately says
   nothing about customer words, which is what a person actually does.
3. **A filter that changes no selection can still lie.** Checking the floor
   before the duration band picks the same calls and renames the exclusion.
   64 of the 66 low-word calls are also under 60 s, so that ordering would
   have relabelled nearly all of them and made this filter look like it was
   doing the band's work — the exact misattribution the grill had just
   corrected in this block's own "Today" line.
4. **The seconds band was already doing the job, and saying so is the
   finding.** Only 2 of the 38 in-band calls fall under 12 customer words.
   Shipping this anyway is right — the band is overridable and
   `maxDurationSeconds: null` is legal — but the honest claim is "a guard for
   the widened band", not "a fix for the corpus".
5. **Order of operations is the whole trick and it is invisible.**
   `normalizeTranscript` strips the `AI:` / `User:` labels, so normalising
   first counts both speakers and every call looks talkative. Caught by a
   unit test that asserts the count is under half the whole-transcript count.
6. **`stubApi` recorded which endpoints a page hit but not what it asked
   them for.** On the page that spends money, that is the half that matters:
   a filter dropped on the way out looks identical from the outside. Six
   lines, and two UI holes closed with it.

**Evidence note:** `visual-and-research` run before the field and bucket copy.
Mobbin returned no pattern for "why the result set shrank" — the closest,
[Pinterest's empty state](https://mobbin.com/screens/45560b08-b73e-4f7e-8a82-878c035ddd68)
naming each filter and offering to drop it, is what `describeEmptySelection`
already does; [Uniswap](https://mobbin.com/screens/b6e01a16-7ab6-4f95-928a-52ffd931fe5e)
shows per-option counts beside each filter. Lenny's: **no evidence found** on
defaults changing under existing users. Plan unchanged; the bucket keeps the
house phrasing (`fewer than N customer words`, beside `shorter than Ns`).

**Still unproven:** nothing about the numbers — they were read from the live
dev database and reproduced against the running API. Two limits stated rather
than closed: the scope query still reads `draftTranscript` into memory before
`toCandidate` drops it (it is the column the count comes from), and counting
costs 3.3 ms across the whole 176-call corpus (0.019 ms/row), so ~1.9 s at
100k calls per debounced preview — measured, far away, not optimised.

**PR:** one.
**Depends on:** nothing.
**Files:** `artifacts/api-server/src/lib/bulks.ts` (the band beside
`resolveDurationBand`), `lib/db/src/schema/benchmark-bulks.ts` (criteria type),
`lib/api-spec/openapi.yaml`, `artifacts/stt-benchmark/src/pages/Bulks.tsx` (Advanced
field + the excluded bucket), `artifacts/api-server/src/routes/__integration__/` (the
bulk preview case).
**Today:** the band is seconds (default 60–120 s). A call can be 90 s of assistant
speech and one customer word.
**Change:** `minCustomerWords?: number` on the criteria (default 20, see correction 3),
counted from the draft's `User:` lines (words = whitespace tokens after
`normalizeTranscript()`); the preview excludes under a named bucket "fewer than N
customer words — M". The seconds band stays and still applies.

**Grilled 2026-09-08, before building.** Counted over all 176 `benchmark_calls` with the
real `normalizeTranscript()`, not sampled. Six corrections:

1. **The "Today" line above was wrong and has been cut.** It used to read "Half the
   corpus has ≤ 12 customer words". The real number is 66 of 176 (37%); the median call
   has 23 customer words, p75 is 55, the longest is 284. Not half.
2. **The seconds band already does 97% of this step's job.** Of the 66 calls at or under
   12 customer words, **64 are shorter than 60 s** — every one of them already excluded
   by the existing default band, including all 15 calls with zero customer words (2–34 s,
   drafts present but carrying no `User:` line at all). Inside the default 60–120 s band
   there are 38 calls and only **2** fall under 12 words. The example this step is built
   on — 90 s of assistant speech and one customer word — is exactly one call in 176
   (2 words, in band). The step is still worth building, because the band is overridable
   and `maxDurationSeconds: null` is legal, but it is a guard for the widened-band case,
   not the fix for a corpus-wide problem.
3. **The default of 30 was too high, and this answers PRD v6 E3.** In band, a floor of 30
   cuts 7 of 38 — 18% of an already small pool — and the calls it cuts are 16, 21, 23,
   25 and 29 customer words, real conversations rather than empty ones. Corpus-wide,
   `assistant-forwarded-call` is the largest outcome bucket (**85 of 176**, median **18**
   customer words) and a floor of 30 keeps only 29 of them: E3's worry about
   transfer-heavy assistants is real and now measured. **20** cuts 3 of 38 in band
   (removing 2, 7 and 16), keeps 95 of 176 corpus-wide and 42 of the 85 transfers. The
   default is one constant; E3 can still move it.
4. **A `vertical: trucking` bulk selects zero calls at any floor of 12 or above.**
   8 calls, median 4 customer words, 1 reaches 12, 0 reach 30. The named bucket makes
   that legible instead of mysterious, but the selection will be empty and
   `describeEmptySelection` is what a person will see.
5. **Where the default is applied decides whether saved templates change.**
   `resolveDurationBand` reads `criteria.minDurationSeconds ?? DEFAULT` at resolve time;
   copying that shape here would silently change what every already-saved template
   selects, which is what the Must-not below forbids. M-5 already solved this and wrote
   it down in `lib/db/src/schema/benchmark-bulks.ts`: "Absent -> false ... only a bulk
   created after M-5 gets the new default of true (applied at create time in bulks.ts,
   not read as a default here)." Follow M-5, not `resolveDurationBand`.
6. **The matcher cannot see the transcript, and the order of operations matters.**
   `exclusionBucketFor` takes a `CandidateRow` that has no draft, so the scope query has
   to select `draftTranscript` and the count has to be computed there, keeping the
   matcher pure. And `normalizeTranscript` strips the line-leading `AI:` / `User:` label
   (`lib/scoring/src/index.ts:167`), so normalizing first destroys the labels the count
   depends on: extract the `User:` lines first, then normalize. `customerTurnsOf` in
   `artifacts/api-server/src/lib/confirmed-entities.ts` (M-15) already does exactly that
   extraction — reuse it rather than grow a second copy that can drift.
**Acceptance:** WHEN a bulk is previewed with default criteria THEN every matched call
SHALL have ≥ 20 customer words and the excluded bucket SHALL name the count.
**Verify:** integration case seeds two calls (40 and 5 customer words) and asserts one
matched, one excluded under the bucket; prove by breaking (drop the filter, the
excluded call matches). `pnpm run typecheck`.
**Must not:** change the seconds band, or any saved template's stored criteria, or what a
criteria object saved before this step resolves to (correction 5).

---

### M-17 — A daily import so nothing crosses the 14-day cliff again

**Status:** `blocked` — the script is written; the launchd agent is **not** installed.
**Correction, same day, before this row was pushed:** this line first read "and
deliberately never run". It ran. A break-test mutation deleted the script's `jq` guard
and re-ran the script with `jq` still on `PATH`, so it went straight past the guard and
through to the import: **200 calls were imported into the dev corpus at 2026-09-09T06
UTC**, taking `benchmark_calls` from 176 to 376. All 200 are `ready_to_run` with **zero
provider result rows**, so no ranking, verdict or score moved — but they are eligible for
any future bulk that sweeps ready calls, which would spend real provider money on them.
The audio cache is now 1.9 GB. **Nothing has been deleted: whether these 200 stay is
Abhishek's call (O-91).** The mistake was mine — a mutation that removes a guard must be
run in an environment where the guard was the only thing standing in the way, and this
one was not. Measured live before running
it: the Land And Apartment account produced **257 calls in the last 24 hours, 252 of them
importable**, against a corpus of **176 calls in total**. One night roughly doubles the
corpus; a month is on the order of 7,500 calls and 7,500 cached recordings. That is a
decision about disk, about what the benchmark corpus is for, and about audio retention —
not a side effect of shipping a script. **O-90, and the launchd install is still O-79.**
**Learned:** (1) *the window in this block was impossible.* `/benchmark/vapi/preview`
takes no cursor and caps at 500 per request; the 3-day window this block specifies came
back with exactly 500 — truncated, with no way to ask for the rest. The script uses one
day, and when a day stops fitting it prints `WINDOW TRUNCATED`, names the account and
**exits non-zero**: a nightly job that silently sees part of its window is the cliff it
was written to prevent. (2) *`vertical` cannot be derived from the account* — the
`default` account's 22 calls carry three verticals (trucking 8, rush 8,
property_management 6) — so accounts are listed explicitly with their vertical and a
nightly job can never file a call under a guess. (3) *The step's own Verify line was
written before anyone counted.* "Run the script by hand once" was a reasonable
instruction when the expected volume was a handful of calls a day; at 252 it is a corpus
change, and running it to satisfy a checklist would have been the wrong call.
**Files corrected 2026-09-09:** the runbook section is in
`docs/runbooks/deploy-and-rollback.md`, beside the backup agent's plist and the same kind
of thing, not `docs/runbooks/working-copy-location.md`. The preview endpoint is a **POST**,
not the `GET` this block names.
**PR:** one.
**Depends on:** M-6 (import saves everything worth saving).
**Files:** `scripts/daily-import.sh` (new), launchd plist under
`~/Library/LaunchAgents/` (contents in the runbook, **not installed**),
`docs/runbooks/deploy-and-rollback.md`.
**Today:** import is a button. Vapi deletes audio after 14 days; 6 calls are gone for
good already; the 99-call client corpus was saved by hand five days before its cliff.
**Change:** the script asks `GET /benchmark/vapi/preview` per configured account for
the last 3 days, imports the ids not yet present via `POST /benchmark/vapi/import`
(`x-actor: scheduler`), and stops. Free: Vapi downloads only. A launchd agent runs it at
03:00 (after M-4's backup).
**Acceptance:** WHEN the agent runs THEN new Vapi calls from the last 3 days SHALL exist
in `benchmark_calls` with their four cache files, and the audit log SHALL show
`call:import_vapi` rows with actor `scheduler`. **Met by accident, not by intent** — the
break-test accident above produced 200 imported calls and their `scheduler` audit rows.
It was going to cost roughly this much on the first deliberate run, which is why the run
was being held for Abhishek; the accident spent that cost without asking.
**Verify:** run the script by hand once; `curl -s "localhost:8177/api/benchmark/audit-log?limit=50" | jq '[.[]|select(.actorLabel=="scheduler")]|length'` ≥ 1.
**Verified before the accident, without writing anything:** `bash -n`; the API-down guard
(pointed at a closed port: exits 1, names the API, imports nothing); the script's own
preview call, id filter and chunk arithmetic against the live endpoint — 257 fetched, 252
importable, chunked 200 + 52, truncation check correctly quiet at 257 of 500.
**Verified by the accident, unintentionally:** the import path itself works end to end —
200 calls, their recordings, and `scheduler` audit rows. That is a fact about the script,
not a justification for how it was obtained.
**Must not:** launch a bulk or run any provider; import calls older than the window.

---

### M-18 — The manual place counts: proxy-agreement endpoint and line

**Status:** done 2026-09-08 (PR #117, `9626b72`), deployed `ffe4342a86e8 -> 9626b727282d`.
Live: `labelledCalls 2, n 2, top1Agreement 0.5, kendallTau 0.017`.
**Updated 2026-09-09 — those numbers are final, not a snapshot.** Abhishek answered PRD
v7 C2 *"no by hand thing"*: nobody will transcribe the 20 calls, so `labelledCalls` stays
2 and this line stays below its floor for the life of the project. The step was built
right -- the floor is what stops `tau-b 0.017` being reported as "agreed 50% of the time"
-- but its below-floor wording ("...to measure this **yet**") now describes a wait that
has no end. R-14 fixes the wording only; the floor stands.

**Corrections to M-18 as it was written** (all three found by grilling, before code):

1. **A provider does not have one score per call, so "rank the providers that
   scored it by WER" had no single value to rank.** The cell key is
   `(run_id, call_id, provider_id)`; on the live corpus the same provider scored
   **0.40 and 3.56 WER on the same call** in two different runs. Resolved with the
   convention `run-executor`'s `providerAggregates` already uses -- the mean over a
   provider's cells -- so the ordering compared here is the ordering the Results
   page actually shows, not a second one invented for this endpoint.
2. **The step said render whenever `n > 0`. M-20 sets a floor of 20 on the SAME
   labelled set**, so as written the two steps contradicted each other on one page.
   Adopted M-20's floor rather than inventing a threshold. This is not academic: on
   the live corpus `n = 2` and tau-b is **0.017** -- no relationship at all -- which
   "agreed 50% of the time" would have reported to a CEO as a real finding.
3. **The Files list named `Rankings.tsx`; the line lives in
   `artifacts/stt-benchmark/src/components/verdict-headline.tsx`**, which Rankings
   renders. Exactly the miss M-9's Files list had, and that file's own comment
   already said "PRD-v6 D4 appends the measured agreement figure to this line".

**Change (as shipped):** `lib/scoring/src/rank-agreement.ts` (`kendallTauB`,
`sharesTop1`, pure), `artifacts/api-server/src/lib/proxy-agreement.ts` and
`artifacts/api-server/src/lib/proxy-agreement-aggregate.ts` (split the way T-85's
`call-disagreement` is, so the arithmetic is unit-testable without a database),
`GET /benchmark/proxy-agreement` (all-time, unscoped -- the labelled set is 2 calls
and slicing it per bulk would leave nothing to measure), and one sentence under the
M-9 legend. Only `ok` cells in `batch` runs count: agent-scan runs re-transcribe a
call to judge it and never feed a ranking.

**tau-b, not tau-a.** Ties are the normal case here, not an edge case -- rank 1 was
tied for fewest flags in 59 of 62 assistant groups. tau-a counts every tied pair as
a disagreement and would read low for a reason that has nothing to do with the
ranking being wrong.

**What it taught.** Three things.

*A number that measures nothing must not be reported as a number that measured
zero.* A call is dropped, never counted as agreement, whenever `kendallTauB` answers
null. The tempting fallback -- "do the two best sets overlap" -- is satisfied
trivially by an all-tied side, which would have filled the figure with calls that
distinguished nothing. Same rule the codebase already applies to a null price.

*A redundant guard reads as a second rule.* The break test's one survivor was
`if (wers.length < 2) continue`, and it was not a hole: a call with under two
rankable providers has no pairs, so tau's denominator is already zero. Two lines
expressing one rule. Removed; 17 of 17 after.

*Self-review caught a copy bug the tests could not have.* The sentence read "On the
21 calls a person did check", attaching "a person did check" to `n`. `n` is the
subset that could be **ranked**; a person checked `labelledCalls`. At 24 golded and
21 rankable that credits them with three calls fewer than they did. Both counts are
named now. No test would ever have failed on this -- it was true code and false
English.

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

**Status:** `split` 2026-09-08 into M-19a and M-19b below. Kept as a header so nothing
that cites "M-19" dangles. **Why:** read live through
`GET /benchmark/assistants/{id}/transcriber` on the 14 assistants with the most calls
(124 of 176): every one carries **0 keyterms** and no `numerals` setting. The paired
experiment this step was built for has one subject — the Rush assistant, 8 calls, all
below the selection floors — so `boosts: production` would carry an empty list for the
whole property-management corpus. The Deepgram parameter fix inside it is a real bug
with a unit test and no spend, and does not need to wait: M-19a. The plumbing waits for
a list to carry: M-19b. Everything below this line is the step as it was written.

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
(Deepgram: **500 tokens per request across all keyterms**, an error beyond — truncate and
record `boostsTruncated: true`. **Corrected 2026-09-09:** this read "100 terms / 500
tokens"; the term count is not Deepgram's, so the guard M-19b writes has to count tokens,
not terms).

---

### M-19a — Deepgram nova-3 gets `keyterm`; nova-2 keeps `keywords`

**Status:** done 2026-09-09 (PR #121, `bc9a42b72625`), deployed `31a936b6d72e -> bc9a42b72625`,
live bundle verified: `deepgramBoostParam` present at its definition and both call sites,
`params.append("keywords"` gone.
**PR:** one. Spends nothing.
**Depends on:** nothing.
**Files:** `lib/stt-providers/src/adapters/deepgram.ts` (batch), `lib/stt-providers/src/adapters/deepgram-streaming.ts`
(nova-3 streaming), `lib/stt-providers/src/adapters/parsers.test.ts` (or the adapters'
own test file if one exists by then), `docs/provider-matrix.md` (the boost parameter per
row).
**Today:** both files forward `input.keywordBoosts` as repeated `keywords` parameters —
the nova-2 parameter. Nova-3 uses `keyterm`. `deepgram-flux.ts` already sends `keyterm`.
**Corrected 2026-09-09 (shipping this step):** this paragraph used to end "every boost
ever sent to a nova-3 row has had no effect, silently (backlog, 2026-09-07)". **None was
ever sent.** `artifacts/api-server/src/lib/run-executor.ts` line 800 passes `callId`,
`audioBytes`, `diarize`, `model` and `audioDurationSeconds`; nothing in this repo has ever
set `keywordBoosts` on any adapter. The bug was real and latent — no transcript this tool
has produced was affected by it. The claim is corrected in the backlog entry that made it
too.
**Change:** the URL builder picks the parameter from the model: `keyterm` for `nova-3*`
and Flux, `keywords` for `nova-2*` and older. One helper shared by the batch and
streaming adapters so the two nova-3 rows still differ only in how the audio arrives
(M-11a's rule).
**Acceptance:** WHEN `keywordBoosts` is set THEN a nova-3 request SHALL carry one
`keyterm` per term and no `keywords`; a nova-2 request SHALL carry `keywords` and no
`keyterm`; AND WHEN it is empty THEN neither parameter SHALL appear. **Met**, on the
helper, on the batch adapter's real request URL and on the streaming socket URL.
**Verify:** unit test on the URL builder for the three cases; `pnpm run typecheck:libs`.
**Must not:** ~~send a list longer than 100 terms (truncate and record `boostsTruncated:
true` on the input, as M-19 said)~~ — **withdrawn 2026-09-09, and deliberately not
implemented**: the cap this clause names does not exist. Deepgram documents *"Key Terms
are limited to 500 tokens per request; anything beyond that will return an error"* and
recommends the most important 20–50 terms; no maximum *number* of terms appears anywhere
on the page. A token budget is a different guard from a term count, and it belongs to the
step that actually sends a list (M-19b / v6 F2), not to a parameter rename with no caller.
Touch Flux; make a call. Both held: `deepgram-flux.ts` is untouched, nothing was spent.

> **What shipped.** One exported helper, `deepgramBoostParam(model)` in `deepgram.ts`,
> returning `"keyterm"` for `nova-3*` and `flux*` and `"keywords"` for everything older.
> The batch adapter resolves its model once and asks the helper; `deepgram-streaming.ts`
> imports the same helper rather than keeping a second copy. `docs/provider-matrix.md`
> loses `keywords=term:boost` as *the* Deepgram boost parameter and gains the per-model
> rule, the 500-token cap and the fact that `keyterm` has no weights at all — which also
> answers its own open question 2.
>
> Break test: **13 mutations, all 13 caught, on two consecutive passes**, tree clean after
> every restore. Six on the helper (always-keyterm, always-keywords, inverted branches,
> nova-2 for nova-3, every-nova, Flux dropped), four on the batch adapter (hardcoding
> either spelling, reading `input.model` instead of the resolved fallback, changing the
> fallback itself) and three on the streaming adapter. Tests: 96 in `@workspace/stt-providers`
> (was 89), 161 scoring, 157 api-server, root typecheck clean, four CI guards pass.

**Correction to M-19a as it was written.** The Files list was right on all four entries —
the second step in a row needing no Files correction. Two claims in the prose were not:
the "every boost ever sent" line above, and the 100-term cap in the Must-not. The second
one had spread: **the same wrong number was in six documents** — this block, M-19's own
Must-not, the Part E "Not yet stepped" row, the v6 F2 row, `docs/PRD-v5-optimize.md`,
`docs/PRD-v6-measure.md`, `docs/PRD-v7-decide.md` and the 2026-09-08 backlog entry — all
of them tracing to one reading of one docs page on 2026-09-08. Every one is corrected in
place, each saying what it used to read.

**What it taught.**
1. **A number read once and quoted onward is a number checked once.** Nothing here
   re-derived the 100; it was copied forward eight times in one day because each new
   document was written from the last one. The re-read cost one fetch.
2. **A cap on the wrong unit is not a conservative cap.** Truncating at 100 terms neither
   prevents the 500-token error nor is required by anything — it would silently drop terms
   to satisfy a limit the vendor never set. M-19b now knows to count tokens.
3. **"Silently wrong" and "wrong in production" are different claims.** The parameter was
   wrong; the path was never fed. Saying the strong version in a backlog entry made the
   fix sound like a repair of past results, which it is not.
4. **The break test earns its keep on a helper.** Mutation I — reading `input.model`
   instead of the resolved `model` — is the one a reviewer would not see: it is correct on
   every row the catalog names a model for, and wrong only on the fallback. One test
   asserting the fallback caught it.

**Left for later.** The token-budget guard (M-19b / v6 F2, and F2's question is now "how
many of Rush's 120 terms fit in 500 tokens", not "does term 101 fail"). The import-cycle
guard never looking at `lib/` — logged in the backlog, found while adding this step's
cross-adapter import.

---

### M-19b — A bulk carries the assistant's boosts

**Status:** `blocked` — until Tune mode (PRD v7 Part F, "Not yet stepped" Part E)
has produced a keyterm list for an assistant that has none. Read live 2026-09-08: the 14
largest assistants (124 of 176 calls) carry 0 keyterms, so `boosts: production` would
carry an empty list for the whole property-management corpus today. Also depends on
M-11d for the streaming rows it names.
**Second wall, added 2026-09-09 by R-20:** the corpus cannot supply the list either. Mining
it was tried and measured — the judge's `keyDifferences` yield 79 distinct spans of which 2
recur, entity mismatches yield only digit strings, and the vocabulary the providers actually
split on is ordinary English plus the spelled digits. There is no minable list here, so this
step waits on Tune mode specifically, not on "a list from somewhere".
**PR:** one.
**Depends on:** M-19a, M-11d, M-5, and a list to carry.
**Files, Change, Acceptance, Verify, Must not:** as M-19's block above, minus the Deepgram
parameter fix that M-19a took: `boosts: "production" | "none"` on the bulk (default
`none`), the executor reads the assistant's config once per assistant and passes the
terms per vendor, `boostsSha256` on the manifest, `boostsApplied` / `boostsTruncated` on
the cell. Live run only with a "go spend".

---

### M-20 — The judge gets a scorecard only when it can be measured

**Status:** done 2026-09-09 (PR #124, `cfd7009`), deployed with the batch below.
Live today: 2 labelled calls, **1** measurable pick, so the card reads
"Judge accuracy: not measured (1 of 20)" — the floor doing its job, not a bug.
**Updated 2026-09-09 (same day, later): "not measured" is now permanent.** Abhishek
answered PRD v7 C2 *"no by hand thing"*, so the labelled set never grows and the judge's
pick is never scored. Learned item 1 below -- the single measurable call is a
*disagreement*, the judge picked the higher-error provider -- is therefore the last
evidence this scorecard will ever have. One call proves nothing in either direction; what
it does prove is that "the judge is reliable" cannot be said out loud anywhere in this
tool. R-14 makes the card stop implying the check is on its way.
**Learned:** (1) *the one measurable call is a disagreement.* The judge picked openai
(WER 0.436) when deepgram was lowest (0.365). One call proves nothing, which is exactly
why the floor exists — but it is not the reassuring direction either.
(2) *The candidate set is the whole measurement.* Scoring the judge against every
provider that ever ran the call would mark it wrong for missing a candidate it was never
shown; it is scored against the scored `ok` cells of its own scan run.
(3) *A break test found a real defect, not a weak test.* Deleting the run filter from the
query changed nothing, because `find()` returned whichever duplicate row came back first
and the leak was never looked at. `aggregateJudgeAccuracy` now gives each provider one
value per call, the mean of its cells — the rule `aggregateProxyAgreement` already
followed for exactly this reason. Two other mutations exposed weak seeds: run-scoping
needed a provider that never ran in the scan's run at all, and "latest picking scan"
needed two picking scans at different times, because with one, newest and oldest are the
same row.
(4) *A third `scored.length < 2` guard was dead* — one element is uniformly equal to its
own minimum, so the all-tied guard already dropped it. Deleted with the reason written
down. That is twice in one day a break test found dead code rather than a bug.
**PR:** one.
**Depends on:** M-18 (the labelled set and its query).
**Files:** `artifacts/api-server/src/lib/proxy-agreement.ts` (created by M-18),
`artifacts/api-server/src/lib/proxy-agreement-aggregate.ts` and its test (the arithmetic,
where M-18 put its own), `lib/api-spec/openapi.yaml`,
`artifacts/stt-benchmark/src/components/verdict-headline.tsx`,
`artifacts/stt-benchmark/src/pages/__render__/results.test.tsx`,
`artifacts/api-server/src/routes/__integration__/proxy-agreement.int.test.ts`.
**Files corrected 2026-09-09 (shipping this step):** this line named
`artifacts/stt-benchmark/src/pages/Rankings.tsx` for "the judge-confidence lines on the
assistant card". M-18's line does not live there — it is `ProxyAgreementLine` inside
`BulkVerdictBanner` in `verdict-headline.tsx`, which Rankings only renders. Putting M-20's
line in Rankings would have separated the two lines this block requires to appear and
disappear together, which is exactly what the shared floor is for.
**Today:** the judge's pick is shown as a verdict input; its accuracy has never been
measured (the judge-accuracy report was removed in batch 4).
**Change:** for each labelled call (as M-18), the judge's pick either is or is not the
lowest-WER provider. The floor of 20 is now shared: M-18 shipped reading it too, and
the two lines sit on the same page, so they must appear and disappear together. Report `n`, `agree`, and render "judge accuracy: X % of N" when
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

## Part R — One verdict the corpus can carry (`docs/PRD-v7-decide.md`)

Written 2026-09-08 from a research pass over the live system (PRD v7 §0 has the
numbers, §2 the three findings). Order agreed the same day: R-1 → R-3 → R-4 → M-11d →
M-17 → R-6 → R-7 → M-20 → M-19a → R-5 → M-12 → R-2 → M-19b / M-21. Every step here
spends nothing unless its **Must not** or its **Blocked on Abhishek** line says otherwise.

### R-1 — The verdict's denominator belongs to the call, not the provider

**Status:** done 2026-09-08 (PR #118, `0acac898d5e4`), deployed `7509f25b018d ->
0acac898d5e4`. Live on bulk `42769f26`, the acceptance case exactly: decision
`too_close`, `winnerProviderId` null, all five providers on the same 998-word
basis, AssemblyAI and ElevenLabs both 4 flags -> 0.401 per 100 words, noise floor
`difference 0, ci95 [0, 0]`. The sentence now reads *"Too close to call:
AssemblyAI (0.4) and ElevenLabs (0.4) are inside the margin of error... Effectively
tied. More calls won't separate them."* It used to name ElevenLabs the winner.

**Correction to R-1 as it was written: the Files list was two thirds of the
surfaces.** `artifacts/api-server/src/lib/trend.ts` computes the same rate on the
same basis -- its own header says "on exactly the T-19 basis the rankings use" --
and was found by grilling before any code was written. Fixing two of three would
have left the cross-bulk trend strip drawing a different line from the rankings it
tracks, which is the defect R-2 exists to remove. It went in this PR, with its own
integration case. Also corrected in place: the `peer_flags_per_100_words` comment
in `lib/db/src/schema/benchmark-rankings.ts` and the two OpenAPI descriptions
(`peerFlagsPer100Words`, `HeadlineVerdict`), which described the old denominator;
`pnpm --filter @workspace/api-spec run codegen` re-ran for the generated clients.

**What it taught.** Three things.

*A correct statistic on the wrong quantity is worse than no statistic.* The paired
bootstrap was right to call the ElevenLabs gap "outside noise" -- ElevenLabs really
is consistently wordier, call after call -- so the machinery built to refuse weak
claims certified a bias instead. Nothing in the verdict pipeline could have caught
it; only reading the two providers' per-call flags side by side did.

*When the numerator and the denominator come from different normalisers, say so out
loud.* Flags are counted on `canonicalTranscript` (fillers folded out); the
denominator was `normalizeTranscript` (fillers kept in). Both forms are deliberate
and documented (T-101), and the mismatch between them still went unnoticed for the
life of the metric. `docs/scoring-policy.md` now carries the rule in the section
where the two forms are introduced, not in a comment on one file.

*Grill the Files list, not just the change.* Two of this step's four verify commands
were written against files the step named; the third surface had no line in the
step at all. The rate was greppable in one pass (`Per100Words`), which is how it
turned up.

**Left for later:** ranking rows written before today keep the old basis --
`computeRankingsForBulk` is a free, idempotent rewrite from stored cells and could
be run for the three finished bulks on Abhishek's word (O-36, no spend). Until then
a historical bulk's Results column can disagree with its trend-strip point. R-2
(which single quantity both surfaces rank on) is untouched and still blocked.

**PR:** one.
**Depends on:** nothing.
**Files:** `artifacts/api-server/src/lib/verdict.ts` (the `words` per cell, built near the
`verdictCells` map), `artifacts/api-server/src/lib/run-executor.ts` (the T-19
`peerFlagsPer100Words` block, "Word basis = this provider's own normalised transcript"),
`lib/scoring/src/verdict.test.ts`, `artifacts/api-server/src/routes/__integration__/verdicts.int.test.ts`,
`docs/scoring-policy.md` (one paragraph naming the denominator).
**Today:** every cell's `words` is that provider's own `normalizeTranscript` word count,
while its peer flags were computed on `canonicalTranscript`, which folds fillers out. On
bulk `42769f26` (the only customer-channel bulk) ElevenLabs and AssemblyAI carry
identical peer flags on all 17 calls — 4 flagged each — and ElevenLabs is named winner by
4.2 % because it wrote 1,047 words to AssemblyAI's 1,003, 61 filler tokens to 37. The
tool's own WER rule (`docs/PRD.md` FR-S1) divides by the *reference* length for exactly
this reason; the flag rate did not.
**Change:** one number per call: the **median `normalizeTranscript` word count over that
call's `ok` cells in the scope being ranked** (the bulk's runs for a bulk verdict, the run
for an ad-hoc run). Every cell of the call carries that number as its `words`, in both
files. `lib/scoring/src/verdict.ts` does not change: `pooledRate`, the paired bootstrap
and the sentence already take `{ flags, words }` per cell. Considered and not chosen: the
alignment's `positionCount` from `computeCrossProviderDisagreement` — more principled,
but it needs a new score column and a backfill, and the median cannot be moved by one
verbose provider either.
**Acceptance:** WHEN two providers carry identical peer flags on every call they share
and one is 10 % wordier THEN the headline verdict SHALL be `too_close` (or a tie in the
rates), never `winner`; AND WHEN the live verdict for bulk `42769f26` is read after deploy
THEN it SHALL no longer name ElevenLabs over AssemblyAI.
**Verify:** a unit case in `lib/scoring/src/verdict.test.ts` with exactly that shape (two
providers, same flags per call, one wordier — under the old inputs it must produce a
winner, under the new ones it must not; both halves in the test); an integration case
seeding two providers that differ only in word count; then
`curl -s localhost:8177/api/benchmark/bulks/42769f26-4d4a-4be0-bf04-c7b69f6b4b8f/verdicts | jq '.groups[0].verdict | {decision, winnerProviderId, rates: [.rates[] | {providerId, totalFlags, totalWords}]}'`
— the verdict is computed on read, so it changes on deploy with no recompute. The stored
`peer_flags_per_100_words` column on `benchmark_rankings` follows on the next bulk (no
recompute route exists — O-36); say so in the PR.
**Must not:** change what a flag is or where it is computed; touch the bootstrap; add a
column; change the composite weights.

---

### R-2 — One quantity ranks both surfaces

**Status:** `blocked` — on Abhishek's answer to PRD v7 open question 1 (flagged-call rate,
recommended, or flags per 100 words on R-1's shared denominator). The step below is
written for the recommended answer; if he picks the other, the Change paragraph swaps
`1 − cleanCallRate` for the R-1 rate and the rest stands.
**PR:** one.
**Depends on:** R-1.
**Files:** `lib/scoring/src/hybrid.ts` (`hybridCompositeScore`'s flag component),
`artifacts/api-server/src/lib/run-executor.ts` (`providerAggregates`, the composite input
and the `recommendation` sentence), `lib/scoring/src/verdict.ts` (the rate the sentence
names), `artifacts/api-server/src/lib/proxy-agreement-aggregate.ts` (M-18's ordering —
it must read the same quantity or it certifies a ranking nobody sees), `lib/scoring/src/hybrid.test.ts`,
`artifacts/api-server/src/lib/proxy-agreement-aggregate.test.ts`,
`artifacts/api-server/src/routes/__integration__/rankings.int.test.ts`.
**Today:** the assistant cards rank on `flagBadness` (per-cell `peerFlagCount +
severityRank`, averaged) with 15 % cost, and on the customer bulk every provider ties so
price decides — Cartesia rank 1 in 12 of 13 groups. The org banner ranks on flags per
100 own words — ElevenLabs. Same 17 calls, same page, two winners, neither for accuracy.
**Change:** the flag component of the composite and the banner's rate become the same
quantity: **flagged-call rate** = calls on which the provider carried at least one peer
flag ÷ calls scored (`1 − cleanCallRate`, already computed by T-19). `flagBadness` becomes
the first tiebreak, cost the last. The banner sentence names it in words a reader can
repeat ("flagged on 4 of 17 calls"); the paired bootstrap runs on per-call 0/1
differences over shared calls, same code path. M-18's proxy agreement ranks by the same
per-call quantity (mean over the provider's cells of `peerFlagCount > 0 ? 1 : 0`, then
`flagBadness` as tiebreak) so the human-checked comparison is against the order shown.
**Acceptance:** WHEN bulk `42769f26` is rendered THEN the banner's order and every card's
order SHALL agree on rank 1 for the org group; AND WHEN two providers have the same
flagged-call rate THEN `flagBadness` SHALL order them before cost does.
**Verify:** unit cases on the composite (rate first, badness second, cost third — three
providers built so each rule decides one pair); the proxy-agreement aggregate tests
updated to the new quantity with the discriminating cases kept; the rankings integration
case asserts card and banner agree.
**Must not:** change the 85 / 15 weights; drop `flagBadness` (severity still carries
information); leave M-18 on the old quantity.

---

### R-3 — Production against the pack is the headline sentence

**Status:** done 2026-09-09 (PR #119, `8e71fa957af7`), deployed `5493df7ced85 ->
8e71fa957af7`. Live on bulk `42769f26`, the acceptance case exactly. The artefact's first
paragraph, and the first paragraph of its org section, now read: *"Production today
(deepgram / flux-general-en) disagreed with the candidates on 6.6 of every 100 caller
words the transcripts could be lined up on, over 17 of 17 calls. The closest candidate on
those same words, AssemblyAI, sat at 2.6."* The roll-up verdict follows it, demoted from
`class="summary"` to `class="sentence"`. Both mono bulks render no lead block at all and
are byte-for-byte what they were.

**PR:** one.
**Depends on:** nothing (R-1 first is better, not required — this line does not use the
rate).
**Files:** `artifacts/stt-benchmark/src/components/verdict-headline.tsx` (the banner and
`ProductionDisagreementLine`), `artifacts/api-server/src/lib/verdict-artefact.ts` (the
exported HTML, same order), `artifacts/stt-benchmark/src/pages/__render__/results.test.tsx`,
`artifacts/api-server/src/lib/verdict-artefact.test.ts`,
`artifacts/api-server/src/routes/__integration__/riskiest-endpoints.int.test.ts` (asserts
the artefact copy end-to-end and must change with it, not after it).
**Today:** M-8a computes `productionDisagreement` per org group and it reads a real
number on the customer bulk — Flux, live on the same 17 calls, `rate` 0.0657; the best
candidate (AssemblyAI) 0.0261. It renders as a secondary line under the least-disagreement
sentence, and the verdict's `vsProductionPct` is null because production has no cells.
**Change:** when `productionDisagreement` is non-null, the first sentence of the banner
and of the artefact is production against the pack, in these units: *"Production
(Deepgram Flux) disagreed with the other transcripts on 6.6 of every 100 words on these
17 calls; the best candidate on the same recordings, AssemblyAI, 2.6."* The
least-disagreement sentence follows it. One caveat stays attached, every render:
production was a live stream during the call, the candidates ran on the recording
afterwards. When the figure is null, nothing moves. Run visual-and-research for the copy
first and put the evidence note in this block.
**Acceptance:** WHEN a bulk carries `productionDisagreement` THEN the banner's first
sentence and the artefact's first paragraph SHALL name the production model, its rate and
the best candidate's rate, with the caveat; WHEN it is null THEN both SHALL be byte-for-byte
what they are today.
**Verify:** render tests for both branches; the artefact test; the riskiest-endpoints
integration case updated in the same PR; then the live artefact for `42769f26` read with
`curl -s localhost:8177/api/benchmark/bulks/42769f26-4d4a-4be0-bf04-c7b69f6b4b8f/verdict.html | head -c 1200`.
**Must not:** rank production; count it as a candidate; name it a winner or a loser;
drop the stream-versus-recording caveat.

## Evidence — production-first headline (visual-and-research, 2026-09-09)
**Pattern to use:** put both numbers in the lead, each tagged with whose it is, and state
the direction in words above any chart or table — ← [Hootsuite industry
benchmarking](https://mobbin.com/screens/be5d08de-8b50-4130-9a0b-d41ac166b52b), whose
cards read "48K people ▪INDUSTRY ●YOU" with the sentence *"There's room to grow. You've
reached 48K fewer people than your industry average."* above the series.
**Patterns to avoid:** ranking the incumbent in the same table as the alternatives — ←
[Peec AI rankings](https://mobbin.com/screens/e80877c2-6453-42be-b111-b761af9753b5) lists
the owner's own brand among competitors, which is exactly what production must never be
here. Also [Wix Benchmarks](https://mobbin.com/screens/a9b40b72-ce38-4469-af55-985fd0f97167),
kept for the opposite reason: with too little data it says *"Not enough data yet"* rather
than showing zeros — the null branch this step already had.
**What operators say:** the status quo is a competitor and has to be named as one —
*"Don't forget the status quo: in B2B, vendors typically lose about half their sales
opportunities to whatever the prospect is currently using... we need to understand the
strengths and weaknesses of the status quo solution"* — "A guide to advanced B2B
positioning" (Lenny's Newsletter, 2026-03-10)
https://www.lennysnewsletter.com/p/a-guide-to-advanced-b2b-positioning
**Changes to the plan:** both numbers stay in one sentence rather than the number-plus-
delta card Hootsuite uses (there is one metric here, not a dashboard of them); production
keeps its own line and never enters the table.
**No evidence found for:** how products label two same-unit metrics that are not the same
measurement. Two Lenny's searches returned only generic "vanity metrics" material. The
caveat's wording is this repo's own.

**Correction to R-3 as it was written: the Files list named the wrong test and missed a
surface.** (1) `artifacts/api-server/src/routes/__integration__/riskiest-endpoints.int.test.ts`
seeds a bulk with **no scored calls**, so it proves the null path and can never see a
production figure; the end-to-end assertion went where the production fixture already
lives, `artifacts/api-server/src/routes/__integration__/verdicts.int.test.ts`.
(2) The Overview says this sentence too — `summarizeBulkVerdicts` in
`artifacts/stt-benchmark/src/components/verdict-headline.tsx` exists, by its own comment,
"so the Overview can say the same sentence flat on the page", and
`artifacts/stt-benchmark/src/pages/Dashboard.tsx` renders it. Changing the banner and not
that comment would have made the comment false. (3) `artifacts/stt-benchmark/src/pages/Rankings.tsx`
holds the order of the org box, so the swap lives there, not in the component.

**Correction to a claim R-3 proved wrong:** M-8b's block above said the production line
named both numbers "on the ranking table's own per-100-words scale". It never did. The
claim is struck in M-8b, where it was made.

**What it taught.**
1. *Two numbers that share a unit are read as the same measurement, whatever the code
   knows.* Production's 2.6 and the table's 0.40 had co-existed since M-8b without anyone
   noticing, because 2.6 was the third line on the page. Making it the first line is what
   forced the question. Prominence is not cosmetic — it decides which contradictions get
   found.
2. *A doc comment that claims parity between two surfaces is a dependency.* "so the
   Overview can say the same sentence" turned a two-file step into a three-surface one,
   and the compiler could not have told me.
3. *A test that waits for the wrong thing passes for the wrong reason.* The Overview's
   multi-org guard asserted "no lead block" while the verdict query was still in flight;
   it survived its mutation on the first break-test pass. Assertions about an absence must
   wait for something whose presence proves the data arrived.
4. Fourth grill in a row where reading the Files list against the code found a surface the
   step had not named — cf. R-1, M-18, M-8b (F-100, F-232).

**Left for later.** The caveat renders twice on the artefact (once at document level, once
in the org section) because the lead itself does; that matches how the verdict already
repeats there. The Overview stays quiet on a bulk with two orgs carrying figures — the
per-org lines are on Results; if a bulk ever holds two orgs, decide then whether the
Overview should name the largest rather than none (no register row yet, nothing on the
corpus needs it).

---

### R-4 — The assistant card stops claiming a decision

**Status:** done 2026-09-09 (PR #120, `cee7a5af6aff`), deployed `67187d6a1d1f -> cee7a5af6aff`.
**Live acceptance is NOT yet met, and knowingly so** — see "The one thing R-4 could not
finish" below.
**PR:** one.
**Depends on:** nothing.
**Files:** `artifacts/api-server/src/lib/run-executor.ts` (`confidenceNoteFor` and the
`recommendation` sentence in the ranking aggregation), `artifacts/api-server/src/lib/ranking-recommendation.ts`
and `artifacts/api-server/src/lib/ranking-recommendation.test.ts`,
`artifacts/stt-benchmark/src/pages/Rankings.tsx` (the card), `artifacts/stt-benchmark/src/pages/__render__/results.test.tsx`,
`artifacts/api-server/src/routes/__integration__/rankings.int.test.ts`.
**Today:** 31 assistants over 176 calls; 0 of 29 all-time assistant groups reach the
≥ 12 bar, so every card reads "Leading candidate for this assistant's calls … Confidence:
low … Do not treat as decision-grade." — a recommendation and its retraction in one
sentence, 29 times. The org verdict already carries the evidence rules
(`PROVISIONAL_EVIDENCE_CALLS = 20`, `MIN_SHARED_CALLS_FOR_VERDICT = 5`).
**Change:** the card's sentence becomes description, not decision: *"On this assistant's
N calls: fewest flags <provider>, cheapest <provider>. The decision for <org> is made
above, on <M> calls."* The words "Leading candidate" and "decision-grade" leave the card.
The evidence-count sentence lives once, on the org verdict. The grouping key of
`benchmark_rankings`, the columns, and the CSV do not change. Run visual-and-research for
the copy first and put the evidence note in this block.
**Acceptance:** WHEN any assistant group is rendered THEN its card SHALL NOT contain
"Leading candidate" and SHALL name the org verdict as where the decision is; AND the org
banner SHALL carry the evidence count exactly once.
**Verify:** render test; the recommendation unit tests; a grep of the UI package and the
artefact for "Leading candidate" finds only test names and comments.
**Must not:** remove the cards; hide any column; change what `benchmark_rankings`
groups by.

**What shipped.** The card reads, on a group of 7:

> **What the calls showed:** On this assistant's 7 calls: fewest disagreements Deepgram,
> cheapest Cartesia.
> *The decision for Land And Apartment is made above, on 17 calls. One assistant alone
> has too few calls to decide.*

Verified live before building (2026-09-09): 31 assistants over 176 calls, **0 of 29
assistant groups at the >=12 bar**, largest group 9 scored calls. The block's "Today"
paragraph was accurate in every number.

**Correction to R-4 as it was written: the Change is one sentence, and it takes two
places to write.** The block reads as though `run-executor` composes the whole thing.
It cannot: the aggregation knows the group's scored-call count, who was cleanest and who
was cheapest, but it does not know the org or its verdict's `evidenceCalls`. Those exist
only on the page. So the stored half is descriptive
(`rank1Recommendation(recommendationInputs, scopePhrase)`) and the pointer half is
rendered in `Rankings.tsx` from the verdict already above the card. Two further things
the block did not account for:

1. **All-time combined has no verdict box at all** — it is gated on `viewMode === "bulk"`
   (`Rankings.tsx`). "The decision is made above" would have pointed at nothing in that
   view, on every card. The pointer branches: in All-time it says where a decision is
   found instead.
2. **The render test could not see the card.** `results.test.tsx`'s fixture carried
   `recommendation: ""`, so the whole block was unrendered and no assertion in that file
   could ever have touched it. Same class of gap as R-3's. Fixed by giving the rank-1
   rows the real stored sentence.

The Files list itself was **right on all five entries** — the first step in this run
whose Files list needed no correction.

**The one thing R-4 could not finish.** The card renders the *stored* `recommendation`
column. Every bulk already scored keeps the old sentence until its rankings are
recomputed, so on the live page today all 29 rank-1 rows still read "Leading candidate
... Do not treat as decision-grade" (checked through `GET /benchmark/rankings` after
deploy: 29 of 29). The acceptance is met by the code and by every new computation; it is
not yet met by what is on screen. The fix is **O-84** — run `computeRankingsForBulk` for
the finished bulks — which is free, idempotent, spends no provider or LLM money, and has
been waiting on Abhishek's word since before this step. R-4 did not do it unasked.

**What it taught.**

1. **A sentence that names a leader and then retracts it is not caution, it is two
   sentences.** The confidence note was added in good faith (threshold review
   2026-08-25) and was individually correct every single time it fired. It became noise
   the moment it fired on 100% of rows, because a caveat that never varies carries no
   information — it just teaches the reader to stop at the comma.
2. **Ask which process can know the fact before deciding where the sentence lives.** The
   split here was not a design preference; the aggregation physically cannot see the org.
   R-3's lesson was one sentence, one home. R-4's refinement: one sentence, one home *per
   fact it asserts*.
3. **A view that hides a surface breaks copy that points at it.** All-time combined drops
   the verdict box, and nothing in the step's text hinted at that. Any copy containing
   the word "above" needs a check that "above" exists in every view.
4. **Copy stored in a column is deployed twice** — once as code, once as data. The
   second deploy is a recompute, and it is not free of a decision even when it is free of
   money.

**Left for later.** The redundant "N calls scored" (bulk banner vs org box) is in
`docs/backlog/good-to-have.md`, 2026-09-09 — equal on every bulk so far because every
bulk has held one org, and a naming decision rather than a bug.

## Evidence — the card that describes instead of deciding (visual-and-research, 2026-09-09)

**Pattern to use:** when the evidence is short, state the plain fact instead of ranking
and then retracting — Circle's leaderboard shows **"Not enough activity"** as the whole
panel rather than a ranked list carrying a disclaimer, and Braintrust (an eval tool)
writes **"This row has not been run yet"** with no score and no hedge.
← [Circle leaderboard](https://mobbin.com/screens/85e85326-8911-42ee-8934-44b7c95bc653),
[Braintrust dataset row](https://mobbin.com/screens/1d289ea4-016c-4144-b577-1607a283a747)

**Patterns to avoid:** a per-segment card that reports numbers and a verdict in the same
breath. Apollo's data health center keeps each tile to counts and shares, with the
interpretation left to the reader.
← [Apollo data health center](https://mobbin.com/screens/b36c564d-0708-41cb-abdb-46e68975f8cf)

**What operators say:** "Many teams build eval dashboards that look useful but are
ultimately ignored and don't lead to better products, because the metrics these evals
report are disconnected from real user problems." A dashboard sentence that says two
things at once is exactly the kind that gets skipped.
← "Building eval systems that improve your AI product" (Hamel Husain & Shreya Shankar,
2025-09-09) https://www.lennysnewsletter.com/p/building-eval-systems-that-improve-your-ai-product

**Changes to the plan:** the card states its evidence size in its own opening clause
("On this assistant's 7 calls") instead of appending a confidence caveat, which is the
Circle/Braintrust shape — the fact, not the fact plus a warning about the fact.

**No evidence found for:** a product that shows a per-segment card explicitly deferring
its decision to a higher-level summary on the same page. Searched Mobbin twice (web) for
breakdown cards that point at an overall result. The pointer sentence is ours.

---

### R-5 — The judge reads the assistant's own prompt and vocabulary

**PR:** one. **This step spends cents** (the judge-contract record and one judged bulk).
**Depends on:** nothing.
**Blocked on Abhishek:** the go-spend (PRD v7 open question 4).
**Files:** `artifacts/api-server/src/lib/vapi.ts` (`fetchVapiAssistantTranscriber` — read
two more fields off the same GET), `artifacts/api-server/src/lib/assistant-transcriber.ts`
(the in-memory cache carries them), `artifacts/api-server/src/lib/agent-verify.ts` (pass
the context per call), `artifacts/api-server/src/lib/agent.ts` (`judgeCandidates`
signature), `artifacts/api-server/baml_src/judge.baml` (the inputs; drop the hardcoded
domain sentence), `artifacts/api-server/src/lib/judge-contract.ts` (prompt hash —
`pnpm run judge:contract:record`), `artifacts/api-server/src/lib/judge-contract.test.ts`,
`docs/provider-data-samples.md` (field names of the assistant object).
**Today:** the judge receives `originalTranscript`, `flaggedSpans`, `candidates`, and a
system prompt that says every call is "truck-parts service desks, apartment leasing,
trucking dispatch". The assistant object is fetched (T-97) and only `transcriber` is
typed; the system prompt (`model.messages`, role `system`) and the `keyterm` list are on
the same response, unread. Read 2026-09-08: the 14 largest assistants carry 0 keyterms,
so today the vocabulary half is empty and the prompt half is the whole gain.
**Change:** read one real assistant object first and record the **field names** (never
the prompt text) in `docs/provider-data-samples.md`; then `fetchVapiAssistantTranscriber`
also returns `systemPrompt: string | null` and `keyterms: string[]`. `judgeCandidates`
takes an `assistant` context — name, system prompt, keyterms — and `judge.baml` renders
it in the user turn ahead of the transcript; rule 5 becomes "judge from this assistant's
own context". Cache in memory as T-97 does. Record judge prompt tokens per call on one
bulk before and after.
**Acceptance:** WHEN a call is judged THEN the prompt SHALL contain that assistant's
system prompt and keyterms and SHALL NOT contain the retired domain sentence; AND WHEN the
assistant lookup fails (`no_calls`, `no_account`, a Vapi error) THEN the judge SHALL run
with an empty context and the scan row SHALL say so, never fail.
**Verify:** `judge-contract.test.ts` against the recorded contract; a unit case for the
empty-context path; then one judged bulk with the token delta quoted in the PR — if judge
cost per call more than doubles, stop and report instead of merging.
**Must not:** store the prompt or keyterms in the database; log them (T-36's redaction
flag does not cover a new field); send them to any vendor but the judge; change the
pick from a typed enum; run the contract record or the bulk without the go-spend.

---

### R-6 — Conventions never show as differences in the comparison unless asked

**Status:** done 2026-09-09 (PR #122, `37fd46c7e40d`), deployed `3315a96acbb7 -> 37fd46c7e40d`,
verified live on the running API: across 40 calls, 94 provider cells carry at least one
marked op and **312 of 2,600 differing ops (12 %) are conventions** — mostly fillers
(`uh`, `um`), plus real pairs like `because` / `'cause` and `the` / `the-`.
**Learned:** (1) *the rule the step was written on was wrong, and the corpus said so.*
Marking op-by-op — as this block, PRD v7 D2 and the v7 research note all specified —
marks **nothing** on the two commonest pairs in the T-101 mining, because `1 bedroom`
against `1-bedroom` is two words against one and aligns as a `sub` **plus** a `del`. The
rule has to be per **run** of consecutive differing ops. The wording is corrected in this
block and in PRD v7 D2, each saying what it used to read. (2) *A conservative rule beats
a clever one:* a run holding one real error is not marked at all, so an error can never
hide behind a convention beside it — the failure mode is showing too much, never hiding a
mistake. (3) *The mark had to stay out of the arithmetic.* `wordsDiffer`,
`werVsReference`, `editCounts` and every stored score row still count these ops, and the
wire test asserts it — a mark that silently moved WER would have been a scoring change
smuggled in as a UI change. (4) *`lib/scoring` has always had an import cycle*
(`index.ts` re-exports `./equivalence`, `equivalence.ts` imports `./index`) and the
cycle guard has never looked at `lib/` — logged 2026-09-09 in the backlog, alongside the
one adjacent problem this step deliberately did not fix: the Rows view's `Differ / ref`
column still prints the wire's `wordsDiffer`, so that table and the row under it now
count differences two ways. That is R-2's question, not this step's.
**PR:** one.
**Depends on:** nothing.
**Files:** `lib/scoring/src/index.ts` (`WordDiffOp` gains `convention: boolean`),
`artifacts/api-server/src/lib/call-comparison.ts` (`diffAgainstReference` marks it, using
`sameOnceCanonical` from `lib/scoring/src/equivalence.ts`), `lib/api-spec/openapi.yaml`
(the op schema, regenerated through orval), `artifacts/stt-benchmark/src/components/word-diff-view.tsx`
and `artifacts/stt-benchmark/src/components/transcript-side-by-side.tsx` (hide by default,
count, toggle), `artifacts/stt-benchmark/src/components/word-diff-view.test.tsx` (new --
these are pure components with their own test file next to them, which is where this
repo puts a component test; Corpus's page render test never reaches the diff),
`artifacts/api-server/src/routes/__integration__/call-comparison.int.test.ts`,
`docs/scoring-policy.md` (the diff view hides conventions; WER does not).
**Today:** the diff runs on `normalizeTranscript` tokens, so "1-bedroom" / "1 bedroom",
"gonna" / "going to" and a stray "um" render as substitutions, deletions and insertions.
`lib/scoring/src/equivalence.ts` line 23 says this was deliberate: the flags fold
conventions out, the diff shows them. Abhishek, 2026-09-08: he does not want them shown.
**Change:** each **run** of consecutive non-`ok` ops whose reference side and hypothesis
side are equal under `sameOnceCanonical` is marked `convention: true`. *This sentence
read "each non-`ok` op whose `ref` and `hyp` are equal under `sameOnceCanonical` (a
`sub`), or whose lone side folds to nothing" until 2026-09-09; that rule marks nothing on
the two commonest pairs in the T-101 mining. `1 bedroom` against `1-bedroom` is two words
against one, so the alignment writes a `sub` plus a `del`, and neither op alone equals
anything — `sub("1" -> "1-bedroom")` canonicalises to `1` against `1 bedroom`. Same for
`going to` / `gonna`. Joined, the run's two sides are one canonical form. A run that also
holds a real error is not marked at all, so an error can never hide behind a convention
beside it — the rule errs towards showing.* The view renders marked ops as agreement by
default, shows a count and a toggle that renders them exactly as today. `wordsDiffer` and `werVsReference` keep counting them — WER is WER
(`docs/scoring-policy.md`) and a person writing a gold needs the raw diff. Run
visual-and-research first (the pattern is a code review's "hide whitespace changes") and
put the evidence note in this block.
**Acceptance:** WHEN a hypothesis differs from its reference only by conventions THEN the
default view SHALL show zero highlighted words and the hidden count; WHEN the toggle is
on THEN the view SHALL match today's byte for byte; AND `werVsReference` SHALL be
unchanged in both.
**Verify:** a unit case on `diffAgainstReference` with the T-101 pairs ("1 bedroom" /
"1-bedroom", "going to" / "gonna", "" / "um", and "4" / "forty" which must NOT be a
convention); the render test for both toggle states; the comparison integration case
asserts `convention` on the wire.
**Must not:** rewrite a provider's words on screen; change WER; change what raises a
flag; hide a real substitution ("forty" / "4" stays a difference — `equivalence.ts` says
so and the flags agree).

## Evidence — hiding convention differences in a comparison view
**Pattern to use:** put the control in the diff's own header beside the view switch, name
the count it is hiding, and keep the totals visible next to it — GitLab's commit diff
carries "Show whitespace changes" inline with Inline / Side-by-side and states
"Showing 1 changed file with 23 additions and 0 deletions" in the same bar; Devin's review
puts "All 362 lines / 5 lines" next to each collapsed hunk, so the number hidden is always
readable without expanding.  ← [GitLab commit diff](https://mobbin.com/screens/929d4521-5bcf-46c2-a38f-ecd3614ca40a),
[Devin review](https://mobbin.com/screens/e48cb198-fd26-4a92-b17a-a988aa5cbef8)
**Patterns to avoid:** hiding the control in a settings menu with no count on the surface —
GitHub's Files changed header carries a filter box and a gear, and nothing there tells the
reader that anything is being filtered out of the diff at all. Also avoid Linear's
"Highlight changes" switch as the model: it turns *all* marking off, which is a different
thing from separating real differences from conventions.  ← [GitHub Files changed](https://mobbin.com/screens/72783a50-4cc2-4e3d-83f9-048f9a2455cf),
[Linear version history](https://mobbin.com/screens/6c14e085-9ff5-4e61-9a21-b04f1b0a3433)
**What operators say:** no evidence found. Two searches of Lenny's archive
(`diff|comparison|noise|signal|hide|filter|false positives`, then
`evals|error analysis|look at your data|review interface`) returned nothing about diff or
review-surface noise; the eval posts that did match are about which metrics to trust, not
about what a review screen shows. Not stretched into a citation.
**Changes to the plan:** the count moved into the same sentence as the difference count
rather than sitting on its own line ("1 word differ from gold, out of 6. 3 more are the
same words written differently, hidden."), and the toggle names its number —
"Show conventions (3)" / "Hide conventions (3)" — so the reader never has to click to
learn how much is behind it. The side-by-side's per-column header states its own hidden
count beside its visible one, GitLab-style, instead of one figure for the whole grid.
**No evidence found for:** a product that separates *formatting-only* differences from
real ones in prose (rather than code) and says so on screen. The nearest is the whitespace
rule in code review, which is what this step was modelled on.

---

### R-7 — Which calls need checking: count the seeds before building a monitor

**Status:** done 2026-09-09 (PR #123, `ff8a66c`). Nothing deployed by it — a script, a
pure lib nothing on the server imports, and docs. **Answer: do not build the monitor
path, and the table is not the reason.**
**Learned:** (1) *the measurement was impossible before it was wrong.* 112 of the 118
calls carrying a verdict are flagged, so the base rate is 88–96 % and the ceiling on any
signal's lift is 4.3–11.5 points. The seed rule's 10-point margin is unreachable **by
arithmetic** on four of the five signals. A plain "no" would have claimed they were
measured against a fair bar; the script prints a `head` column and the word `UNTESTABLE`
instead. **A negative result has to say which kind of negative it is.**
(2) *So the question underneath is the flag rate, not the trigger* — a pass that flags
95 % of what it sees cannot be triaged, and nothing built on it can be better than it is.
That is **new open question 5** in PRD v7 Part E, for Abhishek: is 95 % what he expects?
(3) *An errored or rejected scan is not a verdict.* Counting the 5 errors and 1 rejection
as "not flagged" understated the base rate by 4.8 points on the first signal alone. Same
rule as a null column: dropped, never defaulted.
(4) *The break test found two of its own mutations were provably no-op code* —
`population > 0` is implied by `selected > 0`, and the seed/untestable branch order cannot
matter because `lift ≤ headroom` always. Both dead guards deleted, and the comment that
claimed "order matters" corrected. A third miss was a real hole in a test: at a 90 %
selected share the arithmetic caps lift at exactly 10 points, so against a 10-point margin
that test never exercised the ceiling it was written to guard.
**PR:** one. Spends nothing: read-only over the dev database, no provider, no LLM.
**Depends on:** nothing.
**Files:** `artifacts/api-server/src/mine-triage-signals.ts` (new; same shape and same
door as `artifacts/api-server/src/mine-confirmed-entities.ts`),
`artifacts/api-server/src/lib/triage-signals.ts` and
`artifacts/api-server/src/lib/triage-signals.test.ts` (new, added while shipping: the
2×2 arithmetic is the half that becomes a PRD decision, so it lives in `lib/` and is
proved against synthetic cells — the same split M-15 made, and the split this block's
own "same shape as mine-confirmed-entities" was pointing at),
`docs/PRD-v7-decide.md` (Part E — the table and the decision go back in).
**Today:** stored per call and read by nothing for this purpose: `source_success_evaluation`
(118 true / 23 false / 35 null — Vapi's LLM verdict on goal completion, not on the
transcript), `prod_assistant_interruptions`, `prod_transcriber_latency_ms`, `prod_tool_calls`,
`source_ended_reason`. 239 flagged and 6 clean scans say which calls the free hybrid pass
flagged; take the latest scan per call. Abhishek's ask (2026-09-08) is a path that checks
only the calls that need it; PRD v7 Part E says its trigger must be an implicit signal,
not an LLM read of one transcript.
**Change:** for each signal (success false; interruptions ≥ 1; transcriber latency above
the corpus median; ended reason not in the customer-ended set; tool calls = 0) print the
2×2 against "latest scan flagged": calls selected, flagged among them, precision and
recall, and the base rate. Counts only — never a transcript, never a name. Write the
table into PRD v7 Part E with the decision: a signal that beats the base rate by a stated
margin is a seed for a monitor path; none does, the path is not built on this corpus,
and the script stays (it is permanent and free — re-run when the corpus grows).
**Acceptance:** WHEN the script runs THEN it SHALL print one 2×2 per signal and the base
rate, and nothing that identifies a caller; AND PRD v7 Part E SHALL carry the table and a
build / don't-build sentence before this step is marked done.
**Verify:** run it; paste the table into the PRD and the PR; `pnpm run typecheck`.
**Must not:** call a provider or an LLM; print transcript text; write to the database;
build the monitor — this step only decides whether to.

---

### R-8 — The stored ranking rows are rewritten when the rule behind them changes

**Status:** done 2026-09-09 (PR #126, `ba27068`). Nothing on the server changed — one
script, and the rows it rewrote. **Abhishek's word, 2026-09-09: "do it" (O-84 / O-86).**
**Learned:** (1) *a step can ship in code and be invisible on the page.* R-4 rewrote the
sentence a ranking row carries; the column is written at rank time and no read path
recomputes it, so for a full day all 29 rank-1 rows still served the retracted "Leading
candidate ... Do not treat as decision-grade" copy R-4 had replaced. **A shipped change
to stored copy is not shipped until the stored rows are rewritten.**
(2) *a bulk-only pass was not enough, and only reading the page back caught it.* After
the first apply, 28 of 29 were correct and one — the "Unassigned (no assistant ID
captured at import)" group — still showed the old sentence. 45 of the 305 stored rows
carry a null `bulkId`, written by `computeRankingsForRun` for the 17 standalone runs from
before bulks existed, and the Results page's "latest per group" pick can surface them.
Both writers are now driven.
(3) *`computeRankingsForRun` deletes by run id, and a bulk's rows carry a representative
run id that belongs to that bulk.* It is called only for runs whose own `bulkId` is null;
calling it for a bulk's representative run would delete that bulk's freshly written rows.
(4) *no break test, deliberately.* The script's only guard is `--apply`, and the mutation
that removes it performs the write the guard exists to prevent — the exact shape of the
M-17 accident. Its arithmetic is not new (18 cases in `ranking-recommendation.test.ts`,
and both compute functions are the production path); what the step adds is the door, and
the door was proved by the live rows.
**Live result:** 145 rows, 29 rank-1, **0** still carrying the old sentence.
`peerFlagsPer100Words` moved on 32 of 145 rows, with tied providers landing on one shared
denominator (Cartesia 1.3514 → 1.2821, Deepgram 0.4255 → 0.4274, now equal) — which is
what R-1 meant. The honest bulk's org verdict changed with it, from naming ElevenLabs a
winner to **"Too close to call: AssemblyAI (0.4) and ElevenLabs (0.4) are inside the
margin of error"** — the false winner the PRD v7 research found, now gone from the page.
**PR:** one. Spends nothing: reads the database, calls no provider and no LLM.
**Depends on:** R-1, R-4.
**Files:** `artifacts/api-server/src/recompute-rankings.ts` (new).
**Must not:** invent new ranking arithmetic; run without `--apply` being typed; touch a
database other than the one it prints on its first line.

---

### R-9 — The Calls table says which calls a run has actually transcribed

**Status:** done 2026-09-09 (PR #127, `d91ca2e`).
**Learned:** (1) *`status` was never going to answer it.* Read live 2026-09-09: 376 calls
in the corpus, **131** ever through a run, and **all 376** carrying `ready_to_run` —
correctly, because an untouched import and a call five providers have transcribed really
are both runnable. The split is a join, not a column, so it needed its own control; a new
value in the Status select would have put a state there that no call holds.
(2) *a failed cell counts as run.* The call went through a run and what came back is that
run's answer. Reading this off scored `ok` cells — or off agent scans, which cover 124 of
the 131 run calls live — puts seven calls that *were* run into the "never run" list,
which is exactly the question the filter exists to answer.
(3) *the break test found one dead guard.* Removing the `callIds.length === 0` early
return changed nothing; checked against the driver, `inArray(col, [])` returns no rows
rather than throwing, so the guard was unreachable-by-behaviour and was deleted with a
comment saying why. 6 of the other 6 mutations were caught, re-run against the committed
file.
**Prompted by:** the 200 calls an accidental break-test run imported on 2026-09-09
(O-91, kept on Abhishek's word) landing at the top of a newest-first table with nothing
to show, hours before a demo. The accident exposed the gap; the daily importer (M-17, 252
calls/day) would have made it permanent.
**PR:** one. Spends nothing.
**Depends on:** nothing.
**Files:** `artifacts/api-server/src/lib/calls.ts`,
`artifacts/api-server/src/routes/benchmark.ts`, `lib/api-spec/openapi.yaml` (+ orval
regen), `artifacts/stt-benchmark/src/pages/Corpus.tsx`,
`artifacts/api-server/src/routes/__integration__/calls-list.int.test.ts`,
`artifacts/stt-benchmark/src/pages/__render__/calls.test.tsx`.
**Evidence (visual-and-research, 2026-09-09):** a derived cut stays separate from the
record's own status field — Mobbin: [Airtable](https://mobbin.com/screens/094fb0f9-a0ce-4c53-abc4-a9a25c2a4644),
[Twenty](https://mobbin.com/screens/c4089aab-6ec1-4507-b53f-19abd7dbf459),
[Rox](https://mobbin.com/screens/6a5d9ce9-a20a-40cc-85cb-d07559009076); and
[Workable](https://mobbin.com/screens/197b7105-f9d9-4c78-a67b-9f5ecc212190) /
[Remote](https://mobbin.com/screens/4cbe7498-0064-49a8-a80c-692431aaaae3) put it above
the table entirely. Counts ride in the option labels so the split reads before the filter
is opened, and are computed over every call, not the filtered rows — a count that moved
with the other filters could not be read as "how many exist".
**Must not:** add the flag to a write response (it is a read-route decoration, absent not
false, like the two cache flags); run one query per row; treat an absent flag as "run".

---

### R-10 — The import-cycle guard checks every package it claims to

**Status:** done 2026-09-09 (PR #128, `a668854`). Prompted by O-88, logged while building
M-19a and left as a "worth having" — it turned out to be a "was hiding six".
**Learned:** (1) *a guard pointed at one place is not a guard, and the default is where the
rot hides.* `scripts/check-import-cycles.mjs` took its root as an argument and defaulted to
`artifacts/api-server/src` — and BOTH callers, `package.json` `check:cycles` and
`.github/workflows/ci.yml`, passed that same root explicitly. Every caller overriding a
default with the default's own value is how a list stops being one. The fix is that the
roots are the script's default and both callers now pass nothing.
(2) *`lib/scoring` had six cycles, and the type checker had been green over all six the
whole time.* `index.ts` was both the package barrel and the home of the primitives, so
`export * from "./hybrid"` evaluated `hybrid.ts` first and `hybrid.ts` imported `diffWords`
back through the barrel; `spans.ts`, `provider-correlation.ts` and `equivalence.ts` the
same. **A type checker is not a cycle checker** — TypeScript compiles circular ES modules
without complaint. The register's own earlier note said "`tsc --build` would fail
differently if it were" cyclic; that is corrected where it was written.
(3) *the mechanism is narrower than the first draft of this entry said, and running it is
what found that out.* Draft one blamed hoisting: the symbols pulled back through the barrel
are `export function`, `RANKING_WEIGHTS` is a `const`. True, not decisive. A cycle bites
only when a module **reads** a cycle-imported binding while that binding's module is still
evaluating — these siblings only *call* through the barrel later, at runtime, so a `const`
would have been fine there too. One top-level read is the whole distance to a break, proved
on node with a three-file copy of the shape: hoisted function returns, `const` read at
sibling top level throws `ReferenceError: Cannot access 'RANKING_WEIGHTS' before
initialization`.
(4) *the break test's job here was to prove the guard is load-bearing, not just loud.*
Seven mutations reintroduce a cycle (four scoring siblings back on the barrel, one fresh
cycle in each of `lib/db`, `lib/stt-providers`, `artifacts/api-server`) — all caught. The
two that matter most invert it: dropping `lib/scoring` from `DEFAULT_ROOTS`, and pinning
`package.json` back to one root, both make the guard go **blind** on a real cycle. 9 of 9.
(5) *the reason for leaving the UI out was itself wrong, and measuring it is what found
that.* The first version of this step said `artifacts/stt-benchmark` is excluded because it
is 87 `.tsx` to 14 `.ts` and the walker matches `/\.ts$/` — so widening the filter was "its
own step, once the UI's cycles are counted". Counted: **202 `@/` alias imports to 1
relative one.** This walker only follows relative specifiers, so widening the filter would
traverse one edge out of 203 across 101 files and print `no import cycles among 101 files`.
A green pass that has checked nothing — the exact failure this step exists to fix, dressed
up to look thorough. Resolving `@/*` against `compilerOptions.paths` is the real work, and
the `.tsx` widening on its own would make things worse. Corrected in the script header, the
backlog entry and on the PR before merge.

**PR:** one. Spends nothing: no provider, no LLM, no database.
**Depends on:** nothing.
**Files:** `scripts/check-import-cycles.mjs`, `package.json`, `.github/workflows/ci.yml`,
`lib/scoring/src/core.ts` (new), `lib/scoring/src/index.ts`,
`lib/scoring/src/{hybrid,spans,provider-correlation,equivalence}.ts`,
`docs/backlog/good-to-have.md`.
**Verified:** the extraction is byte-for-byte, asserted against `git show HEAD:` of the
original and checked that no original line landed in neither file. **No test file changed** —
that is the proof the move carries no behaviour. 174 scoring · 173 API unit · 96 providers ·
157 UI · 142 integration, `pnpm run typecheck` clean.
**Must not:** change scoring arithmetic (this moves lines, it does not edit them); point the
guard at `artifacts/stt-benchmark` before it resolves the `"@/*"` alias — the UI is 202
alias imports to 1 relative one, so it would traverse a single edge and report a pass over
101 files; widen the filter to `.tsx` alone and call the UI covered, which is that same
false pass with better camouflage; add `lib/api-zod` or `lib/api-client-react`, which are
orval output and not hand-fixable.

---

### R-11 — The one socket URL that still carries a key gets the guard the others already have

**Status:** done 2026-09-09 (PR #129, `a558fbd`). Prompted by O-48, logged 2026-09-07 while
shipping M-11a and carried as a "worth having" for two days.
**Learned:** (1) *the item's own claim was wrong, and measuring it is what found that.*
O-48 said `new WebSocket(url)`'s thrown message "would carry `access_token`" into
`benchmark_provider_call_results.error_message`. It does not, and on this runtime it
cannot. Four throwing inputs to node 22.22.2's global `WebSocket` — `ftp:` scheme, a URL
fragment, a malformed host, an empty string — each produce a `DOMException` whose message
is a **constant**, with no `cause`, `stack` as its only own property, and no key under a
full `JSON.stringify` over its own property names. The inner `TypeError` from `new URL()`
*does* carry the whole URL on `.input`, but undici stringifies it into the message and
drops the object. `url` is also referenced exactly twice in the file — built at :272,
consumed at :338 — never logged, never in `rawOutput`. **There was no live leak and there
never had been.** The entry was written by reading two files against each other; nobody
had made the constructor throw. Corrected where it was written.
(2) *the measurement found a real defect pointing the other way.* Of the three socket
adapters, `cartesia.ts` is the **only one whose URL still carries a secret** — M-11e moved
Deepgram's onto the subprotocol, and every other adapter uses an `Authorization` header —
and it was the **only one without the guard**. Both backwards. What the guard buys is that
this stops resting on an undocumented property of undici's error construction.
(3) *a stub must throw the thing being scrubbed, or the test reads its own stub.* The
M-11e sibling case one block above stubs `WebSocket` to throw `"stub refused the
connection"` and then asserts `errorMessage` does not contain the key — an assertion that
holds with or without the guard, because the stub's message never had the key. What it
really proves is that the throw is *caught*. R-11's case throws the URL itself, which is
what an implementation that quoted its argument would do, and additionally asserts the key
**was** on the URL the constructor received, so the result cannot hold for the wrong
reason. The sibling is logged (O-93), not fixed here.
(4) *the break test found a dead line in the fix itself, and it was kept on purpose.*
7 of 8 mutations caught; M3 (report the error's own message) and M4 (append the url) are
what a future leak looks like and both fail the suite. The miss — dropping `settled = true`
— was investigated rather than waved through: all three `finish()` call sites sit inside
callbacks registered after the constructor, so on the throw path none exists and `settled`
is read by nothing. A no-op mutation, not a coverage gap. Kept because both Deepgram guards
set it, and three sockets differing in a line this subtle is worse than one dead assignment;
the comment says so.
(5) *R-10's temporal dead zone, in the wild.* Mutation M5 makes the catch call `finish()`
instead of resolving. `finish()` reads `connectTimer` and `responseTimer`, `const`s declared
below the constructor — `ReferenceError`, caught.

**PR:** one. Spends nothing: no provider call, no LLM, no database, no network.
**Depends on:** nothing.
**Files:** `lib/stt-providers/src/adapters/cartesia.ts`,
`lib/stt-providers/src/adapters/parsers.test.ts`, `docs/backlog/good-to-have.md`.
**Verified:** 97 provider tests (was 96), `pnpm run typecheck` clean at repo root. Break
test re-run against the committed file, same 7 of 8.
**Must not:** change how the key is carried — `access_token` as a query parameter is what
Cartesia documents for a client that cannot set request headers, which the global Node
`WebSocket` cannot; report the caught error's own message or the url from the catch (that
is the leak this closes, and mutations M3/M4 fail on it); call `finish()` from the catch;
claim this fixed a live leak.

---

### R-12 — The streaming provider row exists, and the plan that was to keep it safe does not work

**Status:** `done` — PR #130, sha `11f9cc8`. Spends nothing.
**PR:** one.
**Depends on:** M-11a (the adapter and its catalog entry).
**Files:** `artifacts/api-server/src/lib/default-providers.ts` (new — the array moved out
of `artifacts/api-server/src/routes/benchmark.ts`),
`artifacts/api-server/src/lib/default-providers.test.ts` (new),
`lib/stt-providers/src/registry.ts` (the comment that pointed at the old home).
**Today (before):** `deepgram-nova-3-streaming` had an adapter and a `providerCatalog`
entry from M-11a and no row in `benchmark_providers`. `getProviderAdapter()` resolves the
id off the registry; `POST /benchmark/runs` validates the selection against the table. So
the id looked resolvable everywhere except the one place that decides what can run, where
a run naming it was created `blocked` with "one or more providers do not exist".
**Change:** seed the row, `manuallyDisabled: true`. Move `defaultProviders` into its own
module so the guard can be a unit test — importing `routes/benchmark.ts` pulls in
`@workspace/db`, whose module body throws without `DATABASE_URL` and opens a pool, and
`vitest.config.ts` says out loud that nothing under `src/` touching the database is a
target there.
**Acceptance:** WHEN an adapter is in `providerRegistry` THEN `defaultProviders` SHALL
carry a row with the same id; AND the two Deepgram socket rows SHALL be seeded
`manuallyDisabled`.
**Verify:** `pnpm --filter @workspace/api-server test` (175); `pnpm run typecheck`;
`pnpm run check:cycles`; break test 6 of 7 caught, 7 of 7 matching expectation.
**Must not:** enable either socket row (that is M-11d and a go-spend); assert the
placeholder price in a test; assert `providerCatalog` keys — `elevenlabs-scribe-v2` has
no seed row on purpose, because T-104 rows are created on demand from the Setup page's
model list.

**Learned:**

1. **The fix M-11d's own grill wrote does not work.** That grill (2026-09-08, item 1) said
   to "create BOTH rows disabled first, stream to them while disabled, and let *enable*
   stay the thing that waits on the numbers". `syncProviderReadiness()` derives
   `status: "disabled"` from `manuallyDisabled`, and `POST /benchmark/runs` pushes
   "provider credentials and models must be configured" onto its `blockers` list for any
   provider whose status is not `ready`. **A disabled row cannot be streamed to at all.**
   Enabling has to happen *before* the first live call, so the money protection cannot be
   "don't enable" — it has to be "enable, make one call, then decide whether it stays
   enabled". Corrected in M-11d's block above, where it was written.

   **Corrected 2026-09-09 (R-13): the bolded sentence above was false when I wrote it.**
   It was true of `POST /benchmark/runs` and of nothing else. `createBulkFromCriteria`
   read the provider ids only to prove they exist, `launchBulk` inserted its shard runs
   `queued` and executed them, `POST /runs/:runId/execute` checked only that the run
   existed, and the Bulks dialog rendered a live checkbox on the disabled row — so a
   disabled row *could* be streamed to, by the path that actually spends the money in
   this tool. R-13 puts the refusal inside `executeBenchmarkRun`, which every one of those
   doors leads to, and the sentence is true now for a reason rather than by luck. The
   conclusion it was used for — enable before the first live call — is unchanged, and is
   now enforced rather than assumed.
2. **Two sources of truth about what can be selected, and only one of them can be.** The
   registry answers "does this id have an adapter"; the table answers "can a run name it".
   For three weeks those disagreed and nothing said so, because nothing read both. The
   guard reads both.
3. **A break test found the one edit here that costs money.** Flipping `manuallyDisabled`
   to `false` was a MISS on the first run — no test read it — and it is the single change
   in this file that lets a never-opened socket into the next bulk. That is why there are
   two assertions and not one. M-11e's lesson again, one file over: the mutation that
   matters is the one nobody would think to write a test for.
4. **A flagged placeholder beats a null.** `costPerMinute: 0.0077` is the only number in
   the new entry that is not evidence — it is *Flux's* streaming rate (verified
   2026-08-29), and no nova-3 streaming rate has been read here; nova-3's `$0.0043` is the
   pre-recorded rate. Left null it would have been worse than wrong: `hybridCompositeScore`
   scores a null cost as the cheapest possible (O-37), so an unpriced row outranks a priced
   one the moment someone enables it. Carried and flagged, in the comment and in the
   `configNote` the Setup card shows. M-11d reads the real rate.
5. **The status line I have been quoting does not mean what I said it meant.**
   `/api/healthz` `providersConfigured` lists adapters holding a key, not runnable rows —
   which is exactly why this gap stayed invisible for three weeks: healthz has been naming
   `deepgram-nova-3-streaming` all along. The UI already labels it honestly ("N
   provider(s) have a key set"); the misreading was in my own reports, which quoted it as
   "N providers configured". O-52, logged, not fixed here.

---

### R-13 — The disabled switch guards every path into the executor, not one route

**Status:** `done` — PR #131, sha `2ee8426`. Spends nothing.
**PR:** one.
**Depends on:** R-12 (which is what made the gap matter: two socket rows now sit disabled,
adapter present, key present).
**Files:** `artifacts/api-server/src/lib/run-executor.ts`,
`artifacts/api-server/src/routes/__integration__/run-executor-disabled.int.test.ts` (new),
`docs/backlog/good-to-have.md`.
**Today (before):** `POST /benchmark/runs` refused to CREATE a run naming a provider whose
status is not `ready`, and that was the entire enforcement of the Setup off-switch.
`createBulkFromCriteria` (`lib/bulks.ts`) read the provider ids only to prove they exist —
`status` and `manuallyDisabled` appear nowhere in that module; `launchBulk` inserted every
shard run `status: "queued"` and handed it straight to `executeBenchmarkRun`;
`POST /runs/:runId/execute` checked only that the run existed; `runCell` gated on the
adapter, never on the row; and the Bulks create dialog rendered a live checkbox for every
provider with a grey `DISABLED` label beside the tick. A `not_configured` provider was
saved by an accident rather than a gate (no key, so its adapter throws before the network);
a `disabled` row has its key present, which is the only reason `syncProviderReadiness` has
to override it. ox-alpha B-34 found the narrow version on 2026-08-25 and named this fix.
**Change:** split the executor's provider list on `manuallyDisabled` immediately after it
is read, above the audio pre-pass. Every live cell of a disabled provider is written as a
refused row naming the reason; a separate `disabledCells` counter carries its own note
line (config_blocked's sentence says "provider API key not configured", which is the
opposite of true here); `totalCells` counts what the run was ASKED for, so a run whose only
provider was disabled can never read `okCells === totalCells` and finalize `complete`.
**Acceptance:** WHEN a run names a provider with `manuallyDisabled` THEN no cell for that
provider SHALL reach an adapter, AND each such cell SHALL be recorded with a message
naming the switch, AND the run's notes SHALL say how many cells were never sent.
**Verify:** `pnpm run typecheck`; `pnpm --filter @workspace/api-server test` (175);
integration suite 29 files / 145 tests (was 28 / 142); break test 10 of 10 caught, after
two of them were misses on the first pass (learned 7).
**Must not:** put a real provider id in the new suite, disabled or not; gate on the derived
`status` column instead of `manuallyDisabled`; refuse the whole run when only one of its
providers is off; close the doors (bulk create, the UI checkbox) in this step.

**Learned:**

1. **A claim of mine was wrong, and R-12 rested on it.** R-12's learned item 1 said "a
   disabled row cannot be streamed to at all". That was true of one route. The path that
   actually spends money in this tool — create a bulk, launch it — never looked at the
   column at all, and the UI offers the tick. Corrected in R-12's own block and in
   M-11d's, where each was written.
2. **A gate on the door only guards that door.** Four doors reach `executeBenchmarkRun`
   and one of them had the lock. The refusal now sits at the choke point every door leads
   to, which is also the only place that cannot be bypassed by a path nobody has enumerated
   yet — including the ones added after this.
3. **`not_configured` was never protected either; it was lucky.** Its safety comes from a
   missing key, not from a check. The moment a key exists for a row someone has switched
   off, the luck runs out — which is exactly the state both Deepgram socket rows are in.
4. **The refusal is recorded, not skipped.** A silently dropped cell is invisible; these
   are written as rows with their reason, so a bulk that quietly did less than asked says
   so on its own results.
5. **Placement was decided by a test failure, not by taste.** The first draft of the
   second case expected the enabled provider to fail at the missing-adapter branch; it
   fails earlier, in the audio pre-pass ("Call has no audioObjectPath"). That is the proof
   the gate had to sit ABOVE the pre-pass: one placed below it would have reported a
   disabled provider's cells as an audio problem, and would have resolved audio — a Vapi
   request per call — for calls with nothing left to run. T-43's reasoning, one step over.
7. **A break test that catches everything has not finished.** The first eight mutations
   were 8 of 8 — which O-66 already warned is the shape of a harness aimed at the code the
   test was written against. Two more, aimed at what the test does NOT assert, both MISSED:
   reading the derived `status` column instead of `manuallyDisabled` (the fixture set both,
   so the substitution was invisible), and dropping the `isCellLive` check (the upsert
   refuses to replace an "ok" row, so nothing is destroyed — but `disabledCells` counts it
   anyway and the note then names a cell that in fact succeeded). Both are fixed by the
   test, not by the code: case one's fixture is now deliberately inconsistent
   (`manuallyDisabled: true` with `status: "not_configured"`, a row whose derived column
   has not caught up), and a third case re-executes a run whose disabled provider already
   has an ok cell.
8. **A bug register nobody reads is not a bug register.** `ox-alpha/bug-register.md` had
   this as B-34 on 2026-08-25, with the fix written out. Two weeks. The register loop reads
   `docs/step-register.md` and the memo; `ox-alpha/` is not in either. Logged as its own
   open item rather than fixed here.

---

### R-14 — The two unmeasured lines stop saying "yet"

**Status:** done 2026-09-09 (PR #134).
**PR:** one. Spends nothing.
**Depends on:** nothing. Caused by Abhishek's 2026-09-09 answer to PRD v7 C2: *"no by
hand thing"* -- nobody will transcribe the 20 calls, so the labelled set is frozen at 2
(1 usable; the other is O-76's fragment).
**Files:** `artifacts/stt-benchmark/src/components/verdict-headline.tsx`
(`ProxyAgreementLine`, `JudgeAccuracyLine`, the `MEASURABLE_FLOOR` comment),
`artifacts/stt-benchmark/src/pages/__render__/results.test.tsx` (the two below-floor
cases assert the exact strings and must be rewritten with them),
`docs/PRD-v7-decide.md` C2.
**Today:** below the floor the two lines read *"Not enough human-checked calls to measure
this **yet** -- 2 of 20"* and *"Judge accuracy: not measured (1 of 20)"*. Both are a
progress bar over a counter that will never advance. A reader who waits is waiting for
work nobody is going to do, and a reader who does not notice reads "not measured" as a
temporary state of a tool that is otherwise measuring accuracy. It is not: **this tool
measures disagreement between providers, and now always will.**
**Change:** below the floor, both lines say the check is not being run and why, in the
reader's words, not the codebase's -- the count stays visible (it is the evidence for the
sentence) but stops being framed as progress. The floor constant and the above-floor
branch stay exactly as they are: if a labelled set ever does appear, the lines must still
work without another edit. `MEASURABLE_FLOOR`'s comment gains the reason the floor is now
unreachable, so the next reader does not "fix" it by lowering it to 1 -- one call is the
noise M-18's grill already rejected.
**Acceptance:** WHEN `labelledCalls > 0` and the count is below the floor THEN neither
line SHALL contain the word "yet" or any other wording that implies a pending human pass;
AND the sentence SHALL name what the ranking is measured on instead. WHEN the count
reaches the floor THEN the existing percentage sentences SHALL render unchanged.
**Verify:** the two below-floor render cases in `results.test.tsx` rewritten and green,
plus the two above-floor cases untouched and still green; `pnpm run typecheck`.
**Must not:** lower or remove the floor; delete either line (an unmeasured check that
says so is the audit trail -- deleting it is how a tool quietly starts sounding accurate);
touch the M-9 legend sentence above them, which is already correct.
**Before code:** this is user-facing copy for a non-technical reader, so the
`visual-and-research` pass runs first and its evidence note goes in this block.

**Evidence (`visual-and-research`, 2026-09-09) — R-14, the two below-floor lines.**

**Pattern to use:** an unavailable metric keeps its label and its condition sentence, and
replaces the number with words rather than a zero — Braintrust's monitor cards print the
metric name with "No data" where the chart would be, and a one-line reason above the grid
([Braintrust screen](https://mobbin.com/screens/eae8cdb3-c2da-4e08-9433-1f5ba8791655));
Graphite states the condition in the reader's terms rather than the system's ("There are
fewer than 5 Graphite users who were active across this entire time frame for these
repos")
([Graphite screen](https://mobbin.com/screens/2674ce11-f87a-4cd0-b25d-50d1a8c72893)).

**Patterns to avoid:** every empty state on file ends in an action the reader can take,
which is exactly the sentence R-14 must not write. Cloudflare: *"There is not enough data
for Web Analytics right now. **Check back** after more visitors have visited your
website"*
([Cloudflare screen](https://mobbin.com/screens/7ec1f61d-bfbe-4481-9ced-eafac4916bbc));
Vapi: *"No data here — Please expand your date range or make some calls to start seeing
metrics"*
([Vapi screen](https://mobbin.com/screens/09275981-aeca-4550-b0ad-de53f05ae650)).
"Not enough human-checked calls to measure this **yet**" is that grammar, and it promises
a check-back that will never pay out.

**What operators say:** eval dashboards fail on trust, not on maths — *"Many teams build
eval dashboards that look useful but are ultimately ignored and don't lead to better
products, because the metrics these evals report are disconnected from real user
problems"* ("Building eval systems that improve your AI product", Hamel Husain & Shreya
Shankar, 2025-09-09,
https://www.lennysnewsletter.com/p/building-eval-systems-that-improve-your-ai-product).
The same post puts a named human expert and ~100 labelled interactions at the root of any
trustworthy eval — the exact input this project has decided not to buy, which is why the
line has to say so instead of implying it is queued.

**Changes to the plan:** two. (1) Keep the metric's label ("Judge accuracy:") and lead
with the state, Braintrust-style, instead of opening with the shortfall. (2) Add the
"what is measured instead" clause the register asked for to the M-18 line only — the
M-20 line gets "never as a verified answer" instead, because the judge's pick is a
verdict input on this page and a reader who is not told that will read an ungraded pick
as a right answer.

**No evidence found for:** a shipped product that says a metric will *never* be computed.
Every unavailable-metric screen on Mobbin is a recoverable state, and the settings
screens that do describe an off state
([Basecamp](https://mobbin.com/screens/d840c4e8-e9df-47aa-af91-bf31d4e3ab96),
[Gorgias](https://mobbin.com/screens/e3e51b42-ddc4-43f1-95b3-c0e53b9545c1)) are toggles
the reader controls, not read-only report lines. The permanence sentence is this
project's own; nothing was borrowed for it.

> **What shipped.** Two below-floor branches in
> `artifacts/stt-benchmark/src/components/verdict-headline.tsx`, both self-contained (no
> "for the same reason" between them — `n` and `judgePicks` are different numbers and can
> land either side of the floor independently):
>
> - M-18: *"Not checked against human transcripts. That check needs 20 calls written out
>   by a person; 2 exist and no more are being written. What the ranking on this page
>   measures is how much the providers disagreed with each other."*
> - M-20: *"Judge accuracy: not checked. Scoring its picks needs the same human
>   transcripts -- 1 of the 20 it would take, and none are coming. Its pick is shown as
>   one input to the ranking, never as a verified answer."*
>
> `MEASURABLE_FLOOR` stays 20 and its comment now carries the reason it is unreachable
> and an explicit "do not lower this to 1 or 2 to make a percentage appear". The
> above-floor branches, the floor and the M-9 legend are byte-identical.
>
> **What was learned.** *A number with a denominator is a promise.* Neither line lied —
> "2 of 20" was true on both. What made them wrong was the shape: `N of M` is the same
> shape as a loading bar, and a reader who cannot read the code reads the shape, not the
> sentence. The fix was not to hide the count but to stop it being the subject: the state
> comes first ("Not checked"), the count arrives as evidence for it, and the sentence
> ends on what IS being measured so the reader is not left holding a gap. The research
> pass is what named this: every unavailable-metric screen in the library ends in an
> action, because in every one of those products the data is coming. Ours is not, and
> that is the whole difference the copy had to carry.
>
> **A claim corrected where it was made.** The M-18 doc comment in the same file said
> "below the floor the reader is told how far along the check is". It is not how far
> along anything is any more; the comment now says so and points at the floor constant
> for why.
>
> **Corrected 2026-09-09 by R-17, in two places.** (1) The M-18 string quoted above read
> `; 2 exist and no more are being written`, and the 2 was `data.n`. The words say
> "calls written out by a person", which is `labelledCalls`; `n` is the subset of those
> that could be ranked two ways. They were equal on this corpus, so the shipped line
> printed the right digit for the wrong reason, and the doc comment ten lines above it in
> the same file already forbade exactly this ("Printing only n against the words 'a
> person checked' would credit them with less work than they did"). The below-floor
> branch now reads `labelledCalls`, pluralised. (2) The "frozen at 2 calls, 1 of them
> usable" reading in `MEASURABLE_FLOOR`'s comment is now "frozen at 1 call" — R-17
> cleared the unusable one. The M-20 string is unchanged: `judgePicks` is the right
> number for the words beside it, and the pick it counts is on the call that survives.

---

### R-15 — The root build goes green, and CI builds every package

**Status:** done 2026-09-09 (PR #135).
**PR:** one. Spends nothing.
**Depends on:** nothing.
**Files:** `artifacts/mockup-sandbox/vite.config.ts`, `.github/workflows/ci.yml`.
**Today:** `pnpm run build` at the repo root exits 1 on a clean checkout of main.
`artifacts/mockup-sandbox/vite.config.ts` throws `PORT environment variable is required
but was not provided.` while its config is still loading -- the Replit-shaped hard
requirement that `artifacts/stt-benchmark/vite.config.ts` softened to a `5173` default
and which was never copied across. It throws the same way for `BASE_PATH`. Neither is a
dev-server-only concern: a `vite build` loads the same config file, so the package cannot
be built at all without two environment variables that no script in this repo sets.

CI is green anyway, because it does not run the root script: `.github/workflows/ci.yml`
builds exactly two named packages, `@workspace/stt-benchmark` and `@workspace/api-server`.
The check is telling the truth about what it ran and nothing about the command a person
types. That gap is the actual defect -- the broken config is only what fell through it.

**Change:** two, in that order of importance.
1. CI builds **every** package with a `build` script (`pnpm -r --if-present run build`)
   instead of two by name, so a package that cannot build can never again pass.
2. `mockup-sandbox`'s config takes the same shape as `stt-benchmark`'s: `PORT` optional
   with a laptop default, `BASE_PATH` optional defaulting to `/`, an invalid `PORT` still
   a hard error. Ports differ (5174, not 5173) so the two dev servers can run at once.

**Acceptance:** WHEN `pnpm -r --if-present run build` runs on a clean checkout with no
`PORT` and no `BASE_PATH` in the environment THEN every workspace package SHALL build;
AND WHEN `PORT` is set to a non-numeric or non-positive value THEN the config SHALL still
throw.
**Verify:** `pnpm run typecheck`; the root build green with the environment cleared;
break test = restore the hard `throw` and watch the recursive build exit 1.
**Must not:** delete `mockup-sandbox` (a separate decision, see below); change
`stt-benchmark`'s port or base path; drop the invalid-PORT guard; touch the Replit vite
plugins (O-101's step -- but note this step is what makes that one verifiable, because
after it CI actually builds the packages those plugins are in).

**Not decided here: whether `mockup-sandbox` is alive.** Measured while building this --
`artifacts/mockup-sandbox/src/.generated/mockup-components.ts` exports an **empty** module
map, there is no `src/components/mockups/` directory for its plugin to scan, and its build
transforms 30 modules. It is a preview harness with nothing to preview, and nothing outside
the package references it. Deleting it is 68 tracked files and a lockfile move, and it is
Abhishek's call, not a side effect of making a build script honest. Logged, not done.

> **What shipped.** Nine lines of config and one CI step. `mockup-sandbox`'s two
> `throw`s became a `5174` default and `?? "/"`, copied from `stt-benchmark`'s wording so
> the next reader sees one pattern rather than two; the invalid-`PORT` guard survived
> unchanged. CI's two named build steps became one `pnpm -r --if-present run build`.
>
> **What was learned.** *A green check is a claim about the command it ran, not about the
> command a person types.* The build was red on main for weeks and every PR in that window
> passed, honestly: the job built two packages and both of them built. Nothing was lying.
> The defect was that the job's coverage was written as a list, and a list only stays
> right if somebody edits it when the repo changes -- which is the same failure mode as
> `replit.md` sitting outside `check-doc-paths`' `LIVE_DOCS` (PR #133) and as
> `post-merge.sh` filtering on a package name that did not exist. Three instances in two
> days of the same shape: **a check that enumerates its subjects will drift; a check that
> derives them cannot.** `pnpm -r` derives. Prefer the recursive form over the named form
> anywhere the named form would need maintenance to stay honest.
>
> **What this unblocks.** O-101 (finish the Replit removal) was waiting on exactly this:
> the three `@replit` vite plugins live in the two packages CI now actually builds, so
> removing them is verifiable rather than hopeful.

---

### R-16 — The dead Replit packages go; the one that still works stays

**Status:** done 2026-09-09 (PR #136).
**PR:** one. Spends nothing.
**Depends on:** R-15 — and not incidentally. Two of the three packages removed here live
in `artifacts/stt-benchmark` and `artifacts/mockup-sandbox`, and until R-15 CI built
neither of those from the recursive form. Removing them before R-15 would have been
hopeful; after it, a broken removal fails the build job.
**Files:** `artifacts/stt-benchmark/vite.config.ts`,
`artifacts/mockup-sandbox/vite.config.ts`, both packages' `package.json`, the root
`package.json`, `pnpm-workspace.yaml`, `pnpm-lock.yaml`.
**Today:** PR #133 removed the seven Replit *platform* files and deliberately left four
things behind, each with a reason. Three of them are now settled.

**Change:**
1. `@replit/vite-plugin-cartographer` and `@replit/vite-plugin-dev-banner` are gated on
   `process.env.REPL_ID !== undefined`, which is unset everywhere this project runs, so
   they have never executed here. Gone from both configs, both `package.json`s and the
   catalog.
2. `@replit/connectors-sdk` was the only entry in the root `dependencies` block and has
   zero imports anywhere in the repo. The block goes with it.
3. `minimumReleaseAgeExclude` waived the 1-day supply-chain quarantine for the whole
   `@replit/*` scope plus `stripe-replit-sync`, with the comment *"these are our own
   packages"*. They are not ours — that sentence was written on Replit, for Replit, and
   came along with the file. `stripe-replit-sync` is not a dependency of anything here.
   Narrowed to the single package actually installed.

**Deliberately kept: `@replit/vite-plugin-runtime-error-modal`.** Read its source rather
than its name. Its `apply()` is `env.command === "serve" && !config.ssr` — it is a
dev-server plugin that never touches a production bundle — and what it does is hook
`window.onerror`, forward the error over Vite's HMR channel so it prints in the dev
server's terminal, and show an overlay. That works off Replit and is worth having for an
operator who is not reading a browser console. The one Replit-shaped line in it,
`window.parent.postMessage(...)` to an embedding frame, is a no-op with no parent frame
and is wrapped in its own `try/catch`. Removing a working dev tool because of the scope
in its name is not a cleanup. One line in each config if that call is ever reversed.

**Acceptance:** WHEN the workspace is installed from the committed lockfile THEN no
`@replit` package except `vite-plugin-runtime-error-modal` SHALL be present; AND
`pnpm -r --if-present run build` SHALL exit 0.
**Verify:** `pnpm run typecheck`; all four unit suites; the recursive build; CI (which
after R-15 builds the two packages these plugins were in).
**Must not:** remove the runtime-error-modal plugin; touch `pnpm-workspace.yaml`'s
esbuild `overrides` block.

**Still open, deliberately: the esbuild `overrides`.** `pnpm-workspace.yaml` still
deletes every non-linux esbuild binary under the comment *"replit uses linux-x64 only"*.
It has been survivable only because the root `devDependencies` pins
`@esbuild/darwin-arm64` by hand to put back one of the binaries the overrides removed —
a workaround for a setting, both of which would go together. Proving that change means a
clean `node_modules` reinstall on two platforms, which is not this PR's shape. Left as
its own step with that verification named.

> **What was learned.** *Read the package, not the name.* Three of these four were dead
> by inspection — a gate on an env var nobody sets, an import nobody wrote, an allowlist
> for a package nobody depends on. The fourth had the same name, the same scope, the same
> vendor, and was doing real work. A sweep by prefix would have removed it with the
> others and called that finishing the job.
>
> **And a real one found on the way.** The supply-chain allowlist did not just name a
> package, it waived the quarantine for an entire third-party scope, and justified it with
> a sentence about "our own packages" that stopped being true the day this repo left
> Replit. Inherited configuration keeps its original author's assumptions, and a comment
> is where they hide.
>
> **Corrected 2026-09-09 by R-18.** That last sentence was right about this file and
> wrong about this PR. R-16 deleted the "our own packages" justification from the
> allowlist and left the same claim standing forty lines above it, in the header comment
> that tells the next person which vendors are safe to add: *"trusted organizations with
> an impeccable security posture (e.g. Replit packsges, react from Meta, typescript from
> Microsoft)"*. The waiver was narrowed; the instruction to widen it again was not
> touched. Fixed in R-18, in the same commit as the check that would have caught the
> package but never the prose.

---

### R-17 — The fragment gold goes, and the count beside "written out by a person" is the right one

**Status:** done 2026-09-09 (PR #137).
**PR:** one. Spends nothing.
**Depends on:** R-14 (which decided the labelled set is frozen, and so retired the
"finish it" branch this row used to have). Closes memo O-76.
**Files:** `artifacts/api-server/src/backfill-r17-clear-fragment-gold.ts` (new),
`artifacts/stt-benchmark/src/components/verdict-headline.tsx`,
`artifacts/stt-benchmark/src/pages/__render__/results.test.tsx`.
**Today:** two calls carry a human gold, and one of them is not a transcript. Call
`3559ea45`'s gold is **25 words against a 111-word draft** on a 51-second call — about
the first eleven seconds, ending mid-conversation on a question mark. Whoever was typing
stopped. Scoring against it does not measure accuracy: every word a provider correctly
heard after the fragment ends counts as an insertion, so its eight scored cells run
**WER 0.400 to 3.560** and rank providers by how much MORE than the fragment they
transcribed. That is half the entire labelled set, so M-18's proxy-agreement figure is
half computed on a quantity that is upside down. The other call (`64d8f463`) is the real
thing — 186 gold words against a 157-word draft, *longer* than the draft, which is what a
human transcript of a machine's output looks like.
**Change:** clear it. A one-off backfill in M-1's shape — dry run by default, idempotent,
one audit row carrying the fragment in `beforeState` so it is restorable, and `status`
left at `ready_to_run` because a call with no gold is the normal case here. The guard is
the gold's **SHA-256**, not its length: if anybody has written to the field since
2026-09-09 the script exits non-zero rather than deleting work it has not read. Existing
`benchmark_scores` rows are left alone, exactly as M-1 left them — they are history and
each run's manifest records the gold it saw; `proxy_agreement` filters on the live gold
at query time, so the call leaves the measurement the moment this runs.
**And the number the UI prints beside it.** See the correction appended to R-14 above:
the below-floor sentence printed `n` where its own words say `labelledCalls`. Found while
working out what this step would change on screen, which is the only reason it was found
at all — the two are equal on this corpus and stay equal after this step.
**Acceptance:** WHEN the backfill has run THEN `GET /benchmark/proxy-agreement` SHALL
report `labelledCalls: 1`, AND re-running the backfill SHALL clear nothing, AND running
it against an edited gold SHALL exit non-zero without writing. **All three verified live
2026-09-09; the readings are in the block below.**
**Verify:** dry run first and read what it names; `pnpm run typecheck`; the render cases
in `results.test.tsx`, including a new one where `labelledCalls` and `n` differ (they
never did on the live corpus, which is how R-14's swap survived review) and one on a
single labelled call, which is the state the live page is in after this.
**Must not:** delete the row, the audio, or the scores; touch `status`; clear the gold on
`64d8f463`; lower `MEASURABLE_FLOOR` because the count went down.

**On `visual-and-research`:** not re-run. This is not new copy — it is a correction to the
copy R-14 already researched (its evidence note is in the R-14 block above), swapping one
count for another and fixing a singular. The searches that would answer "how should this
sentence read" have already been run and are cited where the sentence was written.

> **What shipped.** One backfill script, one changed expression in
> `ProxyAgreementLine`, two render cases. The judge's one measured pick is on
> `64d8f463`, the call that survives, so `judgePicks` is unaffected — and it is now
> measured against a real transcript with nothing else averaged into it.
>
> **Measured live, 2026-09-09, before and after the `--apply`:**
>
> | | labelledCalls | n | top1Agreement | kendallTau | judgePicks |
> |---|---|---|---|---|---|
> | before | 2 | 2 | 0.5 | 0.017 | 1 |
> | after | **1** | **1** | **1** | **0.632** | 1 |
>
> Verified alongside it: one gold left on file (`64d8f463`, 978 chars); one audit row
> under `backfill-r17-clear-fragment-gold` whose `beforeState` carries the fragment and
> whose `afterState.goldTranscript` is null; the eight `benchmark_scores` rows on
> `3559ea45` still present; `status` still `ready_to_run`; a second `--apply` clears
> nothing. The dev server on :5173 serves the new expression and no longer contains
> `data.n} exist`.
>
> **The after-values are the argument for the floor, not against it.** Removing the bad
> half of the labelled set moved top-1 agreement from 0.5 to **1.0** and tau-b from 0.017
> to **0.632** — from "no relationship" to "strong relationship" — because one call
> cannot disagree with itself. If `MEASURABLE_FLOOR` were 1, this page would now be
> printing *"picked the same provider as the human-checked order 100% of the time"* off a
> single call, and it would read as the best evidence the tool has ever had. Cleaning bad
> data made the unguarded number **more** seductive, not less. Nobody lowers the floor.
>
> **What was learned.** *A number can be right and still be the wrong number.* The
> below-floor line printed 2 and 2 was correct — `labelledCalls` was 2 and `n` was 2. The
> defect was invisible because the corpus made the two variables interchangeable, and it
> would have surfaced as a quiet under-count on the first day they diverged, in a
> sentence about how much work a person did. A rule written in a comment three lines
> above the code it governs is not enforcement: **the only reason this was caught is that
> the test now feeds the two counts different values.** Equal fixtures test one variable
> twice.
>
> **And a smaller one.** Clearing a bad reference is not deleting evidence. The audit row
> holds the fragment, the scores stay, the manifests still name the gold each run saw.
> What changes is which numbers the tool is willing to average — and half a labelled set
> is a much bigger share of a measurement than it sounds like when the set is two.

---

### R-18 — R-16's two-directional scan becomes a check anybody can run

**Status:** done 2026-09-09 (PR #139).
**PR:** one. Spends nothing. Closes memo O-102.
**Depends on:** R-16, which is the reasoning this check enforces.
**Files:** `scripts/check-replit-residue.mjs` (new), `package.json`,
`.github/workflows/ci.yml`, `pnpm-workspace.yaml`.
**Today:** R-16's evidence was a scan run once, by hand, quoted in PR #136's description
and nowhere else. Its four break tests proved the scan works; nothing proves the tree
still passes it. The interesting half is direction 2 — the package R-16 argued *for*.

**Change:** the scan becomes `scripts/check-replit-residue.mjs`, wired as
`pnpm run check:replit` and a CI step beside the other four checks. Two directions:

1. **Nothing R-16 removed is referenced again**, and `minimumReleaseAgeExclude` has not
   widened back to the `@replit/*` scope. Tracked non-doc files, whole-line comments
   skipped — the false positive PR #133 hit, where prose documenting a removal counted
   as a reference to it.
2. **`@replit/vite-plugin-runtime-error-modal` is still wired**: declared in
   `artifacts/stt-benchmark` and imported by its vite config, present in the catalog and
   in the allowlist, and every *other* workspace package either declares and imports it
   or does neither.

`artifacts/stt-benchmark` is named as the anchor and `artifacts/mockup-sandbox` is not.
Deriving the whole check from "whatever declares it" would pass an empty repo, so one
package has to be named — and mockup-sandbox may not survive O-99, so it is covered by
the both-or-neither rule instead. Deleting that package needs no edit here; deleting the
plugin does.

**Acceptance:** WHEN the committed tree is scanned THEN the check SHALL exit 0; AND WHEN
any package R-16 removed is referenced in a non-comment line, OR the scope waiver
returns, OR the kept plugin is unwired in either direction, THEN it SHALL exit 1 naming
the file and line.
**Verify:** `node scripts/check-replit-residue.mjs` on the committed tree; `pnpm run
typecheck`; six break tests against the committed tree, each restored with `git checkout
--`, all three passes identical:

| | mutation | result |
|---|---|---|
| A | blanket `@replit/*` waiver back | `SCOPE-WAIVER-BACK` + `stripe-replit-sync`, exit 1 |
| B | cartographer import back in a vite config | `REMOVED-BUT-BACK` at the line, exit 1 |
| C | `connectors-sdk` back in root `dependencies` | `REMOVED-BUT-BACK` at the line, exit 1 |
| D | the kept plugin dropped from stt-benchmark's manifest | `KEPT-BUT-GONE` + `HALF-WIRED`, exit 1 |
| E | the kept plugin dropped from the allowlist only | `KEPT-BUT-GONE`, exit 1 |
| F | mockup-sandbox declares it, config stops importing it | `HALF-WIRED`, exit 1 |

E and F are the ones a one-directional scan misses entirely: neither touches a removed
package, and both leave the repo in a state R-16 argued against.
**Must not:** remove the kept plugin; touch `pnpm-workspace.yaml`'s esbuild `overrides`
(still its own step); make the check read `node_modules` or the network.

> **What was learned.** *A check that only looks one way certifies its own deletion.*
> R-16's whole argument was that one of four same-named packages was doing real work, and
> the cheapest way to lose that argument is a later sweep by prefix — which a
> removed-things-stay-removed scan would grade as a pass. Direction 2 exists so the
> exception has to be argued with again, not just deleted.
>
> **And a real one found on the way, in R-16's own file.** R-16 narrowed the waiver and
> left the header comment above it still naming Replit as an example of a vendor with
> "an impeccable security posture" — the instruction for how to widen it again, sitting
> directly above the narrowed list. R-16's learning says a comment is where inherited
> assumptions hide; it was written in the PR that left one. **A guard reads code, so the
> sentence telling a human to undo the guard is exactly what it cannot see.** Corrected
> in the R-16 block above, where the claim was made.
>
> **And the check's own first green was a lie.** It exited 0 on the working tree before
> the first commit, and exited 1 on six of six mutations *and* on the untouched tree
> straight after committing. The forbidden names are written down in the check itself, so
> direction 1 matched every entry against its own source — and `git ls-files` had not been
> returning the file, because it was untracked. **A scan that walks tracked files cannot
> be trusted until the thing it scans is committed**, which is the same reason the break
> tests are run after the commit and not before it. Fixed with a named self-skip, not a
> pattern: the file is excluded by path, so a re-introduction anywhere else still fails.

---

### R-19 — The ox-alpha bug register gets read, P0/P1 first

**Status:** done 2026-09-09 (PR #140) for the P0/P1 tranche. The three later tranches are
named below and are not started. Closes the first quarter of memo O-100.
**PR:** one, docs only. Spends nothing.
**Depends on:** nothing.
**Files:** `docs/step-register.md`, `docs/backlog/good-to-have.md`.
**Today:** `ox-alpha/bug-register.md` holds 100 entries from a 100-agent hunt dated
2026-08-25. A citation scan over every tracked `.md` outside `ox-alpha/` finds **exactly
80 of the 100 have never been cited anywhere** — the number memo O-100 carried, now
measured rather than remembered:

```
python3 - <<'EOF'
import re, subprocess, collections
docs = [d for d in subprocess.run(["git","ls-files","*.md"],capture_output=True,text=True)
        .stdout.split() if not d.startswith("ox-alpha/")]
cited = {n for n in range(1,101)
         for d in docs if re.search(r"\bB-%d\b" % n, open(d).read())}
print(len(cited), "cited;", sorted(set(range(1,101)) - cited))
EOF
```

**And the count is wrong in the other direction.** `ox-alpha/bug-register-waves.md`, in
the same directory, holds **330** more `[P0..P3]` findings and is cited by nothing at
all. The unread pile is not 80 claims, it is roughly 410. O-100 named the smaller file
because that is the one that was open at the time.

**Change:** read the never-cited P0/P1 entries (17 of them: B-3 … B-22 minus B-14, B-15,
B-16, which the backlog already carries) against today's source and give each a
disposition with the line that decides it. Nothing is fixed here — a triage that also
fixes is a triage nobody can check.

| entry | disposition | the line that decides it |
|---|---|---|
| B-3 Vercel uploads only the sub-package | **live** | `.github/workflows/deploy-web.yml:62` still `working-directory: artifacts/stt-benchmark`; that package's `@workspace/*: workspace:*` and `catalog:` specs resolve only from the repo root |
| B-4 bare CORS makes `x-actor` forgeable | **live** | `artifacts/api-server/src/app.ts:29` `app.use(cors())` |
| B-5 presigned URL leaks via `errorMessage` | **live** | `lib/stt-providers/src/types.ts:147` interpolates the whole `${audioUrl}`, query string included, into the thrown Error |
| B-6 orphan `ok` row skips an unscored cell | **narrowed** | T-43 added `permanentlyFailed`, but `run-executor.ts:377` still defines `alreadyOk` as `status === "ok"` alone, not "has a score row" |
| B-7 `runningRuns` leak bricks re-entry | **narrowed** | unlock + `release()` + `delete()` are inside `finally` now (`run-executor.ts:252-258`) — but `pool.connect()` at `:238` is still **outside** the `try`, so a connect rejection still leaves the id in the Set until restart |
| B-8 attest TOCTOU / Unicode defeats FR-C3 | **moot, with a residual** | the two-approver gate was removed by decision (`routes/benchmark.ts:589-591`); the blind `where(eq(id))` updates and the locale `toLowerCase` survive on a route that no longer gates anything |
| B-9 in-flight scan overwrites human decisions | **moot** | `POST /agent/scans` is gone; the write happens inside `lib/agent-verify.ts` during a run, where no human click can race it |
| B-10 approve corrupts gold provenance | **mostly moot** | `routes/agent.ts:153-156`: approve *"no longer touches benchmarkCallsTable at all"*. The approve/reject TOCTOU on the scan row itself survives — guard read, then `where(eq(id))` |
| B-11 PATCH strips the gold invariant | **live, and wider than written** | the gate is not half-present, it is **gone**: `routes/benchmark.ts:594-600` applies `...body.data` with no status or gold check. `{"goldTranscript":""}` clears gold on any call |
| B-12 audit failure poisons committed work | **live** | `lib/audit.ts:21` is still an unguarded `await db.insert`. Exactly one call site wraps it — `agent-verify.ts`'s `auditOrLog` (T-37) |
| B-13 refetch failure eats unsaved edits | **live, reduced** | `Review.tsx` is gone; `Corpus.tsx:441` has the same unconditional `isError ?` swap, but there is no gold editor left to lose |
| B-17 create form mints dead provider rows | **live** | `routes/benchmark.ts:1187` `const id = \`${base}-${randomUUID().slice(0, 6)}\`` against a registry that looks up by exact key |
| B-18 documented base URL doubles `/api` | **live** | `deploy-web.yml:13` documents the value **with** `/api`; `lib/api-client-react/src/custom-fetch.ts:29` strips trailing slashes and nothing else |
| B-19 diacritics stripped from entities | **live** | `lib/scoring/src/core.ts:223-231`: NFKC, upper, `[^A-Z0-9]` — no NFD, no `\p{M}`. `"CAFÉ"` normalises to `"CAF"` |
| B-20 boundary-less entity substring match | **live** | `lib/scoring/src/core.ts:349` `normalizedHypothesis.includes(normalized)` |
| B-21 Cartesia truncation returns `ok` | **live** | `lib/stt-providers/src/adapters/cartesia.ts:471` — the close handler still keys only on `!finalizeSent`, so a 1006 after finalize is not an error |
| B-22 presigned URL frozen per run | **fixed** | T-7 (`run-executor.ts:516-526`): audio is warmed to a disk cache once per **call** and the bytes are read back per cell; the frozen per-run URL Map is gone |

**Score: 10 live, 2 narrowed, 3 moot, 1 fixed, 1 live-but-reduced.** Two thirds of a
two-week-old P0/P1 list is still true, which is the argument for reading the other 393.

**The sharpest one is not the one that reads sharpest.** B-11 was written as "paid runs
score against an emptied reference", and rankings no longer read gold, so the sentence
looks obsolete. What it actually describes today is that **one unguarded PATCH can null
the entire labelled set** — R-17 left exactly one human gold on file, so the corpus that
the whole floor argument rests on is a single `{"goldTranscript":""}` away from zero,
with an audit row and a 200.

**Acceptance:** WHEN a reader opens this block THEN every never-cited P0/P1 entry SHALL
carry a disposition and the file:line that decides it; AND no entry SHALL be marked
fixed without one.
**Verify:** the citation scan above, re-run; each file:line in the table read at HEAD
`dec0770`.
**Must not:** fix anything here; cite an entry without reading its code; mark an entry
moot because its *impact* changed while its mechanism survives (B-8 and B-10 are recorded
both ways for that reason).

**Not started — the three remaining tranches.** Each is its own step of this shape:
P2 (`B-23 … B-49`, 23 never cited), P3 (`B-50 … B-81`, 28 never cited), wave 2
(`B-83 … B-99`, 12 never cited), and then `ox-alpha/bug-register-waves.md`'s 330.

> **What was learned.** *An unread bug list decays into two lies at once.* Two thirds of
> these are still exactly true, so treating the file as stale would have thrown away real
> defects — and three of them describe code that no longer exists, so treating it as a
> to-do list would have sent someone to fix a route that was deleted. Neither reading is
> safe without opening the file, and the cost of opening it is one afternoon per tranche.
>
> **And the thing a triage is actually for.** B-11 would have been dismissed on its own
> summary line: the reference it protects stopped deciding rankings a fortnight ago. Read
> against today's corpus it is the most dangerous entry in the tranche, because the corpus
> shrank to one call in the meantime. **A finding's severity is a function of the codebase
> it lands in, and both keep moving.** Re-rank on read; never inherit the old priority.

---

### R-20 — What a keyterm list mined from this corpus actually contains

**Status:** done 2026-09-09 (PR #141). Answers memo O-104 option (b) — Abhishek's pick — with
a measurement, and the measurement says no. No code is built; M-19b stays blocked, and the
reason it stays blocked is now two reasons instead of one.
**PR:** one, docs only. Spends nothing: reads the local API on :8177, makes no provider call.
**Depends on:** nothing.
**Files:** `docs/step-register.md`, `docs/backlog/good-to-have.md`.
**Today:** option (b) read *"mine a keyterm list from the corpus's own entity mismatches and
the judge's `keyDifferences`, feed it to the providers, and M-19b is unblocked without waiting
for Tune mode."* **That claim was mine, written into memo O-104 on 2026-09-09, and it is
wrong.** Corrected here rather than quietly dropped. Both named seams were measured before
anything was built:

```python
# R-20: what a keyterm list mined from this corpus would actually contain.
# Reads the live API only. Prints counts and terms; never a transcript.
import json, re, collections, difflib, urllib.request
API = "http://localhost:8177/api"
def get(p):
    with urllib.request.urlopen(API + p) as f: return json.load(f)

# --- seam 1: the judge's keyDifferences -----------------------------------
scans = get("/benchmark/agent/scans")
judged = [s for s in scans if s.get("judgeConfidence")]
kd = [s for s in scans if s.get("judgeKeyDifferences")]
spans = [d["span"].strip() for s in kd for d in s["judgeKeyDifferences"] if (d.get("span") or "").strip()]
def shape(t):
    if re.fullmatch(r"[\d\s\-.()#]+", t): return "digits-only"
    if any(c.isdigit() for c in t): return "mixed-with-digits"
    return "words"
words = [t.lower() for t in spans if shape(t) == "words"]
wc = collections.Counter(words)
print("scans %d  judged %d  with keyDifferences %d" % (len(scans), len(judged), len(kd)))
print("spans %d  distinct %d  |  shape %s" % (len(spans), len(set(t.lower() for t in spans)),
      dict(collections.Counter(shape(t) for t in spans))))
print("word-only spans %d  distinct %d  recurring(2+) %d"
      % (len(words), len(wc), sum(1 for v in wc.values() if v >= 2)))

# --- seam 2: entity mismatches --------------------------------------------
em = collections.Counter()
for s in scans:
    for m in ((s.get("hybridFlags") or {}).get("entityMismatches") or []): em[m["type"]] += 1
print("entityMismatch types %s" % dict(em))

# --- seam 3: recurring vocabulary the providers actually split on ----------
runs = get("/benchmark/runs?limit=200")
bycall = collections.defaultdict(dict)
for r in [x for x in runs if x.get("bulkId")]:
    for row in get("/benchmark/runs/%s/results" % r["id"]):
        if row.get("status") == "ok" and row.get("hypothesisTranscript"):
            bycall[row["callId"]][row["providerId"]] = row["hypothesisTranscript"]
CONV = [("gonna","going to"),("wanna","want to"),("alright","all right"),
        ("yeah","yes"),("ok","okay"),("cuz","because"),("kinda","kind of")]
def norm(t):
    t = t.lower()  # NB: the tokenizer below already splits on "-", so a
                   # hyphen fold here would be dead code (break test B).
    for a, b in CONV: t = re.sub(r"\b%s\b" % a, b, t)
    return t
disputed, seen = collections.Counter(), collections.Counter()
comparable = 0
for byp in bycall.values():
    if len(byp) < 3: continue          # 2 providers is not corroboration.
                                       # Unexercised on this corpus: every
                                       # call has 5 or 6 (break test C).
    comparable += 1
    toks = {p: set(re.findall(r"[a-z][a-z']{3,}", norm(t))) for p, t in byp.items()}
    for t in set().union(*toks.values()):
        seen[t] += 1
        miss = [p for p, s in toks.items() if t not in s]
        # near-variant guard: a missing provider that wrote something within
        # edit distance 1 split on SPELLING, not on vocabulary.
        if miss and any(not difflib.get_close_matches(t, toks[p], n=1, cutoff=0.86) for p in miss):
            disputed[t] += 1
print("calls with 3+ ok transcripts %d  |  tokens disputed in 3+ calls %d"
      % (comparable, sum(1 for v in disputed.values() if v >= 3)))
DIGITS = "zero one two three four five six seven eight nine".split()
print("digit-words, disputed/seen: %s"
      % {d: "%d/%d" % (disputed[d], seen[d]) for d in DIGITS if seen[d]})
print("top 6 by dispute count: %s"
      % {t: "%d/%d" % (n, seen[t]) for t, n in disputed.most_common(6)})
NOUNS = "edison hills mary".split()
print("proper nouns, disputed/seen: %s"
      % {w: "%d/%d" % (disputed[w], seen[w]) for w in NOUNS if seen[w]})
```

Output, 2026-09-09, against the live API:

```
scans 315  judged 65  with keyDifferences 61
spans 101  distinct 97  |  shape {'words': 82, 'digits-only': 4, 'mixed-with-digits': 15}
word-only spans 82  distinct 79  recurring(2+) 2
entityMismatch types {'phone_number': 76, 'reference_number': 18}
calls with 3+ ok transcripts 110  |  tokens disputed in 3+ calls 155
digit-words, disputed/seen: {'zero': '7/7', 'three': '14/14', 'four': '17/17', 'five': '12/12', 'seven': '12/12', 'eight': '10/10', 'nine': '9/9'}
top 6 by dispute count: {'whatever': '28/28', 'that': '19/67', 'help': '17/104', 'four': '17/17', 'hello': '16/33', 'three': '14/14'}
proper nouns, disputed/seen: {'edison': '6/24', 'hills': '3/11', 'mary': '13/92'}
```

**Seam 1 — the judge's `keyDifferences`: no vocabulary in it.** 315 scans, 65 judged, 61 carry
key differences — **101 spans, 97 distinct, and of the 82 word-only spans exactly 2 recur.** A
boost list only earns its place when the term comes back: you boost a property name because
every caller says it. 79 distinct one-off spans is not a vocabulary, it is 79 separate
arguments. And 15 of the 101 spans carry digits and 43 run four words or longer — a clause the
judge quoted, not a term any vendor's `keyterm` parameter accepts.

**Seam 2 — entity mismatches: the wrong material, not a small amount of the right material.**
94 mismatches across the whole corpus: `phone_number` 76, `reference_number` 18, `vin` 0.
`lib/scoring/src/hybrid.ts:245` extracts those three types and no others, and all three are
digit strings. No future call is helped by boosting a past caller's phone number. This seam
cannot fill — a bigger corpus produces more of the same unusable thing.

**Seam 3 — the one option (b) did not name, measured anyway.** If the mine has ore it is the
vocabulary the providers actually split on, so the scan looks for that directly: 110 calls with
three or more `ok` transcripts, **155 tokens disputed in three or more calls** after folding
the seven convention pairs and any near-variant within edit distance 1. The top of that list is
`whatever` 28/28, `that` 19/67, `help` 17/104, `hello` 16/33 — ordinary English a general model
already knows, where boosting changes nothing. The genuine proper nouns are present and thin:
`mary` 13/92, `edison` 6/24, `hills` 3/11. All three are the client's own names, already
readable from the assistant config without mining anything.

**What the measurement did find, and it is not keyterms.** The digit words split on nearly
every appearance: `zero` 7/7, `three` 14/14, `four` 17/17, `five` 12/12, `seven` 12/12,
`eight` 10/10, `nine` 9/9 — disputed in *every* call they occur in. That is Deepgram's
`numerals`, not a keyterm list, and `numerals` was read live on 2026-09-08 as unset on all 14
of the largest assistants (PRD v7, the corpus table). **Caveat on those counts:** the scan's
token pattern is `[a-z][a-z']{3,}`, so `one`, `two` and `six` were never in the token set at
all — the finding covers the seven digit words of four letters or more and understates the
effect rather than overstating it.

**Change:** none to code.
**Acceptance:** WHEN M-19b is picked up THEN its blocked reason SHALL name both walls — no
Tune-mode list, and no minable list inside the corpus either.
**Verify:** re-run the script above; every number in this block is one of its output lines.
**Must not:** ship a 79-term list of one-off spans and call M-19b unblocked.

**Break test.** Five mutations of the scan, each run against the same live data. Two of them
found nothing wrong with the conclusion and something wrong with the scan.

| # | Mutation | Expected | Observed |
| --- | --- | --- | --- |
| A | near-variant fold removed (`if miss:`) | count rises; the fold is doing work | 155 → **170** ✓ |
| B | hyphen fold removed (`t.lower()` alone) | count rises | **155 → 155, no change.** The fold was dead code: the tokenizer `[a-z][a-z']{3,}` never keeps a `-`, so `one-bedroom` was already two tokens before it ran. Line removed from the script above. |
| C | two-provider calls admitted (`< 2`) | count rises | **155 → 155, no change.** Every call in this corpus carries 5 or 6 `ok` transcripts, never 2. Right policy, untested by this data; noted in the script. |
| D | convention pairs dropped (gonna, wanna, alright…) | count rises | 155 → **159** ✓ |
| E | read `keyDifferences` instead of `judgeKeyDifferences` | seam 1 reports nothing | 61 → **0** ✓ |

> **What was learned.** *An empty result and a wrong field name are the same shape from the
> outside.* Mutation E is not hypothetical — the first run of this scan really did report zero
> scans carrying key differences, and the next sentence I nearly wrote was "the judge never
> returns them." The wire field is `judgeKeyDifferences`; `keyDifferences` is what the BAML
> class calls it and what `call-comparison.ts:339` renames it back to on a different endpoint.
> **A mining scan that finds nothing has to be proved capable of finding something before
> "nothing" is allowed to be the finding.**
>
> **The break test audited the scan, not only the conclusion.** B and C changed no number at
> all: two of five filters were doing no work — one dead outright, one never reached by this
> corpus — and both had been written because they sounded like the careful thing to do. The
> answer would have been identical without them, which means they were never evidence of care,
> only its appearance. *A filter you cannot make change the answer is not a safeguard.*
>
> **And why (b) fails, stated as the rule it is.** The most-disputed tokens in this corpus are
> `whatever`, `that`, `help`, `hello` and the spelled digits — the providers are not
> disagreeing about *which* words were said, they are disagreeing about *how to write* the
> words they all heard. A keyterm boost only ever answers the first question. **Match the
> parameter to the kind of disagreement you measured, not to the one you hoped to find** — this
> corpus argues for `numerals`, and it argues against the list I proposed yesterday.

---

### R-21 — The one gold transcript cannot be erased by a typo

**Status:** done 2026-09-09 (PR #146)

**What it taught:** the step as written in O-103 was "no gold **or status**
guard". Half of it had to be refused. Imported calls land at `ready_to_run`
with no gold on purpose, so a guard tying status to gold would refuse the
normal import path — and it would have looked, in a diff, exactly like the
careful thing to do. *The half of a bug report that names a second missing
check is not automatically a second bug.*

**And the break test found a hole it could not close.** Mutating the route to
spread `body.data` — flag included — straight into `db.update(...).set(...)`
broke nothing: all 170 tests passed. Probed directly against the test database
rather than inferring: `.set({ notAColumnAtAll: "xyz" })` throws nothing and
the real field still updates. **A typo'd column name in any `.set()` in this
repo is a silent no-op**, and no test that reads the response can see it,
because every response is built by a `serialize*` function from the row and
not from what was sent. The destructure stays — it is the honest expression of
"this is a request flag, not a field" — but it is not load-bearing today and
no test can make it so. Logged in `docs/backlog/good-to-have.md` as its own
scan, since it is repo-wide.

One mutation of the five was invalid and had to be caught and redone: deleting
the `confirmClearGold !== true` line left a dangling `&&`, so the file did not
compile and the run reported "3 passed" — a *collection* failure wearing a
result's clothes. **A break test that reports far fewer tests than the baseline
has not been passed or failed; it has not run.** Compare the total, not only
the failure count.

The other four all caught it: dropping the `.trim()` lets `"   "` through
(1 failed), ignoring the flag refuses the confirmed clear (1 failed), dropping
the before-check refuses a call that never had gold (1 failed), and disabling
the guard entirely fails 2. Restored: 170 passed, tree clean.

**PR:** one. Spends nothing.
**Depends on:** R-17 (which is what left the labelled set at one call).
**Files:** `artifacts/api-server/src/routes/benchmark.ts`,
`lib/api-spec/openapi.yaml`,
`artifacts/api-server/src/routes/__integration__/calls-write.int.test.ts`

**Today:** `PATCH /benchmark/calls/:callId` (`routes/benchmark.ts:565`)
validates the body and spreads it straight into the update. `goldTranscript`
is a plain optional string and nothing reads what it was, so
`{"goldTranscript":""}` is an ordinary, accepted request. R-17 cleared the
fragment gold and left exactly one labelled call, so that one request empties
the entire labelled set — the set every proxy-agreement and MEASURABLE_FLOOR
sentence in `docs/PRD-v7-decide.md` rests on. R-19 found this (memo O-103).

The clear that was *meant* to happen did not go through this route. It went
through a one-off script guarded by the SHA-256 of the exact text it expected
to find, which refuses rather than deleting work it has not read. That is the
friction a destructive edit deserves, and the API has none of it.

**Change:** the route refuses, with **409**, to replace a non-empty gold with
one that is empty, unless the body carries `confirmClearGold: true`. The test
is on the *resulting state*, not on the literal sent: a string that trims to
empty is a clear, whitespace included. Everything else about the route is
untouched, and `confirmClearGold` is a request flag only — it never reaches
the row.

**Deliberately not built: the status half of O-103.** Imported calls land at
`ready_to_run` with no gold on purpose (`routes/benchmark.ts:406-408`), and
the de-identification gate that used to guard that status was removed on
2026-08-27 by Abhishek's explicit decision. A guard tying status to gold would
refuse the normal import path. Status answers whether a call may be *run*;
gold answers whether it can be *scored*. Wiring them together would be a new
rule wearing a safety rule's clothes.

**Acceptance:** WHEN a call has a non-empty gold AND the request would leave it
empty AND `confirmClearGold` is absent or false THEN the API SHALL answer 409
AND the stored gold SHALL be unchanged; AND WHEN `confirmClearGold` is true
THEN the clear SHALL proceed and the `audit_log` row SHALL carry the old text
in its before state; AND WHEN the stored gold is already empty THEN no
confirmation SHALL be required.
**Verify:** `pnpm run typecheck`; the integration suite; the break test writes
`{"goldTranscript":""}` against a call with gold and expects 409, and a second
mutation removes the trim so `"   "` slips through.
**Must not:** block an edit that replaces a non-empty gold with a different
non-empty gold; write `confirmClearGold` to the row; change what any status
means; touch the de-identification columns.

---

### R-22 — The twelve P0/P1 findings R-19 proved live get fixed, one PR each

**Status:** done 2026-09-10 (R-32). Campaign header; each row below ships as its own step and its own PR.
**PR:** this one is docs only and spends nothing. The twelve that follow are code.
**Depends on:** R-19, which read them and deliberately fixed none of them.
**Files:** `docs/step-register.md`.

**Today:** R-19 triaged the never-cited P0/P1 tranche and stopped there, on purpose --
*"a triage that also fixes is a triage nobody can check."* That was right, and it left
twelve confirmed defects sitting untouched. Meanwhile every check this repo owns is
green: `pnpm run typecheck` clean, api-server 189 unit + 170 integration, UI 174,
and all five structural checks pass. **A green suite is not a claim that the system is
correct. It is a claim that the system does what its tests say, and none of these twelve
has a test.** That gap is the whole content of this step.

Each line below was re-read at HEAD `f026be0`, not inherited from R-19's table:

| entry | what is wrong | verified at `f026be0` |
|---|---|---|
| B-5 | a presigned audio URL, query string and all, is interpolated into a thrown error that gets persisted as `errorMessage` | `lib/stt-providers/src/types.ts:147` |
| B-12 | `writeAudit` is a bare `await db.insert`; an audit failure rejects the caller after the work committed | `artifacts/api-server/src/lib/audit.ts:21` |
| B-21 | a Cartesia socket that closes non-1000 *after* finalize is sent returns `ok` with a truncated transcript | `lib/stt-providers/src/adapters/cartesia.ts:471` |
| B-6 | `alreadyOk` is `status === "ok"` alone, not "has a score row", so an orphan ok row skips a cell forever | `artifacts/api-server/src/lib/run-executor.ts:377` |
| B-7 | `runningRuns.add(runId)` happens before `pool.connect()`, which is outside the `try`; a connect rejection bricks the id until restart | `artifacts/api-server/src/lib/run-executor.ts:237-239` |
| B-17 | the create form mints `${base}-${randomUUID().slice(0,6)}` against a registry that looks up by exact key | `artifacts/api-server/src/routes/benchmark.ts:1195` |
| B-18 | the documented base URL already ends in `/api` and the client only strips trailing slashes | `.github/workflows/deploy-web.yml:13`, `lib/api-client-react/src/custom-fetch.ts:29` |
| B-13 | an error on refetch swaps the whole list body out | `artifacts/stt-benchmark/src/pages/Corpus.tsx:441` |
| B-19 | `normalizeEntity` does NFKC then `[^A-Z0-9]`, with no NFD -- `"CAFÉ"` normalises to `"CAF"` | `lib/scoring/src/core.ts:223-231` |
| B-20 | entity match is a bare `includes()`, so `"CAT"` scores correct inside `"CATALOG"` | `lib/scoring/src/core.ts:349` |
| B-4 | `app.use(cors())` with no origin list, which is what makes the `x-actor` header forgeable from any page | `artifacts/api-server/src/app.ts:29` |
| B-3 | Vercel builds from the sub-package, whose `workspace:*` and `catalog:` specs only resolve from the repo root | `.github/workflows/deploy-web.yml:62` |

**Order, and why.** The first eight change no measured number: they are wrong answers,
leaks and stuck state, and each can be proved with a test that fails before the fix.
**B-19 and B-20 are different in kind** -- both change entity accuracy on every call
already scored, so each ships with the before/after counts printed from the real corpus
in its own step, never as a silent recount. B-4 and B-3 land last because both change
how the thing is reached rather than what it computes, and B-3 cannot be proved without
a real deploy.

**Correction to R-19.** That table's B-11 row read **"live, and wider than written."**
It is no longer live: R-21 (PR #146) put the guard in at `artifacts/api-server/src/routes/benchmark.ts`,
and a `{"goldTranscript":""}` against the one call that has gold now answers 409. The row
was true when it was written and is recorded here rather than edited there.

**Acceptance:** WHEN this step closes THEN each of the twelve SHALL be either fixed with
a test that fails without the fix, or carry a written reason it was not.
**Verify:** each row's file:line re-read before its own PR opens -- these were true at
`f026be0` and the twelve PRs move each other's lines.
**Must not:** fix more than one row per PR; fix an adjacent thing seen while in the file;
change what B-19 or B-20 score without printing the before and after; treat this header
as permission to skip the grill on any individual row.

---

### R-23 — A presigned recording URL stops being persisted into an error row (B-5)

**Status:** done 2026-09-10 (PR #148). First of R-22's twelve. Deployed: healthz
`commitSha dfbaff3dd399`.
**PR:** one. Spends nothing; changes no measured number.
**Depends on:** R-22.
**Files:** `lib/stt-providers/src/types.ts`, new file lib/stt-providers/src/redact-url.test.ts.

**Today:** `fetchAudioBytes` interpolates the whole audio URL into the error it
throws (`lib/stt-providers/src/types.ts:147`). Vapi's recording links are presigned --
the signature, the access key id and the expiry all live in the query string. That
sentence does not stay in a log. `run-executor.ts:678` writes it verbatim into
`benchmark_scores.error_message`, and the results route serves that column to the
browser, so a credentialed URL is **stored in the database and rendered in the UI**,
and stays in the row long after the signature expires. One site: a scan for a URL
interpolated into any thrown or logged string across `lib` and `artifacts` returns
this line and nothing else.

**Change:** a `redactUrlForMessage` helper next to the thrower. Keep `origin` +
`pathname`, which still name the object well enough to debug with; drop the query, the
fragment and the userinfo, and append `(credentials redacted)` only when there was
something to drop, so a clean URL does not grow a scary suffix.

**Three things the obvious version gets wrong**, and each has a test:

- `URL.origin` already excludes `user:pass@`, but a reviewer cannot see that from the
  call site, so **userinfo is asserted separately** rather than assumed. A
  password with no username leaves `username` empty and sets `password`; the origin
  drops it either way, so this only decides whether the suffix tells the truth.
- `data:` and `blob:` are not locators. A `data:` URI's path **is the audio**, and
  `audio-cache.test.ts` feeds exactly those, so echoing a path there would put caller
  bytes into a persisted error row. Non-http(s) schemes return `${protocol}<redacted>`.
- This runs **inside a catch**. A helper that throws on a malformed URL would replace a
  provider failure with a different, wrong one, so a parse failure returns a placeholder
  and never the input.

**And the helper being right is not the fix.** A test that only exercises
`redactUrlForMessage` stays green if someone reverts the call site, so the suite also
asserts on the message `fetchAudioBytes` actually throws, with `fetch` stubbed to a 403.

**Acceptance:** WHEN `fetchAudioBytes` fails on a presigned URL THEN the thrown message
SHALL contain the host and path AND SHALL contain no part of the signature, access key
or expiry; AND WHEN the URL is a `data:` URI THEN no part of the payload SHALL appear.
**Verify:** `pnpm run typecheck`; `pnpm --filter @workspace/stt-providers test`, which CI
already runs (`.github/workflows/ci.yml:91`); the break test restores the raw
`${audioUrl}` and expects the signature assertion to fail.
**Must not:** redact the host or path, which are what make the failure diagnosable;
change the failure class or the retry decision, both of which read `httpStatus`, not the
sentence; touch any other error message while in this file.

---

### R-24 — B-12's proper fix is a transaction, not a wrapper, so it is split not shipped

**Status:** blocked — needs Abhishek to pick between two answers that are not equivalent.
**PR:** none yet. The grill is the deliverable.
**Depends on:** R-22.
**Files:** none changed.

**Today:** `writeAudit` is a bare `await db.insert` (`artifacts/api-server/src/lib/audit.ts:21`),
called from **30 sites**. Every route has the same shape: the mutation commits via
`.returning()`, *then* the audit is written, *then* the response is sent. If the audit
insert throws, `jsonErrorHandler` turns it into a 500 — so **the work happened and the
caller is told it did not.** Exactly one call site guards it: `auditOrLog` in
`lib/agent-verify.ts:32` (T-37).

**Why the obvious fix is wrong.** T-37's wrapper swallows and logs, on the stated ground
that *"an audit row is a record OF the scan, not the scan."* True there. **Not true
everywhere.** For the PATCH that clears a gold transcript, the audit row is the only
place the old gold text survives — R-21 shipped an error message that says so in as many
words. Wrapping all 30 sites in `auditOrLog` would silently convert R-21's guarantee into
a best-effort one, and the diff would look like defensive hygiene.

**The two answers.**

1. **Swallow and log**, T-37's pattern, at all 30 sites. One small PR. Cost: an audit row
   can be lost with only a log line to show for it, and for the gold route that is the
   permanent loss of the old text. Weakens NFR-5.
2. **Write the audit inside the mutation's transaction.** Either both land or neither
   does, the response never lies, and no audit is ever lost. This is the correct answer
   and it is **not a micro-PR** — it is 30 call sites, most of which are not in a
   transaction today. Under the standing rule it wants a worktree.

**Recommendation: (2), staged** — start with the routes where the audit row is the only
copy of something (gold clear first), leave the rest until that shape is proven.
Nothing here is fixed until that call is made, because either choice is easy to write and
only one of them is right.

**Must not:** wrap all 30 sites "for now"; treat the 500-after-commit as the whole bug,
when the lost audit row is the half that cannot be retried.

---

### R-25 — B-21 is real, and both the register's fix and the vendor's docs would get it wrong

**Status:** open — the fix is known and grounded; shipping it changes 16 existing rows,
so it needs a go on what happens to them.
**PR:** none yet.
**Depends on:** R-22.
**Files:** none changed. Measurement only.

**Today:** the Cartesia close handler only records an error when `!finalizeSent`
(`lib/stt-providers/src/adapters/cartesia.ts:471`). After finalize, a truncated session
falls through to `ok` with whatever partial text arrived. The adapter's own header comment
(`:21-26`) says the finalize/close handshake was *"reasonable given the docs, not confirmed
live."*

**It is now confirmed live, and it overturns two proposed fixes.** Read from the 186
Cartesia rows on the dev database — message types and counts only, no transcript text:

```
rows: 186 | rawOutput stored as a JSON string: 178 | unparsable: 24
message types: transcript 2950, flush_done 145
wsCloseCode: 1000 on all 162 rows that recorded one
ok rows: 161 | ok without flush_done: 16 | rows with "done": 0
```

- **B-21's own stated fix — check the close code — would catch nothing.** Every row that
  recorded a code recorded `1000`. Truncation here is not visible at the socket layer.
- **The vendor docs' terminal marker would break every run.** Cartesia acks `finalize`
  with `flush_done` and `close` with `done`. `flush_done` arrives for real, 145 times.
  **`done` never arrives at all** — the adapter sends `close` and hangs up before the ack
  can land. Gating on `done`, which is what the documentation reads like it wants, would
  fail 100% of Cartesia runs.
- **The correct gate is `flush_done`, and the bug is real: 16 of 161 `ok` rows — 9.9% —
  never received it.** Those are truncated transcripts sitting in the corpus scored as
  good ones.

**The open question, which is Abhishek's:** the fix flips those 16 from `ok` to failed.
Do they get re-run (Cartesia spend, needs a go-spend), left as-is with the old rows
untouched and only new runs held to the rule, or marked without re-running?

**Also found, unrelated to B-21 and not fixed here:** `rawOutput` is persisted as a JSON
**string** inside a jsonb column on 178 of 186 rows — double-encoded — and 24 rows do not
parse at all. Logged to `docs/backlog/good-to-have.md`, not fixed in this step.

> **What was learned.** *Measuring beat both authorities.* The bug register named a fix
> that catches none of it, and the vendor's own documentation named a marker that would
> have failed every run — and either would have looked careful in a diff. The only thing
> that told the truth was 186 rows of what the server actually sent.

**Must not:** gate on `done`; gate on the close code; change those 16 rows without a
decision on re-running them.

---

### R-26 — A cell that was paid for but never scored stops being invisible (B-6)

**Status:** done 2026-09-10 (PR #150).
**PR:** one. Spends nothing today, and provably so.
**Depends on:** R-22.
**Files:** `artifacts/api-server/src/lib/run-executor.ts`,
new file artifacts/api-server/src/lib/cell-resumption.ts,
new file artifacts/api-server/src/lib/cell-resumption.test.ts,
`artifacts/api-server/src/routes/__integration__/run-executor-disabled.int.test.ts`.

**Today:** `alreadyOk` is built from `status === "ok"` alone. The resumability argument
rests on ok meaning **scored** — the stale-row comment a few lines below says so outright:
*"only 'ok' rows have scores, and 'ok' rows are never in this set."* T-27's `replaceOk`
keeps that true whenever this process catches a scoring failure. A hard kill between the
result insert and the score insert does not go through that catch: the cell is left `ok`
with no score, billed, absent from every ranking, and skipped by every later retry.

**Measured before touching a spend path.** Across the dev database: **876 result rows,
769 of them `ok`, and exactly 0 with no score row.** T-27 holds. So this is a latent
crash window, not an active defect, and the change is a provable no-op on today's data —
which is what makes it safe to make in the one function that spends money.

**The trap in the obvious version.** Tightening `alreadyOk` alone would be *worse than
the bug*. `upsertResult` defaults to `setWhere: ne(status, "ok")`, so a surviving ok row
refuses the update: the cell would be sent to a paid provider and its answer thrown away.
The fix therefore also puts the unscored ok row into the **stale set that is cleared
before re-attempting**, which cannot orphan a score precisely because there is none.
The existing test at `run-executor-disabled.int.test.ts:147-151` already documented this
exact upsert behaviour — it was known, and nothing connected it to `alreadyOk`.

**Testability.** The executor cannot be driven in the suite: that needs a `ready`
provider, and a ready provider in a test spends real money. So both decisions moved into
`cell-resumption.ts` as pure functions and are unit-tested there. The integration test
uses a **disabled** provider, so the re-attempt is free and what is asserted is only that
the cell is treated as live at all.

**And an existing fixture was asserting the weaker meaning by omission.** The R-13 test
"leaves a cell that already succeeded alone" seeded an `ok` row with **no score row** and
called it *"the realistic shape"*. It was not: the score row is part of that shape. The
fixture now writes one, and a companion test covers the case it had been standing in for.

**Acceptance:** WHEN a result row is `ok` and owns no `benchmark_scores` row THEN the
executor SHALL treat its cell as live AND SHALL clear the row before re-attempting; AND
WHEN the row is `ok` and scored THEN it SHALL be skipped and left untouched.
**Verify:** `pnpm run typecheck`; api-server unit (198) and integration (171); the break
test restores `status === "ok"` in each of the two decisions separately.
**Must not:** overwrite the unscored ok row instead of clearing it; clear a
permanently-failed row (T-43 — its row is the only record the cell was tried); change
what happens to a scored ok row.

---

### R-27 — A transient connect failure stops bricking a run until restart (B-7)

**Status:** done 2026-09-10 (PR #151). Deployed: healthz `commitSha 63569b4cf0b0`.
**PR:** one. Spends nothing.
**Depends on:** R-22.
**Files:** `artifacts/api-server/src/lib/run-executor.ts`, `lib/db/src/index.ts`,
`artifacts/api-server/src/routes/__integration__/run-executor-disabled.int.test.ts`.

**Today:** `executeBenchmarkRun` does `runningRuns.add(runId)` and then
`await pool.connect()` — **outside** the `try` whose `finally` is the only place that
deletes from the Set. R-19 recorded B-7 as *narrowed* because the unlock, release and
delete all moved into `finally`; the connect never did. So a pool exhaustion or a
momentary database outage leaves the id in `runningRuns` **for the life of the process**.
Every later execute for that run takes the "already running" branch at the top, logs a
warning and does nothing. The run is bricked in-process by a transient failure, and the
only cure is a restart.

**Change:** the connect moves inside the same `try`, and `lockClient` becomes nullable so
the `finally` can tell "never connected" from "connected". That is the whole fix — the
cleanup was already correct, it simply did not cover the first await.

**Testability, and why a seam was added rather than a mock.** `executeBenchmarkRun`
already carries `opts.audioResolver`, which exists in its own words *"purely so
tests/rehearsals can substitute a deterministic resolver"*. A test cannot make the real
pool refuse a connection without breaking every other test sharing it, so `opts.connect`
follows that exact precedent and production callers omit it. The test overrides it for
the **failing call only**; the second call uses the real pool, and the provider stays a
disabled Fixtures provider, so nothing is spent. That is recorded as safety note 4 in the
file's header block.

**One type had to move.** `pool.connect()` is overloaded — it also takes a callback and
returns `void` — so `Awaited<ReturnType<typeof pool.connect>>` widens to
`void | PoolClient` and will not typecheck. `pg` is a dependency of `lib/db` and not of
its consumers, so `DbPoolClient` is re-exported from `lib/db/src/index.ts` rather than
importing `pg` across the package boundary and relying on hoisting.

**Not fixed here:** B-7's sibling, that the pool has no `connectionTimeoutMillis`, so
`pool.connect()` can pend forever rather than reject. This step makes a **rejection**
survivable; it does nothing about a hang. Separate change, separate step — and a wrong
timeout value is its own outage.

**Acceptance:** WHEN acquiring the lock connection rejects THEN the error SHALL propagate
AND the run SHALL remain executable by a later call.
**Verify:** `pnpm run typecheck`; api-server integration (172) and unit (198); the break
test moves the connect back outside the `try`.
**Must not:** swallow the connect error; add a connection timeout in this step; let
`opts.connect` reach any production call site.

---

### R-28 — The create form stops minting providers that can never run (B-17)

**Status:** done 2026-09-10 (PR #152). Deployed: healthz `commitSha 994df29a2795`.
**PR:** one. Spends nothing.
**Depends on:** R-22.
**Files:** `artifacts/api-server/src/routes/benchmark.ts`, `lib/api-spec/openapi.yaml`,
the generated clients, `artifacts/api-server/src/routes/__integration__/providers-write.int.test.ts`.

**Today:** `POST /benchmark/providers` mints
`` `${name}-${model}`.slug + "-" + randomUUID().slice(0,6) ``. Nothing resolves that id.
`getProviderApiModel` strips the vendor prefix and sends **whatever remains** as the model
string, so a row created here asks the vendor for `nova-3-a1b2c3`. Every cell of every run
that includes it fails, the row looks entirely ordinary in Setup, and there is no delete.

**Measured:** 12 provider rows on the dev database, **none** with a random tail — every
live row came from the seed or catalog path. So B-17 has never actually fired. It is a
loaded footgun on a form the UI exposes, not damage already done.

**The UI's own help text is part of the bug.** The Provider Name field says
*"Must match a registered adapter id exactly (e.g. deepgram-nova-3, elevenlabs-scribe)."*
Follow that exactly — name `deepgram-nova-3`, model `nova-3` — and the route builds
`deepgram-nova-3-nova-3-<hex>`, whose derived model string is `nova-3-nova-3`.
**The form asks for something it cannot accept.**

**Change:** the id becomes `providerIdForModel(vendor, model)` — the function already
documented as *"stable, so enabling the same model twice finds the same row"* — and the
vendor half must be a vendor this build has an adapter for. That pairing is what makes the
derived model string exactly the model that was typed. Unknown vendor is **400**, naming
the vendors that exist and what the name was read as; an existing row is **409** instead
of a second id for the same thing.

**A second test was pinning the defect.** The create test asserted the six random hex
characters and then said the quiet part in its own comment: *"No adapter answers to this
id, so it can never be 'ready' however it was asked for."* It described a dead row and
called it the expected result. Rewritten to assert the stable id, that an adapter resolves
it, and that `getProviderApiModel` returns the model that was sent. `status` is
deliberately **not** asserted — FR-P3 re-derives it from adapter plus key presence, so it
depends on the environment the suite runs in, not on this route.

**Not fixed here: the UI help text**, which now describes something the API refuses. It is
UI copy, and the standing rule is that `visual-and-research` runs before UI copy work.
Logged in `docs/backlog/good-to-have.md` as its own step.

**Acceptance:** WHEN a provider is created THEN its id SHALL resolve to a registered
adapter AND `getProviderApiModel` SHALL return exactly the model that was sent; AND WHEN
the name is not a known vendor THEN the row SHALL be refused with 400; AND WHEN the vendor
and model already have a row THEN the request SHALL be refused with 409.
**Verify:** `pnpm run typecheck`; `node scripts/check-api-routes.mjs`; api-server
integration (175) and unit (198); UI (174).
**Must not:** keep the random suffix as a fallback; accept a full provider id in the name
field; assert `status` in the create test; change the UI copy in this step.

---

### R-29 — The documented API base URL stops being one that cannot work (B-18)

**Status:** done 2026-09-10 (PR #153). No deploy: nothing is hosted on Vercel (T-68).
**PR:** one. Spends nothing. No API change.
**Depends on:** R-22.
**Files:** `.github/workflows/deploy-web.yml`, `artifacts/stt-benchmark/src/lib/api-base.ts`,
`artifacts/stt-benchmark/src/main.tsx`,
new file artifacts/stt-benchmark/src/lib/api-base.test.ts.

**Today:** `.github/workflows/deploy-web.yml:13` documents
`VITE_API_BASE_URL -- e.g. https://stt-api.example.com/api`. Every generated operation
path **already** starts with `/api` — orval bakes the spec's `servers: [{url: /api}]` into
each one, confirmed by reading the generated client, not assumed. So the documented value
makes every request `https://host/api/api/benchmark/...` and every one of them 404s.
`custom-fetch.ts:29` strips trailing slashes and nothing else, so nothing catches it.

**The code already knew.** `main.tsx` says *"point every generated API call at the API
**origin**"*. The workflow beside it documents an origin plus a path. Two files, one
contract, and only one of them right — which is exactly the shape that survives review,
because each reads fine alone.

**Change:** correct the workflow comment, and add `checkApiBaseUrl`, which reports the
mistake once at bootstrap instead of leaving it to be inferred from N failed requests.

**The trailing `/api` is deliberately NOT stripped.** Stripping would silently rewrite a
value the operator chose, and from inside the browser there is no way to tell a typo apart
from an API genuinely mounted under a path. Reporting is honest; rewriting is a guess that
looks like a fix. The value is passed to `setBaseUrl` exactly as given.

**And the check is not "contains /api".** A host that merely has `api` in its name, or a
real sub-path that is not `/api`, is none of this function's business — both are pinned by
tests so a later tightening cannot quietly break a valid deploy.

**Acceptance:** WHEN `VITE_API_BASE_URL` ends in `/api` THEN the app SHALL report why at
bootstrap AND SHALL still use the value as given; AND WHEN it is unset or blank THEN
nothing SHALL be reported, because same-origin is a supported deploy.
**Verify:** `pnpm run typecheck`; UI suite (181); the break test makes the check accept the
documented value.
**Must not:** strip or rewrite the base URL; report on a host that merely contains `api`;
throw at bootstrap, which would replace a broken API with a blank page.

**Not verifiable here:** nothing is hosted on Vercel today (T-68 made that workflow
manual-only and no `VERCEL_*` secrets exist), so the fix cannot be proved by a deploy. What
is proved is the contract the code enforces.

---

### R-30 — An accent stops deleting the letter under it (B-19), and B-20 is refused

**Status:** done 2026-09-10 (PR #154).
**PR:** one. Spends nothing. **Changes no number on today's corpus, and that is measured
below rather than hoped for.**
**Depends on:** R-22.
**Files:** `lib/scoring/src/core.ts`,
new file lib/scoring/src/normalize-entity-diacritics.test.ts.

**Today:** `normalizeEntity` does NFKC, upper-cases, then strips `[^A-Z0-9]`. NFKC keeps
an accented letter as **one precomposed codepoint**, so the strip removes the whole
character rather than just the accent: `"CAFÉ"` becomes `"CAF"`, `"MÜLLER"` becomes
`"MLLER"`.

**The damage is on the hypothesis side, not the entity side.** Both go through the same
function, so an entity `"Muller"` normalises to `"MULLER"` while a provider that
transcribed the name *correctly* as `"Müller"` normalises to `"MLLER"` — which does not
contain it. **A right answer scored wrong.** Reading the entry as "diacritics are stripped
from entities" understates it; the entity list is the half that happens to be clean.

**Measured before and after, on the real corpus:**

```
entity references in the corpus: 25   with non-ASCII: 0   normalisation changed: 0
scored cells:                   769   hypotheses with non-ASCII: 61
entity checks:                  120
correct before: 101   correct after: 101
became correct: 0   became wrong: 0   cells affected: 0
```

**Zero rankings move.** The 61 non-ASCII hypotheses are real, but none of them belongs to
a call that carries entity references, so nothing is being mis-scored *today*. This is a
correctness fix against the next accented name in the corpus, not a recount of the last
one — which is exactly the claim R-22 said this pair had to make with numbers attached.

**Change:** `NFD` after upper-casing, and nothing else. An explicit `\p{M}` strip was
written first and taken out again — the existing `[^A-Z0-9]` strip already removes the
combining mark NFD splits off, so the extra line was genuinely redundant. **The break test
is what proved it:** removing `\p{M}` failed nothing, because the two versions are
indistinguishable. A line no test can reach is a line that will drift, so it went.

A value with no Latin form at all — a non-Latin script, an emoji — still normalises to
`""`, exactly as before, and `scoreEntities` still guards that with `normalized.length > 0`
so it can never match anything.

**B-20 is refused, and here is why.** B-20 asks for a word-boundary on the entity match
(`"CAT"` should not count inside `"CATALOG"`). But `entitySeparators` is stripped **before**
the alphanumeric filter, so a normalised hypothesis is a single space-less run by
construction — there are no boundaries left to respect. That is not an oversight: it is the
entire purpose of the function, pinned by its own test, *"matches across separators, which
is the whole reason for normalizeEntity"*, so that `"A-1-2-3"` matches `"A123"`. Adding a
boundary check to the normalised string cannot work, and adding one against the original
text is a different function with a different contract. **A boundary rule and
separator-insensitivity cannot both hold at this layer.** Recorded here rather than
half-built; if the false-positive rate matters it needs its own step and its own measurement
of how often a short entity is a substring of a longer real word.

**Acceptance:** WHEN an entity or a hypothesis contains an accented Latin letter THEN the
accent SHALL be folded to its base letter AND the letter SHALL survive; AND WHEN a value has
no Latin form THEN it SHALL normalise to `""` and never count as a match.
**Verify:** `pnpm run typecheck`; `pnpm --filter @workspace/scoring test` (183); the
before/after probe above, re-run; the break test removes `NFD` (5 failed) and drops the
`normalized.length > 0` guard (1 failed).
**Must not:** add a word boundary to the entity match; change what a non-Latin value
normalises to; alter `normalizeTranscript`, which is a different function with its own
callers.

---

### R-31 — The API stops telling every website it may read the corpus (B-4)

**Status:** done 2026-09-10 (PR #155). Deployed and verified live: `commitSha 4e539e0d983d`.
**PR:** one. Spends nothing.
**Depends on:** R-22.
**Files:** `artifacts/api-server/src/app.ts`,
new file artifacts/api-server/src/lib/cors-origins.ts,
new file artifacts/api-server/src/lib/cors-origins.test.ts,
new file artifacts/api-server/src/routes/__integration__/cors.int.test.ts.

**Today:** `artifacts/api-server/src/app.ts:29` is `app.use(cors())`, which answers every
request with `Access-Control-Allow-Origin: *`.

**What that actually allows, spelled out.** This API has **no auth at all** (B-1, still
open), listens on localhost (M-3), and `GET /benchmark/calls` serves `goldTranscript`,
`draftTranscript` and an audio redirect. With `*`, any page the operator happens to visit
can run one `fetch("http://localhost:8177/api/benchmark/calls")`, read **every caller
transcript**, and post it somewhere else. No click, no prompt, nothing on screen. Being
bound to localhost does not help: the operator's own browser is on localhost.

**Change:** an explicit allowlist — the vite dev and preview origins this repo actually
serves the UI from, plus `WEB_ORIGINS` (comma-separated) for split hosting.

**Three decisions inside it, each with a test:**

- **A request with no `Origin` header is still allowed.** CORS is a browser rule. `curl`
  and the deploy script's healthz check send no Origin, and a non-browser client sets
  whatever Origin it likes — refusing them would break real callers while stopping no
  attacker. Pretending otherwise would be security theatre.
- **Exact comparison, never prefix or substring.** `https://stt.example.com.evil.test` and
  `https://evil-stt.example.com` are refused, and so is a different port or scheme on an
  allowed host. A substring check here would be **worse than none**, because it would read
  as careful.
- **Refusal omits the header rather than throwing.** Throwing becomes a 500, which reads as
  "the server is broken" instead of "this origin may not read this". The browser blocks the
  read either way.

**This does not close B-1.** Nothing here authenticates anybody; it removes a wildcard that
should never have been there. Said plainly in the file header so a later reader does not
mistake this for auth.

**Acceptance:** WHEN a request carries an Origin that is not allowlisted THEN the response
SHALL carry no `Access-Control-Allow-Origin` header AND SHALL NOT be a 500; AND the header
SHALL never be `*`; AND WHEN a request carries no Origin THEN it SHALL be answered normally.
**Verify:** `pnpm run typecheck`; api-server unit (206) and integration (181), the latter
asserting the real response headers through the app rather than the helper alone.
**Must not:** allow by prefix or substring; refuse a request that has no Origin; throw from
the origin callback; claim this fixes B-1.

---

### R-32 — The last two of R-22's twelve get a written reason instead of a fix

**Status:** done 2026-09-10. Closes R-22.
**PR:** one, docs only.
**Depends on:** R-22 … R-31.
**Files:** `docs/step-register.md`, `docs/backlog/good-to-have.md`.

R-22 said each of the twelve would be *"either fixed with a test that fails without the
fix, or carry a written reason it was not."* Seven were fixed (R-23, R-26 … R-31), one was
refused on the merits (B-20, in R-30), two are blocked on a decision (B-12 in R-24, B-21 in
R-25). These are the last two, and neither is a fix I can honestly make today.

**B-13 — `Corpus.tsx:441` swaps the whole list body out on a refetch error.** Real: react-query
keeps `data` when a background refetch fails, so a still-good list is thrown away and replaced
by an error row over a transient blip. **The minimal fix is a trap.** Gating on
`isError && !calls` keeps the rows — and makes a failed refresh completely silent, which
trades a loud wrong behaviour for a quiet one. The honest fix is rows-plus-a-non-blocking
"couldn't refresh" affordance, and that affordance is **copy**. The standing rule is that
`visual-and-research` runs before UI copy and label work, so this waits for that pass rather
than being half-built now. It is queued there with R-28's Provider Name help text, which is
the other copy debt this campaign turned up.

**B-3 — Vercel builds from the sub-package.** Confirmed structurally, not by running it:
`.github/workflows/deploy-web.yml:62` runs `vercel deploy` with
`working-directory: artifacts/stt-benchmark`, so only that directory is uploaded, and its
`package.json` resolves 19 dependencies through `catalog:` and `workspace:*` — specs that
only exist in the repo root's `pnpm-workspace.yaml`. The remote build cannot install.

**It cannot be fixed and proved today, and fixing it unproved is the worse option.** T-68
made that workflow manual-only *because* no `VERCEL_*` secrets exist and nothing is hosted
on Vercel. The fix — deploy from the repo root with a `rootDirectory`, or build in CI and
push with `--prebuilt` — is a real change to a pipeline that has never run once. Changing an
untested deploy path on reasoning alone is how you get a second bug that looks like a fix.
It waits for someone to actually want Vercel hosting.

> **What the campaign taught.** *Three of the twelve were being held in place by their own
> tests.* The R-13 fixture seeded an `ok` result row with no score row and called it
> *"the realistic shape"*; the provider-create test asserted six random hex characters and
> then said, in its own comment, *"No adapter answers to this id, so it can never be
> 'ready'."* A test that describes the defect in prose is the hardest kind to see, because
> every reviewer reads the comment as the specification.
>
> **And measuring beat the authorities twice.** For B-21 the bug register named a fix that
> catches none of it and the vendor's own documentation named a marker that would have
> failed every run. For B-19 the entry pointed at entities, where nothing was wrong; the
> damage was on the hypothesis side. **Both would have looked careful in a diff.** The only
> thing that told the truth was the rows.

---

### R-33 — The P2 tranche gets read, and half of it is already gone

**Status:** done 2026-09-10. Second of O-100's four tranches (R-19 was the first).
**PR:** one, docs only. Spends nothing. **Fixes nothing** — same rule as R-19: a triage
that also fixes is a triage nobody can check.
**Depends on:** R-19.
**Files:** `docs/step-register.md`, `docs/backlog/good-to-have.md`.

**The citation scan, re-run.** R-19 measured 80 of the 100 entries never cited. After the
R-22 campaign it is **59**, and the P2 range `B-23 … B-49` holds **21** of them. Each read
against HEAD `1a1dfd4`:

| entry | disposition | the line that decides it |
|---|---|---|
| B-24 Cartesia transport failures get no retries | **live** | `run-executor.ts:206` — a null `httpStatus` is retryable only if the provider's own message contains "safe to retry", which Cartesia writes on a premature close but **not** on a connect error |
| B-25 pagination depends on undocumented `order=asc` | **moot** | no `order` param is sent at all; `vapi.ts:458-461` paginates on a `createdAtLe` watermark |
| B-26 dashboard latest-run polluted by scan runs | **narrowed** | `benchmark.ts:303-310` still has no `purpose` filter — but nothing writes a non-batch purpose any more, and the newest five non-archived runs are all `batch`. 10 historical `agent_scan` rows survive |
| B-27 queue dialog toasts a blocked run as started | **moot** | that dialog is gone from `Runs.tsx`; the surviving "Run started" toast at `:211` is the execute/retry path |
| B-28 `save()` always sends `gold_in_review` | **moot** | `Review.tsx` is deleted |
| B-29 play/pause icon desyncs | **moot** | `Review.tsx` is deleted |
| B-32 dashboard never invalidated | **fixed** | `Runs.tsx:210,240` invalidate the dashboard beside the runs list |
| B-33 duplicate import ids 500 the batch | **fixed** | `benchmark.ts:1000,1015` carry a `skipped_duplicate` outcome; `:165` is `onConflictDoNothing()` |
| B-35 self-confirm guard is dead code | **moot** | `sourceTranscriberProvider` no longer appears in `routes/agent.ts` |
| B-36 concurrent scans double-bill | **moot** | `Agent.tsx` is deleted and the scan route is retired |
| B-38 `fetchAudioBytes` has no timeout, no size cap | **live** | `lib/stt-providers/src/types.ts:165` — bare `fetch`, then an unbounded `arrayBuffer()` |
| B-39 judge calls lack timeouts | **narrowed** | `agent.ts:328` records that the raw fetch path was replaced; only `analyzeFailure` still uses one (`:109`) |
| B-40 session advisory lock under a transaction pooler | **live, narrowed** | `run-executor.ts:260` is still `pg_try_advisory_lock`, and `lib/db/src/index.ts` still blesses pooled connection strings — one instance on localhost today |
| B-41 no secondary indexes | **narrowed** | four unique indexes exist now, not one; `results(run_id)` is served as a prefix of `benchmark_provider_call_results_cell_key`. **`scores(result_id)` is still absent** |
| B-42 `PGPOOL_MAX` ≤0 hangs the API | **fixed** | `lib/db/src/index.ts:22` — `Math.max(2, …)` (B-92) clamps it |
| B-43 "Cost/Min" stores per-call dollars | **narrowed** | T-61 at `run-executor.ts:1374-1379` documents the semantics and `costMicrocents` carries the exact value; the mislabeled column survives for compatibility |
| B-44 standalone `-` and `'` survive as word tokens | **live** | `lib/scoring/src/core.ts:105` keeps both, and no filter drops a token matching `^[-']+$` |
| B-45 a strict enum turns one bad row into a 500 | **live, unreachable through the product** | `Vertical` is exactly `[rush, property_management, trucking]`; only a direct DB write can produce a fourth |
| B-46 a plain `audioObjectPath` can never play or score | **live** | `vapi.ts:547-558` returns null unless the filename matches `VAPI_CALL_ID_IN_FILENAME`, so a stored ordinary URL raises *"no audio was ever imported"* |
| B-47 Cartesia timing constants fail long recordings | **half fixed** | the fixed 120s cap became a scaled timeout (T-8-style, `cartesia.ts:30-45`); the **6400-byte / 190 ms pacing still assumes 16 kHz 16-bit** regardless of the decoded WAV |
| B-48 attest swaps the reviewed call | **moot** | `Review.tsx` is deleted |

**Score: 5 live, 5 narrowed, 1 half fixed, 3 fixed, 7 moot.**

**The shape of this tranche is different from R-19's, and the difference is the finding.**
R-19's P0/P1 slice came back two-thirds still true. Here **a third of the entries describe
code that no longer exists** — `Review.tsx`, `Agent.tsx` and `POST /agent/scans` between them
account for six of the seven moots. Severity did not decay; **the surface did.** A register
entry is a claim about a file, and deleting the file settles it in a way no amount of
re-reading a diff can.

**Found while triaging, not in the register at all.** Three runs on the dev database have sat
`running` since 2026-09-09T19:15Z. Nothing finishes them and nothing reports them, and the
dashboard's "latest run" reads the newest non-archived row — so the Overview has been showing
a run in flight for a day. Logged in `docs/backlog/good-to-have.md`; it is the symptom the
wave-2 file predicts under "unguarded finalize writes zombie runs", which makes it evidence
rather than a claim.

**Sharpest live one: B-38.** `fetchAudioBytes` has no timeout and no size cap, and a hung
fetch pins a worker slot, a provider semaphore, the advisory lock and the `runningRuns` guard
until the process restarts — which is exactly the state those three runs are in. **R-23
edited that function today and deliberately did not touch it**: a different bug, and widening
a security fix into a resource fix is how one PR stops being reviewable.

**Acceptance:** WHEN a reader opens this block THEN every never-cited P2 entry SHALL carry a
disposition and the file:line that decides it.
**Verify:** the citation scan from R-19, re-run (59 never cited, 21 in this range); each
file:line above read at HEAD `1a1dfd4`.
**Must not:** fix anything here; mark an entry moot because its impact shrank while its
mechanism survives (B-26, B-40 and B-45 are all recorded live-but-narrowed for that reason).

**Not started: the two remaining tranches.** P3 (`B-50 … B-81`, 28 never cited) and wave 2
(`B-83 … B-101`, 12 never cited), and then the **330** findings in
`ox-alpha/bug-register-waves.md`, which no live doc cites at all.

---

### R-34 — The P3 tranche gets read, and three entries are left undecided on purpose

**Status:** done 2026-09-10. Third of O-100's four tranches.
**PR:** one, docs only. Spends nothing. Fixes nothing.
**Depends on:** R-33.
**Files:** `docs/step-register.md`.

The never-cited P3 entries, 27 of them (`B-51` … `B-80`), read against HEAD `41c8240`:

**Live — 7**

| entry | the line that decides it |
|---|---|
| B-63 `stt-score` CLI crashes on malformed rows | `scripts/src/stt-score.ts:14` — `JSON.parse(raw) as ScoreInput` is still a blind cast |
| B-67 `start` needs Node ≥22.9 with no `engines` declared | `artifacts/api-server/package.json:9` uses `--env-file-if-exists`; there is no `engines` field, so Node 20 crashes on `bad option` instead of failing at install |
| B-68 executor wipes caller-authored `run.notes` | `run-executor.ts:860` — `notes: notes.join("\n") \|\| null` still replaces them |
| B-69 unguarded bookkeeping insert aborts the run | **narrowed**: two sites are wrapped now (`:696`, `:727`), but the R-13 disabled-cell loop at `:534` is not, and a throw there aborts the run before any cell runs |
| B-70 `hashtext()` 32-bit collision drops an execution | **narrowed**: `:260` still hashes into 32 bits. At ~30 runs the collision odds are negligible; **the defect that survives is the silence** — a collision logs "locked by another instance" and returns success-shaped |
| B-71 "(after N attempt(s))" on a single-attempt failure | `run-executor.ts:978` interpolates `CELL_MAX_ATTEMPTS`, not the attempts actually made |
| B-79 results endpoint returns 200 `[]` for an unknown runId | `benchmark.ts:1756-1770` selects by `runId` with no existence check, while the manifest route beside it 404s (`:1684`) |

**Narrowed — 3.** B-74 (null telemetry scoring best-possible) is addressed in spirit —
`lib/scoring/src/core.ts:444` now speaks of *"insufficient evidence rather than silently
ranking on partial data"*. B-75 (Vapi account id collisions) keeps its first-match
resolution at `vapi.ts:133`, but an unknown account now fails loudly with the configured
list. B-78 (invisible preview truncation) now reports a `truncated` flag (`vapi.ts:421`);
whether the UI shows it was not chased here.

**Fixed since it was written — 6.** B-56 (Dashboard now has `isLoading`/`error` at `:252`),
B-65 (`vite.config.ts:99` has the `preview` proxy the entry said was missing), B-72
(`deepgram.ts:151` is `res.json().catch(() => null)`), B-73 (`:45` returns **null**, not 0,
when there are no words), B-76 (`benchmark.ts:1287` is `Boolean(env?.trim())`), B-77
(`:828`, `:933` carry the `sourceProvider = 'vapi'` guard).

**Half fixed — 1.** B-62: the CLI now sets `process.exitCode = 1` on partial failure
(`import-vapi-calls.ts:230`). The 200-vs-500 id cap half was not re-derived.

**Moot — 7.** B-51, B-58, B-59 name `Review.tsx` and `Agent.tsx`, both deleted. B-55's
attestation gate was removed by decision — `Corpus.tsx:1079` records calls landing *"directly
at ready_to_run, no gate in between"*. B-57's label logic is gone from `Dashboard.tsx`.
B-66's deploy path filter cannot be wrong because T-68 removed the `push` trigger entirely.
B-80's scan catch-all is retired with the route.

**Three left undecided, and that is the honest state — 3.** B-60 (import date-window edges),
B-61 (indeterminate select-all) and B-64 (vacuous rehearsal proofs). For B-60 and B-61 the
**cited lines no longer exist** in `Import.tsx` — but "the line is gone" settles the citation,
not the behaviour, and I did not re-derive whether an inverted range or a partially-ticked
list still misbehaves. B-64 needs the rehearsal script's assertions read against what they
claim to prove, which is a sitting, not a grep. **Recording them as undecided is the point:**
a triage whose value is that every row was actually opened cannot afford three rows that were
skimmed and rounded to "moot".

**Score: 7 live, 3 narrowed, 1 half fixed, 6 fixed, 7 moot, 3 undecided.**

> **What was learned.** *The moots are concentrated, not scattered.* Across R-33 and R-34,
> thirteen of the fourteen moot entries trace to four deletions — `Review.tsx`, `Agent.tsx`,
> `POST /agent/scans`, and two gates removed by decision. A bug register ages by **product
> shape**, not by time: the entries that die are the ones whose surface was removed, and they
> die all at once, so "how old is this file" predicts almost nothing about how much of it is
> still true.

**Acceptance:** WHEN a reader opens this block THEN every never-cited P3 entry SHALL carry a
disposition and the line that decides it, or SHALL be named as undecided with the reason.
**Verify:** the R-19 citation scan; each file:line above read at HEAD `41c8240`.
**Must not:** fix anything here; round an unread entry to "moot" because its cited line moved.

**Remaining: wave 2** (`B-83 … B-101`, 12 never cited), then the **330** in
`ox-alpha/bug-register-waves.md`, which no live doc cites at all.

---

### R-35 — The wave-2 tranche gets read, and O-100's first file is finished

**Status:** done 2026-09-10. Fourth and last tranche of `ox-alpha/bug-register.md`.
Closes memo O-100's first half.
**PR:** one, docs only. Spends nothing. Fixes nothing.
**Depends on:** R-33, R-34.
**Files:** `docs/step-register.md`.

**A correction to R-33 first.** R-33 reported **59** never-cited entries. The real number is
**58**. My scan ran `range(1, 102)` against a register that ends at **B-100**, so `B-101`
counted as "never cited" for the excellent reason that it does not exist. The P2 and P3
counts are unaffected — the phantom sat in this tranche. Stated here rather than quietly
edited into R-33, because a triage that corrects its own arithmetic silently is worth less
than one that does not.

The 10 real never-cited wave-2 entries, read against HEAD `a0536ac`:

| entry | disposition | the line that decides it |
|---|---|---|
| B-84 executor never re-validates call eligibility | **live** | `run-executor.ts:326` — `.where(inArray(benchmarkCallsTable.id, run.callIds))`, no status filter, so a call archived after the run was created is still transcribed and still scored |
| B-85 gold lost update | **moot in the UI, narrowed on the server** | `Review.tsx` is deleted, so the editor race is gone. The PATCH still has no version precondition — but R-21 now guards the one destructive case, emptying a gold |
| B-86 adapter submit-leg throws escape the try | **live** | `assemblyai.ts:71` (upload) and `:91` (submit) are both outside the `try` that starts at `:140`, so a lost response becomes a generic Error, which `isRetryableError` treats as retryable — and the job is re-submitted **after it was billed** |
| B-87 immortal send interval | **live** | `cartesia.ts:393` — the `open` handler creates `sendTimer` without checking `settled`. If the connect timeout already ran `finish()`, the later `close` hits `if (settled) return` at `:314` and the interval is never cleared |
| B-90 `scanInFlight` blind exactly when needed | **moot** | `Agent.tsx` is deleted |
| B-93 CSV formula guard bypassed on quoted fields | **fixed** | `Rankings.tsx:176` tests the **raw** value before quoting, and cites its own wave-2 twin B-91 in the comment |
| B-94 re-executed run shows stale then inflated duration | **fixed** | `run-executor.ts:319` — `.set({ status: "running", completedAt: null })` |
| B-95 `costPerMinute: Infinity` accepted end to end | **live** | `lib/api-zod/src/generated/api.ts:870` is `zod.number().min(...)`; zod's `number()` rejects NaN but **accepts Infinity**, and `min` cannot stop it |
| B-97 executor trusts run arrays, silent shrink fakes success | **live** | same bare `inArray` at `:326`: ids that no longer resolve are dropped, and the run reports complete over fewer cells than it claims |
| B-98 import fabricates a 1s duration | **live** | `benchmark.ts:1060` — `Math.max(1, durationSecondsOf(call))`, while the preview path at `:957` shows the true value |

**Score: 6 live, 2 fixed, 2 moot.** The highest live-rate of any tranche — and not by
accident. These were written by verifier agents against source rather than by hunters
against a hunch, and they name mechanisms rather than symptoms. **The register's own
provenance predicts its decay better than its priority label does.**

**`ox-alpha/bug-register.md` is now fully read.** All 100 entries carry a disposition across
R-19 (P0/P1), R-33 (P2), R-34 (P3) and this step.

> **Corrected in R-45 (2026-09-10): that sentence is wrong, and it was wrong when it was
> written.** Scanning the four disposition steps for `B-<n>` finds **12 entries named in
> none of them** — B-2, B-30, B-31, B-34, B-37, B-52, B-53, B-54, B-82, B-88, B-89, B-96 —
> and the true figure is lower still, because that scan counts a cross-reference inside
> another entry's row as coverage. **B-88 was a P0**, and it was live: R-45 fixed it. The
> claim was made by reading the tranche I had just written rather than by re-scanning the
> register, which is the same mistake R-19 wrote down about the register itself.

**The two sharpest things still unowned, both from this tranche:**

- **B-86 re-submits a job that was already billed.** A lost response on the submit leg is
  indistinguishable from a failure, and the retry path pays again. That is real money, on
  three adapters.
- **B-84/B-97 are the same line.** One bare `inArray` means a run neither re-checks whether
  its calls are still eligible nor notices when some have vanished — and then reports
  `complete`. R-26 tightened what "already done" means for a *cell*; this is the same class
  of question one level up, about the run's inputs.

**Acceptance:** WHEN a reader opens this block THEN every never-cited wave-2 entry SHALL
carry a disposition and the line that decides it; AND the count reported in R-33 SHALL be
corrected here.
**Verify:** the R-19 citation scan with the correct upper bound (`B-100`); each file:line
read at HEAD `a0536ac`.
**Must not:** fix anything here; carry the phantom `B-101` forward.

**What is left of O-100:** `ox-alpha/bug-register-waves.md` — **330 findings, cited by no
live document at all.** That file is not a fourth tranche of this size; it is roughly three
times everything read so far, and it deserves its own plan rather than a fifth step of this
shape.

---

### R-36 — A job that may already be billed stops being submitted twice (B-86)

**Status:** open.
**PR:** one. Spends nothing — and is entirely about not spending.
**Depends on:** R-35.
**Files:** `lib/stt-providers/src/types.ts`,
`lib/stt-providers/src/adapters/assemblyai.ts`,
`lib/stt-providers/src/adapters/speechmatics.ts`,
`lib/stt-providers/src/adapters/openai.ts`,
new file lib/stt-providers/src/submit-leg.test.ts.

**Today:** each adapter handles its HTTP-error paths. What none of them handles is a
**transport-level throw** — a socket reset, a lost response — on the request that submits
the billable work. That throw escapes `transcribe()`, and `isRetryableError`
(`run-executor.ts:218`) returns **true** for any generic `Error`, so the attempt loop
immediately submits again. AssemblyAI (`:91`) and Speechmatics (`:77`) create an async job
there; OpenAI's call (`:71`) **is** the transcription. All three charge, and a lost response
is indistinguishable from a failure — so the retry pays for work that may already be running.

**No new failure class was needed, and that is the whole trick.** A *thrown* error goes to
`isRetryableError`, which retries. A *returned* failed result goes to `isRetryableOutcome`,
which with a null `httpStatus` and no "safe to retry" in the message **stops the loop**. So
catching the throw and returning is the fix; the classification machinery already says the
right thing. `failureClass` stays `unknown`, which is retryable at the **run** level — a
human can still decide to pay again. That is exactly the difference the standing rule names:
*a run must be resumable, not retryable-by-luck.*

**The test found a bug in the fix.** The helper interpolates the provider's own error text
for diagnosis. `"safe to retry"` is a **control phrase** in this repo — `isRetryableOutcome`
greps for it — so a vendor whose message happened to contain those words would have steered
our retry decision and got the job resubmitted after all. That is the *"safe to retry
contract abuse"* the wave-2 register warns about, reintroduced by the very fix meant to stop
double-billing. The phrase is now neutralised in the interpolated text rather than trusted.
**Review would not have caught this; a test asserting the absence of a string did.**

**Acceptance:** WHEN the fetch that submits billable work throws THEN `transcribe` SHALL
return a failed result rather than throw; AND that result SHALL carry a null `httpStatus`
and a message that does not contain "safe to retry", so the attempt loop does not resubmit;
AND the cell SHALL remain retryable by a deliberate run-level retry.
**Verify:** `pnpm run typecheck`; `pnpm --filter @workspace/stt-providers test` (117);
api-server unit (206) and integration (181) unchanged; the break test restores the bare
`await fetch` on each adapter's submit leg.
**Must not:** make the cell permanently unretryable; add a failure class; touch the
HTTP-error paths, which were already correct; let a provider's error text reach the message
unfiltered.

**Not fixed here:** the upload leg (`assemblyai.ts:71`). AssemblyAI bills on transcription,
not on upload, so re-uploading costs nothing and a throw there should stay retryable. Left
deliberately, and named so nobody "completes" the fix by wrapping it too.

---

### R-37 — An infinite price stops being a valid price (B-95)

**Status:** open.
**PR:** one. Spends nothing.
**Depends on:** R-35.
**Files:** `lib/api-spec/openapi.yaml`, the generated clients,
`artifacts/api-server/src/routes/__integration__/providers-write.int.test.ts`.

**Today:** `costPerMinute` was `{ type: number, minimum: 0 }` on both `ProviderInput` and
`ProviderUpdate`. `JSON.parse("1e999")` is `Infinity`, and **zod's `number()` rejects `NaN`
but not `Infinity`** — `minimum` cannot stop it, because `Infinity >= 0` is true. It reached
pg `float4`, came back over the wire as `null`, and `Providers.tsx` called `.toFixed` on it.

**Verified rather than inherited.** The register said it passes; I parsed all three cases
through the real generated schema before touching anything:

```
costPerMinute=Infinity   ACCEPTED -> Infinity
costPerMinute=-1         rejected: too_small
costPerMinute=0.005      ACCEPTED -> 0.005
```

The first attempt at that probe reported **all three rejected**, including the valid one —
because it sent `model: "m"` against a `minLength: 2`. A probe that rejects everything is
not evidence of a strict schema; it is evidence of a broken probe. Worth the extra minute.

**Change:** a finite `maximum`. That is what rejects `Infinity` — `Infinity <= 10` is false —
and it needed no hand-written guard, because the contract is the right place for it.

**Why 10, measured rather than picked.** Real `costPerMinute` on file runs **0.0043 to
0.0102** dollars per minute, across 12 providers. Ten is ~1000× the most expensive of them,
so it can never refuse a genuine price — and unlike an enormous bound it also catches a
fat-fingered exponent, not only the infinite case. A cap that only stops `Infinity` would
have been the smaller change and the weaker one.

**Acceptance:** WHEN `costPerMinute` is `Infinity` on create or update THEN the request SHALL
be refused with 400; AND a real price SHALL still be accepted.
**Verify:** `pnpm run typecheck`; `node scripts/check-api-routes.mjs`; api-server integration
(184); the break test removes `maximum` from the spec and regenerates.
**Must not:** guard this in the route instead of the contract; pick a bound that a real
provider price could reach; change `minimum`.

---

### R-38 — "No results yet" and "no such run" stop being the same answer (B-79)

**Status:** open.
**PR:** one. Spends nothing.
**Depends on:** R-35.
**Files:** `artifacts/api-server/src/routes/benchmark.ts`, `lib/api-spec/openapi.yaml`,
the generated clients,
`artifacts/api-server/src/routes/__integration__/runs-and-results.int.test.ts`.

**Today:** `GET /benchmark/runs/:runId/results` selects cells by `runId` with no existence
check, so an unknown run answers **200 with an empty array** — byte-for-byte what a real run
that has not produced a cell yet returns. A caller polling a mistyped or deleted id waits
forever on a response that says *"not yet"* when the truth is *"never"*. The manifest route
beside it (`:1686`) has always 404'd; the two now agree.

**A fourth test was pinning the defect, and this one said so in its title.** It was called
*"an unknown run answers an empty list"* and asserted `200 []`. Rewritten to assert all three
answers — 404 for an unknown run, 400 for a malformed id, and **200 with an empty list for a
real run that has produced nothing yet**, which is the case the 404 must not swallow and
which nothing covered before.

> **Running count.** That is four tests in this session that asserted a bug as expected
> behaviour: the R-13 fixture's unscored `ok` row *("the realistic shape")*, the provider
> create test's random suffix *("No adapter answers to this id")*, and now this one. **Each
> was written by someone reading the code and describing what it did.** That is the failure
> mode of writing tests after the fact rather than from the requirement — the test inherits
> the implementation's opinion, and then defends it.

**Acceptance:** WHEN the runId names no run THEN the response SHALL be 404; AND WHEN the run
exists but has no cells THEN it SHALL be 200 with an empty array.
**Verify:** `pnpm run typecheck`; `node scripts/check-api-routes.mjs`; api-server integration
(184); the break test removes the existence check.
**Must not:** 404 a real run that has produced nothing yet; change the 400 for a malformed id.

---

### R-39 — B-87 does not hold, and the reason is two lines the entry did not read

**Status:** done 2026-09-10. Refutation, no code.
**Depends on:** R-35.
**Files:** none.

R-35 recorded B-87 — *"immortal send interval when open lands after connect-timeout finish"* —
as **live**, on the strength of `cartesia.ts:393`: the `open` handler creates `sendTimer`
without checking `settled`. That reading is correct and the conclusion does not follow.

**Both paths that set `settled` close the socket first.** The connect timeout
(`cartesia.ts:353-362`) and the response timeout (`:364-375`) each call `ws.close()` and
*then* `finish()`. This adapter uses Node's global `WebSocket` — there is no `ws` dependency
in the package — and per the WHATWG semantics undici implements, `close()` on a **CONNECTING**
socket fails the connection: the readyState goes to CLOSING and `open` does not fire
afterwards. The window the entry describes is closed by the two lines above the one it cites.

**Stated as a limit, not a proof.** I am reasoning from the specification and from reading
undici's contract, **not** from an observed run. Forcing a handshake to complete in the same
tick as a `close()` is not something I could stage cheaply, so what is established is that
the path is unreachable *as written*, not that no implementation could ever leak.

**No code was written, on purpose.** The one-line `if (settled) return` in the `open` handler
would be free and would look prudent. It is also code for a path nothing can reach, which no
test could cover — the same reason R-30 took out its redundant `\p{M}` strip. **An entry
marked "verified" by an agent that read one line is not evidence; it is a hypothesis with
good posture.** Refuting it is worth more than defending against it.

**Must not:** add the guard without first demonstrating the race; treat this refutation as
covering B-24 or B-21, which are about the same file and remain live.

---

### R-40 — A cell that was tried once stops claiming it was tried three times (B-71), and B-68 is split

**Status:** open.
**PR:** one. Spends nothing.
**Depends on:** R-35.
**Files:** `artifacts/api-server/src/lib/run-executor.ts`,
new file artifacts/api-server/src/lib/cell-failure-message.ts,
new file artifacts/api-server/src/lib/cell-failure-message.test.ts.

**Today (B-71):** the failed-cell message interpolated `CELL_MAX_ATTEMPTS`
unconditionally. A cell that broke on its **first** attempt — a 401, or any outcome
`isRetryableOutcome` calls terminal — was recorded as having failed *"after 3 attempt(s)"*.
An operator reads that as *"we tried hard and it kept failing"* and goes hunting a flaky
provider, when one call was refused once. **The number was never the attempts made; it was
the ceiling.**

**Change:** count the attempts and say that. Nothing parses this string — checked across
`artifacts`, `lib` and `scripts` before rewording — so it is safe to say what happened.

**Extracted to be testable.** `runCell` cannot be driven in the suite: that needs a `ready`
provider, and a ready provider in a test spends real money. `cellFailureMessage` is a pure
function for the same reason `cell-resumption.ts` is one. Its test also pins that the phrase
`"safe to retry"` is never introduced here — that string is the contract `isRetryableOutcome`
reads, and R-36 already found one way to reintroduce it by accident.

**B-68 is split, not fixed.** The entry says the executor wipes caller-authored `run.notes`,
and it does: `:860` sets `notes` to this attempt's lines. But the comment directly above
records that prepending was **removed on purpose** on 2026-08-25, because a run retried N
times accumulated N near-identical lines. So the two readings are both right and they
conflict:

- *the executor's view* — `notes` describes **this attempt's outcome**, and the history is in
  `audit_log`;
- *the caller's view* — `notes` is **what I wrote when I created this run**, and it vanished.

**One column, two writers, and no rule saying which owns it.** That is the actual defect, and
neither prepending (which restores the accumulation bug) nor leaving it (which keeps losing
the caller's text) settles it. It wants a second column, or a decision that the caller's note
belongs somewhere else. Recorded for Abhishek rather than guessed at — the same shape as
R-24.

**Acceptance:** WHEN a cell fails on its first attempt THEN the recorded message SHALL NOT
mention an attempt count; AND WHEN it fails after N>1 THEN it SHALL name N.
**Verify:** `pnpm run typecheck`; api-server unit (212) and integration (184); the break test
removes the single-attempt guard (2 failed).

**One mutation could not be caught, and it is worth naming.** Deleting
`attemptsMade = attempt;` from the loop leaves the counter at 0, so the message never
mentions attempts at all — and **all 212 tests still pass**. The helper is tested; the one
line that feeds it lives inside `runCell`, which nothing can reach without a `ready`
provider. That is the same limit the extraction exists because of, and it is not closed by
this step. The consolation is only that the uncaught regression is the smaller one: never
claiming an attempt count is a milder lie than always claiming the ceiling.
**Must not:** fix B-68 in this step; introduce the phrase `safe to retry`; change which
outcomes break the retry loop.

---

### R-41 — A version-gated node flag stops failing as "bad option" (B-67)

**Status:** open.
**PR:** one. Spends nothing.
**Depends on:** R-34.
**Files:** `artifacts/api-server/package.json`, `package.json`,
new file scripts/check-node-engines.mjs, `.github/workflows/ci.yml`.

**Today:** `artifacts/api-server`'s `start` runs `node --env-file-if-exists=.env`, a flag
that landed in Node 22.9. **No package in this repo declares `engines`** — checked, not
assumed: there is no `engines` field anywhere and no `.nvmrc`. So an older Node does not fail
at install with a sentence; it boots and dies on `bad option: --env-file-if-exists`, which
reads like a corrupt install rather than a version mismatch.

**The tested range, measured:** CI runs Node **24** (`ci.yml:45`, and `deploy-web.yml:58`),
this machine runs **22.22.2**. `>=22.9` is the floor the flag actually needs and it covers
both.

**Change:** declare `engines.node` on the api-server package and at the root — **and** add a
check that keeps it true. Declaring a floor once is the kind of fix that rots silently: the
next version-gated flag gets added to a script and nothing notices. `check-node-engines.mjs`
scans every tracked `package.json` for scripts using a flag from a small table of
version-gated node flags, and fails when the package declares no floor or one that is too
low. Adding a newer flag without raising the floor now fails in CI instead of on somebody's
machine.

**Deliberately not `engine-strict=true`.** That would turn the warning into an install
failure, which sounds stricter and is the wrong trade here: pnpm applies it to
**dependencies' own** `engines` too, so one over-narrow transitive range breaks `pnpm
install` for everybody — and I cannot test that failure mode from a machine that already
satisfies every range. A repo-wide install policy is not a bug fix.

**Acceptance:** WHEN a package script uses a version-gated node flag THEN that package SHALL
declare an `engines.node` floor at least as high as the flag requires.
**Verify:** `node scripts/check-node-engines.mjs`, wired into CI; the break test removes the
`engines` field (fails) and sets it to `>=20.0` (fails).
**Must not:** add `engine-strict`; declare a floor higher than the flag needs; add an
`.nvmrc` that disagrees with what CI runs.

---

### R-42 — "We do not know how long this call was" stops being recorded as one second (B-98)

**Status:** open.
**PR:** one. Spends nothing.
**Depends on:** R-35.
**Files:** `artifacts/api-server/src/routes/benchmark.ts`,
new file artifacts/api-server/src/lib/duration-seconds.test.ts.

**Today:** the import route stored `Math.max(1, durationSecondsOf(call))`.
`durationSecondsOf` returns **0** when `startedAt` or `endedAt` is missing, unparseable, or
the delta is not positive — a crashed call. Flooring that to 1 makes *"we do not know"*
indistinguishable from *"one second"*, at import time and permanently, and it **disagrees
with the preview route two above it**, which shows the true 0.

**Measured:** 376 calls, **exactly 2** with `durationSeconds = 1`. Whether those two are real
one-second calls or fabricated ones **cannot be recovered** — which is the bug stated as
plainly as it can be. They are left alone; nothing here rewrites history it cannot read.

**The floor was not guarding anything.** Nothing divides *by* duration — checked across
`artifacts` and `lib`: the cost math multiplies (`run-executor.ts:1078`) and the bulk
estimate sums (`bulks.ts:445`), so 0 is safe in both.

**And the floor was actively worse in the one place duration steers behaviour.**
`scaledPollTimeoutMs(0)` returns the **120s** default; `scaledPollTimeoutMs(1)` returns
**60s**. The fabrication was handing a call of unknown length a *shorter* transcription
budget than "unknown" gets. That is the opposite of what a defensive floor is for, and it is
the argument that makes this a correctness fix rather than a taste one.

**No test can reach the changed line, and that is worth naming.** The import route calls
Vapi, so it cannot be driven offline; there is no integration test for it at all. What is
pinned instead is the input contract — `durationSecondsOf` returns 0 for every unknown shape
— and the timeout asymmetry above, which is the reason the floor was harmful. **The
untestable import route is itself the larger problem** and blocks B-33 and B-77 as well;
logged to `docs/backlog/good-to-have.md` rather than pretended around.

**Acceptance:** WHEN a call has no usable start or end THEN the stored duration SHALL be 0,
the same value the preview shows; AND existing rows SHALL NOT be rewritten.
**Verify:** `pnpm run typecheck`; api-server unit (218) and integration (184).
**Must not:** rewrite the 2 existing `1` rows; make the column nullable, which is a schema
change and wants a worktree; change what `durationSecondsOf` returns.

---

### R-43 — The scoring CLI stops exploding somewhere else (B-63)

**Status:** open.
**PR:** one. Spends nothing.
**Depends on:** R-34.
**Files:** `scripts/src/stt-score.ts`,
new file lib/scoring/src/parse-score-input.ts,
new file lib/scoring/src/parse-score-input.test.ts,
`lib/scoring/src/index.ts`.

**Today:** `stt-score.ts` did `JSON.parse(raw) as ScoreInput | ScoreInput[]` — a blind cast
covering **two** failures at once. A file that is not JSON, and a row missing a field, both
surfaced as a `TypeError` from inside `score()` that named neither the file, nor the row, nor
the field. The person running it has a JSON file in front of them and no way to find the one
bad row in four hundred.

**Change:** parse and validate, reporting **every** bad row rather than the first — someone
fixing a generated file wants the list, not one round trip per row. Verified by running the
CLI, not only by unit test:

```
bad.json: 2 problem(s) in 2 row(s):
  - row 1: "vertical" must be one of rush, property_management, trucking, got "aviation"
  - row 1: missing "entities" (use [] when there are none)

notjson.json: not valid JSON -- Expected property name or '}' in JSON at position 1
```

**Hand-written, not zod, and that is a decision not an omission.** `lib/scoring` has no zod
dependency. It is the pure, hot path every flag, span and WER goes through (T-33), and adding
a runtime validation library to it to improve a **CLI error message** is the wrong trade. The
check is deliberately shallow: it establishes the shape `score()` relies on and says where a
bad row is, which is the entire complaint.

**Found while verifying, and deliberately not fixed here.** Running the CLI on a real pair
showed `wer: 1` for gold `"load twelve"` against hypothesis `"load 12"`. Traced rather than
assumed:

```
normalizeTranscript("load twelve") -> "load twelve"
normalizeTranscript("load 12")     -> "load 1 2"
```

`SPOKEN_DIGIT_WORD` maps `zero`…`nine` only. It exists for **digit-by-digit spelling** —
`"five five five"` → `"5 5 5"` for a phone or RO number — and a cardinal like `"twelve"` is
not in it by design. So the two normalise to different token counts and the row scores as a
total miss. **That is a scoring-policy question, not a defect in this CLI**, it touches
`docs/scoring-policy.md` and the 20% WER weight in the composite, and it lines up with the
digit-word disputes already measured across the corpus. Logged to
`docs/backlog/good-to-have.md`; fixing it inside a CLI-validation PR would have been a
drive-by change to how every provider is ranked.

**Acceptance:** WHEN the input file is not JSON, or any row lacks a field `score()` needs,
THEN the CLI SHALL fail naming the file and every bad row; AND what survives the gate SHALL
be scoreable without throwing.
**Verify:** `pnpm run typecheck`; `pnpm --filter @workspace/scoring test` (194); the CLI run
above.
**Must not:** add zod to `lib/scoring`; change what `score()` computes; touch number-word
normalisation in this step.

---

### R-44 — The executor stops trusting the id list it was handed (B-84 and B-97)

**Status:** open.
**PR:** one. Spends nothing, and is mostly about not spending.
**Depends on:** R-35.
**Files:** `artifacts/api-server/src/lib/run-executor.ts`,
`artifacts/api-server/src/routes/__integration__/run-executor-disabled.int.test.ts`.

**B-84 and B-97 are the same line.** `calls` came straight from
`inArray(run.callIds)`, so the executor trusted its input twice over:

- **B-97** — an id that no longer resolves is dropped by `inArray` **without a word**. The
  run drains fewer cells than it claims and finalises `complete` over a set nobody agreed to.
- **B-84** — a call **archived after the run was created** is still transcribed and scored.
  Archiving is a human withdrawing data from the corpus; paying a vendor to transcribe it
  afterwards, and letting it into rankings, is the opposite of what that click meant.

**Measured before touching a spend path:** 164 call references across every run on the dev
database, **0 archived and 0 dangling.** Both are latent, so this is a provable no-op on
today's data — which is what makes it safe to change the function that spends money.

**Recorded, never silently applied.** That is R-13's rule — *"a cell nobody can see is a
cell nobody knows was refused"* — and this follows its shape exactly. **The asymmetry is
forced, not chosen:** an archived call still has a row, so its refusal is a real cell with
its own sentence; a missing id has no row at all, so
`benchmark_provider_call_results.call_id` has nothing to point at and the run's notes are
the only place the shortfall can be said.

**`totalCells` now counts `run.callIds`, not the rows that came back.** Counting only what
resolved would re-hide exactly what B-97 is about: a run whose ids no longer all resolve
would report a smaller denominator and look complete against it. The claim is the id list.

**And `withdrawnCells` joins `attemptedCells`**, for the same reason T-43 includes
permanently-failed cells and R-13 includes disabled ones: a run that refused every cell it
had must not read `attemptedCells === 0` and finalize `complete` for having done nothing.

**The test caught a bug in the fix, and it was R-13's own bug reintroduced one filter
later.** The refusal loop first iterated `providers` — the *enabled* subset. Since `calls`
now excludes archived rows, the disabled-provider loop skips them too, so an **(archived
call, disabled provider)** pair got **no row at all**: the cell vanished entirely, which is
precisely the thing R-13 wrote its loop to prevent. Fixed to `selectedProviders`. Review
would not have found it; a test asserting two cells where one appeared did.

**Acceptance:** WHEN a run names a call that no longer exists THEN its notes SHALL say how
many cells could not be attempted AND `totalCells` SHALL still reflect the ids the run was
created with; AND WHEN a call is archived after creation THEN each of its cells SHALL be
recorded refused with the call's own reason, not a provider's.
**Verify:** `pnpm run typecheck`; api-server integration (186), including one test per half.
Break test, four mutations, all caught, totals held at 186: no call ever treated as
withdrawn (1 failed); `totalCells` computed from the resolved rows (1 failed); the
missing-id note removed (1 failed); the refusal loop back to enabled providers only
(1 failed).

**What the tests do NOT prove, and cannot.** They pin that the refusal is *recorded* with
the right reason. They do **not** pin that an archived call is never *sent to a provider* —
that needs a `ready` provider in the suite, which spends real money, and this file's header
forbids it in as many words. The first mutation I tried was a bad one for exactly this
reason: removing the `calls` filter left the recording intact, so all 186 passed and it
looked like a caught mutation until I read what it had actually changed. The spend
protection rests on the filter being read, not on a test.
**Must not:** silently skip either case; count `totalCells` from the resolved rows; give an
archived call a provider's reason; refuse a call for any status other than `archived` —
`ready_to_run` with no gold is the normal import path and R-19 already refused that gate
once.

---

### R-45 — An idle database connection dying stops killing the API (B-88) — **done**

`pg.Pool` extends `EventEmitter`, and pg-pool's idle handler calls
`pool.emit("error", err, client)` when a pooled connection dies while nobody is holding it:
a failover, a load balancer closing an idle socket, an RST. Node throws an emitted `error`
that has no listener. There were **zero** `pool.on("error", ...)` registrations anywhere in
the repo, and nothing in this process installs an `uncaughtException` handler — so one
dropped idle socket exited the API, and every run in flight stayed at `running`, already
paid for, with nothing written down about why.

**This is the likely mechanism behind O-116.** Three `benchmark_runs` have sat `running`
since 2026-09-09T19:15Z. That is what this crash looks like from the outside, and it is
the first candidate cause found for them that does not require guessing.

`lib/db/src/index.ts` now attaches a listener that logs and does nothing else, because
there is nothing to repair: pg has already removed the dead client from the pool by the
time it fires. Only `err.message` and `err.code` are logged — the second argument pg
passes is the dead client, and its `connectionParameters` carry the database password.
`console.error` rather than the api-server pino logger: the dependency runs the other way
(api-server imports `@workspace/db`), and giving `lib/db` its own pino would stand up a
second transport for one line.

**Why the test is an integration test.** The defect is in the *exported pool object*, and
that object only exists when `DATABASE_URL` is set. A unit test would have to build its
own pool, and would then pass regardless of what the real one does.
`artifacts/api-server/src/routes/__integration__/pool-error.int.test.ts` asserts three
things about the real pool: it has an `error` listener; emitting the event pg-pool emits
does not throw; and the log line carries the message and code while carrying neither the
host nor the password off the dead client.

**Proved by breaking it.** Deleting the listener from a committed tree failed all three,
and the middle one failed with the crash itself: *"expected [Function] to not throw an
error but 'Error: Connection terminated unexpect…' was thrown"*. Integration 189 passed
(186 before this step); api-server unit 218; typecheck clean.

**What it does not prove.** No test here drives a real failover. It pins the listener and
what the listener does with the event pg hands it; it does not pin that pg emits on the
socket conditions the entry names — that is read out of pg-pool's `makeIdleListener`, not
measured.

**What was learned.** The waves file is not a lower-value tranche of the curated register:
its first P0 read was a live process-killing defect that the curated register had already
recorded as B-88 and that four tranches of triage had walked past. The reason is
bookkeeping, not judgement — B-88 was never named in any disposition step, and my report
that all 100 were dispositioned was produced from the tranche I had just written instead
of from a re-scan.

**Acceptance:** WHEN an idle pooled client errors THEN the process SHALL survive it AND
SHALL log the message and code; AND the log SHALL contain no field from the client object.
**Verify:** the three assertions above at HEAD, and each one failing with the listener
removed.
**Must not:** log the client argument or the error object; add pino to `lib/db`; make the
listener attempt any repair — pg has already evicted the client.

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

**Status:** `done` 2026-09-08 (PR #115, `11ecdae`), deployed
`7f015e116814 -> 11ecdae6954f`. Verified live on the Vite server at :5173.

**Learned: placement was the whole step, not the wording.** The vendor's model
list is a `<details>` and is collapsed on first render, so a caption written
*inside* it satisfies every word of this step and fails its Acceptance
("without hovering, clicking, or expanding anything"). The caption sits above
the `<details>`, and the render test asserts `closest("details")` is null for
both captions and that neither is hiding in a `title` attribute — two of the
break-test mutations are exactly those two wrong homes, and both are caught.

**Evidence note:** `visual-and-research` run. Mobbin —
[Qatalog](https://mobbin.com/screens/bf24e755-2a66-4aa1-b64b-ad156bbd0641),
[Height](https://mobbin.com/screens/25de2e30-f93f-473e-9f0a-149f89a2f08b) and
[Better Stack](https://mobbin.com/screens/c59d087d-5a8b-4e4c-9627-b82462672ad5)
all split one list into named groups (enabled above available; Better Stack
labels the second one literally "Catalog"). That confirms the two-group split
this step describes, so the captions shipped as written. Lenny's: **no evidence
found** on labelling a catalogue against what is configured.

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

**Status:** `done` 2026-09-08 (PR #115, `11ecdae`), deployed `7f015e116814 -> 11ecdae6954f`. Shipped with S-2 and S-4/S-5 as one branch, one commit each.

**Live check after deploy:** dangling ids **3 → 0** across 9 enabled models.

**Learned: the break test found that "the id exists" is not the claim worth
making.** The first integration case asserted only that every enabled model's
`providerId` appears in `GET /benchmark/providers` — so a mutation reporting
the *adapter's own row* for every enabled model passed, because a sibling row
of the same vendor exists too. That is the same lie this step exists to stop,
aimed at a different vendor, and S-5 would have printed it.

Closing it needed a **seed**, not just a sharper assertion: every row already
in the test database is either the adapter's own id or a model with no row of
its own, so `adapter.providerId` and the synthesised id are the same string
and swapping them is invisible. Gladia's adapter row is `gladia-solaria` and
the synthesised id for its other catalogued model is `gladia-solaria-3`; with
that row seeded the two finally differ. **A test can only see a difference the
fixtures actually contain.**

**PR:** one.
**Depends on:** nothing.
**Files:** `artifacts/api-server/src/routes/benchmark.ts` (the `providers/models` handler,
around the `providerIdForModel` call), plus a new case in
`artifacts/api-server/src/routes/__integration__/`
**Today:** the handler always sets `providerId` to the synthesised
`<vendor>-<apiModel>`, while "is it enabled" can match the vendor's older row instead
(the `legacyDefault` path). Three ids in the live response today point at rows that do
not exist: `assemblyai-universal-3-5-pro`, `elevenlabs-scribe-v2`, `gladia-solaria-1`.
The real rows are `assemblyai-universal`, `elevenlabs-scribe`, `gladia-solaria`.

**Re-checked live 2026-09-08** against the running API: still exactly those three, out of
9 enabled models across 6 vendors and 30 catalogued models. **And "nothing follows that
id yet" has stopped being true** — S-5, the very next step, compares provider rows
against the catalog by this id, and without this fix it reports three vendors as having a
row their vendor does not list. The trap has a consumer now.
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

**Status:** `done` 2026-09-08 (PR #115, `11ecdae`), deployed `7f015e116814 -> 11ecdae6954f`. Shipped with S-2 and S-4/S-5 as one branch, one commit each.

**Live check after deploy** — exactly one vendor shows the line, which is what
the Acceptance asks for and was **not** true before S-4 landed in the same
branch:

| vendor | line |
| --- | --- |
| Deepgram | `flux-general-en` |
| AssemblyAI, Cartesia, ElevenLabs, Gladia, OpenAI | none |
| Speechmatics | silent — no catalogue vendor at all |

**Learned: a step that reads another step's output inherits its bugs.** This
one was written as "depends on nothing much" and would have shipped three
false lines, because the ids it compares against were the ids S-4 was fixing.
Grilling it against the live API rather than the register text is what caught
that; the dependency is now written down above.

**PR:** one.
**Depends on:** **S-4, added 2026-09-08 — this line used to read "S-1 is not required;
S-2 is not required" and never considered S-4.** S-5 compares a vendor's provider rows
against its catalog, and the catalog's `providerId` is exactly what S-4 fixes. Run
against the live API today, four vendors would show this line and **three of them would
be lying**: `assemblyai-universal`, `elevenlabs-scribe` and `gladia-solaria` all look
absent from their catalogs only because the models route reports the synthesised id
(`assemblyai-universal-3-5-pro` and friends) instead of the enabled row's real id. Ship
S-4 first and exactly one line remains — Deepgram's `deepgram-flux-general-en`, which is
the true case this step is for.

**Grilled 2026-09-08, before building.** Two more corrections:

1. **Compare by `providerId`, never by the row's `model` string.** A provider row's
   `model` is a display name ("Nova-3", "Flux General EN", "Universal") while the
   catalog's `apiModel` is the API string ("nova-3", "flux-general-en", "universal-2").
   Comparing those two directly reports **10 of 11 rows** as absent. The catalog already
   carries a `providerId` per model; that is the only key both sides agree on.
2. **A vendor with no catalog at all is not the same as a row missing from one.**
   Speechmatics has one provider row and no catalog vendor in the models response, so
   `VendorModelsLine` already returns null for it. This step's line must obey the same
   guard, or it will tell a person that Speechmatics Realtime "is not in this vendor's
   list API" when the truth is that we have never had a list for that vendor.

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

**Status:** done

**What it taught:** a rename and a derived list are not the same size of
change. Renaming the header was one line; the filter was the step, because its
options had been a hardcoded enum of three and account labels are not an enum.
Two things fell out of that and neither was in the step as written: the options
must be read off `calls` rather than `filteredCalls` (read off the filtered
rows, the first pick is the last one you can make -- and the break test could
not see that until the mutation also moved the memo's dependency array, since
a memo pinned to `[calls]` never recomputes and the wrong version behaves
correctly by accident), and a call with no account label needs a sentinel the
enum never did, or "all" is the only thing that can reach it. Reusing T-96's
own `__no_org__` key rather than inventing a second one is the reason "no
label" still means one thing on this page.

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
**Grill, 2026-09-08 — three corrections, the step still stands:**

1. _The filter is a change in kind, not a rename._ Today's options are a hardcoded
enum of three (`rush`, `property_management`, `trucking`) written into the JSX. Account
labels are not an enum — they are whatever Vapi accounts have been added, so the options
have to be derived from the loaded calls. That also needs a sentinel the enum never
needed: a call with no `sourceAccountLabel` is a real row (one of the seven in the render
fixture), and without an "Unlabelled org" option the filter cannot reach it. Verified in
`Corpus.tsx` lines 308-316 and in the fixture.

2. _The word survives in two places the acceptance does not reach, and both should keep
it._ `CreateCallDialog` has a Vertical `<select>` whose value is POSTed as
`createBenchmarkCall({ vertical })` — deleting the control would mean inventing a value,
which is a data change, not a screen change. `CallDetailsDialog` shows
`DetailRow label="Vertical"` beside Vapi call id and corpus id: that panel is a raw-field
inspector by design. Both are inside closed dialogs, so neither is in the DOM when the
page renders and the acceptance holds as written. Named here so "vertical is gone" is
never read as more than it is: it is gone from the TABLE and the FILTER.

3. _The table already groups by org (T-96), so the column repeats its group header._
Kept anyway: group headers are not sticky, so on a long org the header scrolls away and
the column is the only thing left saying which org a row belongs to — and `groupBy=flat`
has no headers at all. Navan's Users table carries a "Legal entity" column under exactly
this redundancy.

**Evidence (visual-and-research, 2026-09-08).** Pattern to use: the account name is an
ordinary per-row column, and the filter offers only values the loaded rows actually
contain, under an "All …" first option — [Attio Companies](https://mobbin.com/screens/b1f51bfb-4b7f-4d77-a7ce-9a1568db223e),
[Lightfield Accounts](https://mobbin.com/screens/3b7cee8b-447e-444c-a7be-cc2ac5a27e68),
[Twenty](https://mobbin.com/screens/378afbed-05be-40c9-9cad-0ecc6c36f8cd),
[Navan Users](https://mobbin.com/screens/8f0621ba-42c5-4413-8bb4-c826c9733451). No
evidence found for the naming half of the question — nothing in Lenny's archive covers
replacing an internal tag with a customer-facing one in a table header, and the four
"jargon" hits are about positioning and AI terms. Changes to the plan: the derived
options and the "Unlabelled org" sentinel above; nothing else.

**Acceptance:** WHEN the Calls page renders THEN no visible text SHALL contain the word
"vertical", and the filter SHALL narrow rows by account label.
**Verify:** `cd artifacts/stt-benchmark && pnpm run test`. Extend
`src/pages/__render__/calls.test.tsx`: the fixture already has two account labels
("Default", "Land And Apartment"); assert the header reads Org, filtering by one label
leaves only its rows, and `document.body.textContent` does not contain "ertical".
**Must not:** remove `vertical` from the API response, the CSV export, or the database.

---

### S-7 — One table style, properly spaced

**Status:** done

**What it taught:** most of this step had already shipped and nobody had
looked. Every table inherits `h-10 px-4` and `p-4` from one component, and the
five per-page overrides that read like drift are the chevron column, the two
expanded panels and the group-header rows -- all deliberate. Deleting them, as
the step said to, would have undone T-96. **Read the thing before believing
the sentence that describes it**, even when the sentence is one you wrote.
What was left was real and small: the boundary. The second lesson came from
the break test -- the first version of the test asserted `data-group-start`,
which is placement, and the rule lives in the class, so the attribute could
sit in exactly the right three places while the component drew nothing at all
or drew between every pair of columns. Three mutations survived on that alone.

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
**Grill, 2026-09-08 — the premise is false and the step shrinks:**

_"Each page has its own padding overrides, so the four tables do not match" is not true._
Every table on every page already inherits `h-10 px-4` (`TableHead`) and `p-4`
(`TableCell`) from the one shared component, and there is nothing to delete. Scanned all
seven pages for a `p-/px-/py-/h-` class on a `TableCell`/`TableHead`/`TableRow`: Rankings
has none, Bulks has one, Corpus has four, and all five are deliberate rather than drift —
`pr-0` on the chevron column, `p-0` on the two full-width expanded panels, and
`py-2`/`py-1.5 pl-8` on the org and assistant group-header rows, which are meant to be
tighter than data rows because they ARE the T-96 hierarchy. Deleting any of them would
undo a shipped step. So the row-height and padding half of this step is already done, and
what is left is the half that is real: **column groups run together.**

Also corrected: the acceptance names Setup, which owns no table — it is a 45-line tab
shell around Providers and Import (`Setup.tsx`). Providers renders cards, not a table. The
tables that exist are Calls, Results, Bulks, Import and Runs.

**Evidence (visual-and-research, 2026-09-08).** Patterns to avoid: a rule on every column
boundary. [Deputy/Sigma](https://mobbin.com/screens/5f44a43d-b87b-48b2-aa01-25ca30110aaa)
draws all of them and reads as a spreadsheet dump rather than a report;
[Sentry](https://mobbin.com/screens/11820743-80a4-4680-be5f-473608bea7c3) and
[Profound](https://mobbin.com/screens/5c9e8405-3355-4b9b-88b6-70f539560476) draw none and
separate by whitespace and a group-by control instead. Pattern to use: a hairline at the
boundaries only, as in [Peec AI](https://mobbin.com/screens/59ca615c-22e8-4f9a-8839-3bc750d1f801),
with the heavier grouping carried by full-width section rows the way
[Xero](https://mobbin.com/screens/dd15bfb2-c72b-4380-9ab7-fb16b3f7e9de) does — which this
table already has. Changes to the plan: the separator is opt-in per boundary
(`data-group-start`), applied two or three times per table, never per column.

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
| E | Tune mode and the tuning report | The largest item. Needs a full grill: which client first, which provider, and what a person does with the report once they have it. **New inputs 2026-09-08 (PRD v7 Part F):** the target is Flux (`keyterm`, one parameter per term, `Configure` mid-stream; **corrected 2026-09-09** -- this said "up to 100 terms" and Deepgram documents no term count, only 500 tokens per request); 14 of 14 largest assistants have 0 keyterms, so v5 E4's keep / add / replace is moot and the mode is greenfield; first subject Land And Apartment (assistants with 39, 18, 15 calls); seed vocabulary = words-to-watch + `artifacts/api-server/src/mine-reading-pairs.ts`. |
| v7 E | A monitor path: check only the calls that need it | Not before R-7 has counted the seeds. If no stored production signal beats the base rate for "the hybrid pass flagged this call", there is nothing to trigger on and the path is not built on this corpus. Never feeds rankings. |
| F | Write a transcriber back to Vapi | Dev accounts only, or production too? |
| v6 E4 | Vendor data-handling record in `docs/data-governance.md` §4 (six vendors already sent audio; every checkbox unticked) | Who signs the DPAs — Ellavox as processor for the client's callers? A legal answer the tool can only record. |
| v6 F2 | Deepgram keyterm cap test on the Rush assistant (120 terms sent; Deepgram caps at **500 tokens per request**, error beyond -- **corrected 2026-09-09**, the "100 terms" this row used to carry is not in Deepgram's docs) | Three paid Deepgram calls — pre-approved as cents, or a "go spend" each time? |
| v6 E1 | Backup destination | Local folder only, or also a cloud bucket / iCloud Drive? Local-only dies with the laptop. |
| v6 E3 | Customer-word floor | 30 words as the default, or lower for the transfer-heavy Land And Apartment assistants (median 2 customer turns per call)? M-16 ships with 30 and the question stays open. |

### S-8 — the integration suite flakes, and it is not one file

**Status:** done

**Found 2026-09-08 — the cause is outside this repository, and every theory in
this block was looking in the wrong place.**

Three failures in 33 runs, in three files, two never implicated before:

- `riskiest-endpoints.int.test.ts` T-150 expected 400 and got **401** carrying
  `{"type":"error","error":{"type":"authentication_error",...},"request_id":null}`
  -- an Anthropic API error envelope. That string appears nowhere in this
  repository, and BAML's clients here are `provider openai`.
- `riskiest-endpoints.int.test.ts` (d) expected 404 and got **400** with
  `content-type: text/html` and the body `WebSockets request was expected`.
- `calls-write.int.test.ts` failed with `audit.body.map is not a function`
  from a route whose only 200 shape is an array.

The M-6c setup file was extended for those runs to stamp every response the
app under test sends. **The failing answer carried no stamp: the app never saw
the request.**

**The mechanism, reproduced in isolation and printing the same body.**
`supertest` stands up a fresh server per request -- 178 call sites, several
inside loops -- with `app.listen(0)`, and `listen` with no host binds the
wildcard address. That bind **succeeds** even while another process holds
`127.0.0.1` on the same port, and a connection to `127.0.0.1:P` then reaches
the more specific binding: the stranger. This machine holds around twenty
loopback-only listeners inside the ephemeral range 49152-65535. Binding
`127.0.0.1` instead fails with `EADDRINUSE`, so the kernel hands out a
genuinely free port and the collision cannot happen.

**Corrections to this block, which was wrong in the way that mattered.** It
said "start with what is actually shared: the `pool` each file ends in its own
`afterAll`, the fixture cleanup order, and whether a file's `pool.end()` can
land while another file's request is in flight." None of the three is
involved. **Two of the recorded failures are on routes that answer before
touching the database at all** -- `POST /benchmark/runs` and
`POST /benchmark/bulks` both fail zod and return 400 with no query -- which
rules the database out on its own and is the thread that was worth pulling.
Class 3, the 30-second hang the block called the decisive one, is a `ws`
server on the other end waiting for a handshake that never comes.

**The fix is not a retry, a timeout or a `.skip`** (O-27). One pre-bound
loopback server per file, in
`artifacts/api-server/src/routes/__integration__/server.ts`, handed to
supertest in place of the app -- so the suite opens 27 servers where it used
to open 178, and every one of them binds `127.0.0.1`. Nothing is silenced;
the cause is removed.

**The first fix was wrong and is worth keeping written down.** Patching
`server.listen` in `setup.ts` to insert the host looked like the smaller
change and broke all 27 files at once: `listen(port, host)` resolves the host
through `dns.lookup`, which defers even for an IP literal, so
`server.address()` is still null on the next line -- and supertest reads it
synchronously, dying with `Cannot read properties of null (reading 'port')`.
**Adding a host argument turns a synchronous bind into an asynchronous one.**
Awaiting the bind once at module load is the only way to hand supertest an
address that is already there.

**Verified:** the acceptance asks for ten runs in a row with the full count
passing. **Thirty were run and all thirty printed `Tests 134 passed (134)`** --
three times the bar, chosen because at the measured rate (3 failures in 33
runs before the fix) ten clean runs would have had better than a one-in-three
chance of happening by luck.

**What it taught:** when a response cannot have come from your code, stop
reading your code. The step said "do not assume the fix is in whichever file
failed most recently" and was right about that and wrong about the rest -- it
still assumed the fix was in a file.
**PR:** one.
**Depends on:** nothing.
**Files:** not yet located — that is the step. The evidence lives in
`artifacts/api-server/src/routes/__integration__/provider-correlation.int.test.ts`,
`artifacts/api-server/src/routes/__integration__/bulk-preview-cancel.int.test.ts` and
`artifacts/api-server/src/routes/__integration__/run-create.int.test.ts`; the likely
seam is the shared setup in
`artifacts/api-server/src/routes/__integration__/setup.ts` and
`artifacts/api-server/src/routes/__integration__/fixtures.ts`. Do not assume the fix is
in whichever file failed most recently.
**Today:** _corrected 2026-09-06 while shipping S-9 — this step used to be titled "the
provider-correlation integration test is order-dependent" and named that one file. The
evidence has contradicted that scope in two ways since._

Three failure classes are on record, in three different files, all one-in-N and none
reproducible on an immediate re-run of the identical tree:

1. **Wrong status.** 2026-09-06 during M-9: `AssertionError: expected 404 to be 200` at
   `provider-correlation.int.test.ts:68`. The next run passed 122/122. A 404 means the
   bulk the test seeded was gone by the time the request ran.
2. **No answer at all.** `Error: socket hang up` in `bulk-preview-cancel.int.test.ts`
   (F-49). No assertion message can help this one.
3. **A hard timeout.** 2026-09-06 during S-9: `run-create.int.test.ts > "refuses a run
   with no calls or no providers"` took **30010ms** and timed out, on a route that
   answered the same request in **103ms** on the very next run, which was 123/123. The
   test posts an empty body and expects a 400.

Class 3 is the one that rules theories out: a wrong status or a vanished row can be
explained by another file's cleanup, but a 30-second hang on a validation-only route
cannot. Any proposed cause must account for all three.

**Change:** find the shared cause and remove it. Instrument first — the suite runs
`fileParallelism: false` against one `TEST_DATABASE_URL`, so start with what is actually
shared: the `pool` each file ends in its own `afterAll`, the fixture cleanup order, and
whether a file's `pool.end()` can land while another file's request is in flight. Make
the finding explicit in the step before changing behaviour.
**Acceptance:** WHEN the integration suite runs 10 times in a row THEN all 10 runs SHALL
report the full test count passing, with no failure in any file.
**Verify:** `for i in $(seq 10); do set -o pipefail; TEST_DATABASE_URL=postgresql://postgres:postgres@localhost:5433/stt_evals_test pnpm --filter @workspace/api-server run test:integration 2>&1 | tee "/tmp/int-$i.log" >/dev/null || echo "FAILED run $i"; done; grep -h "Tests " /tmp/int-*.log`
→ ten lines, each `Tests  123 passed (123)`. The filter is `@workspace/api-server`;
`@stt/api-server` matches nothing and exits 0 (F-103), and `| tee` returns tee's status,
not the suite's, without `set -o pipefail` — so read the ten count lines, never an exit
code.
**Must not:** paper over it with a retry, a longer timeout, or `.skip`. A flaky test that
is silenced is worse than one that fails.

---

## Part U — Mark it here, change the agent there

Asked for 2026-09-09: _"once we go into the result, we should be able to do it
from there. We can mark what things we need to do or update the agent with."_
Two answers followed: mark from **both** the per-call comparison and the
Results card, and a mark must end up **applied to the live assistant in Vapi**.

Three steps, in this order, because the write half has nothing to write until
the mark half exists. U-1 and U-2 touch nothing outside this repo. U-3 is the
first line of code this project has ever written to a production voice agent
and needs its own go.

**Evidence (visual-and-research, 2026-09-09).** Pattern to use: marking and
applying are two separate surfaces with a before → after review in between —
[ElevenLabs agent settings](https://mobbin.com/screens/ff16450b-9de9-4c60-8738-770be8df0a5c)
(published-vs-current diff, a version description, then Publish),
[Railway](https://mobbin.com/screens/131e5390-18b7-4eb6-9715-bb5d9497c7fb)
(old → new per field),
[Arcade](https://mobbin.com/screens/b850abdb-2418-47b3-adaf-eac362756c6d)
(per-item checkboxes at confirm time, "12 of 12 selected"),
[PlanetScale](https://mobbin.com/screens/f207fd84-f5ed-4596-9cae-efab4339d886)
(counts by kind of change),
[Jira](https://mobbin.com/screens/04674b74-506d-4bf1-82e4-606c4a540ab2) (the
confirm screen states the side effects: "Email notifications will NOT be
sent"),
[Workable](https://mobbin.com/screens/a0b8a010-71fe-411d-8b2f-335b33306587).
Patterns to avoid: applying from the same control that captured the mark —
none of the six does it. What operators say: open-ended notes on individual
traces first, group them into a taxonomy of under ten failure modes second,
count the categories third to decide where to spend — and do not force the
categories up front, "Building eval systems that improve your AI product"
(Hamel Husain & Shreya Shankar, 2025-09-09,
https://www.lennysnewsletter.com/p/building-eval-systems-that-improve-your-ai-product);
their worked example is an apartment-leasing assistant, which is this corpus.
Changes to the plan: the typed action became **optional** and the free-text
note **mandatory** — U-1 was drafted the other way round, and the
count-by-type view is the part that earns its keep. No evidence found for the
capture control itself: nothing in the six screens marks a span inside a
diff, so the affordance in U-1 is this project's own.

---

### U-1 — A mark, captured where the problem is visible

**Status:** done 2026-09-09 (U-1a PR #143, U-1b PR #144)

**What it taught:** the step named two capture surfaces and quietly assumed
both could name the assistant a mark belongs to. Only one can. `CallComparison`
-- the per-call view that holds the judge's disputed spans, the whole reason
the comparison is a capture point at all -- carries no assistant id, and adding
one to that contract would have put the basket key in the hands of the surface
least able to be sure of it. The server derives it from the call instead, and
an explicitly sent id still wins. A mark filed under the wrong agent is worse
than one filed under none, and neither looks wrong on screen.

Two smaller things worth keeping. The action pair has to be validated on the
row the write ENDS UP with, not on the body: clearing `actionValue` on an
existing keyterm mark is exactly as broken as creating one without it, and a
PATCH body carrying only `{"actionValue": null}` says nothing about which kind
of mark it is landing on. And the contract's `minLength: 1` is not a guard
against an empty note -- it rejects `""` and accepts `"   "`, which is the one
thing a notes-first feature must not store.

The render suite could not have caught any of this on its own: `results.test.tsx`
never asserts `unmatched` is empty, so the new marks query 500'd silently
behind every existing assertion and every test still passed. The endpoint is in
`baseRoutes` now and the scoping is asserted from `api.calls`, because one
card's marks showing under another's looks perfectly correct on screen.

**PR:** two — `U-1a` schema + contract + routes, `U-1b` the two capture
affordances and the list. Spends nothing.
**Depends on:** nothing.
**Files (U-1a):** new file lib/db/src/schema/agent-marks.ts,
`lib/db/src/schema/index.ts`, `lib/api-spec/openapi.yaml`,
new file artifacts/api-server/src/routes/agent-marks.ts,
`artifacts/api-server/src/routes/index.ts`,
new file artifacts/api-server/src/routes/__integration__/agent-marks.int.test.ts.
**Files (U-1b):** `artifacts/stt-benchmark/src/components/provider-comparison-section.tsx`,
`artifacts/stt-benchmark/src/pages/Rankings.tsx`, a new marks list component
and its render test.

**Today:** there is nowhere to write any of this down. The comparison view
renders the judge's disputed spans (`JudgeKeyDifferences`,
`provider-comparison-section.tsx:284`) and the Results card renders the
assistant's live Vapi config (`Rankings.tsx:349-359`) — between them they hold
the problem and the thing that would fix it, and neither can record a
sentence. No table in `lib/db/src/schema/` stores an annotation of any kind.

**Change:** one table, `agent_marks`:

| column | type | why |
| --- | --- | --- |
| `id` | uuid pk | |
| `assistantId` | text, **nullable** | the basket key. Null is real: calls imported with no `source_assistant_id` are the Results page's own "no assistant on file" bucket, and a mark on one of those is a note with no agent to apply it to. |
| `callId` | uuid, nullable, `onDelete: "set null"` | set when marked from a comparison, null when marked from the Results card. **Not** `cascade` (which `benchmark_agent_scans` uses): a scan is about a call and dies with it, a mark is about the agent and outlives it. |
| `span` | text, nullable | the disputed span the mark came from, copied at mark time. |
| `note` | text, notNull | free text, always required. |
| `actionType` | text, nullable | `keyterm` / `numerals` / `prompt`, or null for "a note, no action yet". |
| `actionValue` | text, nullable | the term to boost, or the prompt change in words. Must be null when `actionType` is `numerals`. |
| `status` | text, notNull, default `open` | `open` / `applied` / `dismissed`. Only U-3 ever writes `applied`. |
| `createdByLabel` | text, nullable | same `x-actor` header convention as `audit_log`. |
| `createdAt` / `updatedAt` | timestamptz | |

Four routes: `POST /benchmark/agent-marks`,
`GET /benchmark/agent-marks` (optional `assistantId`, `callId`, `status`
filters), `PATCH /benchmark/agent-marks/{id}` (note, action, status),
`DELETE /benchmark/agent-marks/{id}`. Every write lands an `audit_log` row,
`entityType: "agent_mark"`.

U-1b: a **Mark** control on each rendered `JudgeKeyDifferences` span
(pre-filling `span` and `callId`) and one on the Results assistant card
(pre-filling `assistantId` only), both opening the same small form — note
first, action optional. Below the Results card, the assistant's open marks
with a count per `actionType`, which is the count-the-categories view the
evidence asks for.

**Why this is worth doing beyond the ask:** R-20 measured that a keyterm list
cannot be mined from this corpus, which is M-19b's second wall. A human
marking terms as they read comparisons is the only remaining source of that
list, so U-1 removes the wall without Tune mode.

**Acceptance (U-1a):** WHEN a mark is POSTed with a note and no action THEN it
SHALL be stored and returned by GET; AND WHEN one is POSTed with
`actionType: "numerals"` and a non-null `actionValue` THEN the API SHALL
answer **400**; AND WHEN one is POSTed with no `note`, or an empty/whitespace
`note`, THEN the API SHALL answer **400**; AND WHEN a marked call is deleted
THEN the mark SHALL survive with `callId` null.
**Acceptance (U-1b):** WHEN the comparison renders a judge key-difference THEN
a Mark control SHALL be present for it; AND WHEN the Results card renders an
assistant with open marks THEN their count SHALL be shown broken down by
action type.
**Verify:** `pnpm run typecheck`; the new integration file through
`tee` (never a short `tail`, never a re-run before the log is read);
`cd artifacts/stt-benchmark && pnpm run test`.
**Must not:** send anything to Vapi (U-3 owns that); write a mark into
`gold_transcript` or any transcript field; make `actionType` mandatory; make a
mark on an unassigned call an error — it is a real note.

---

### U-2 — What the change would actually do to the agent, before anything is sent

**Status:** done 2026-09-09 (PR #145)

**What it taught:** the step asked for each preview row to be *selectable*,
with the selection carried to U-3. Built that way it is a control that lies:
in U-2 there is nothing to submit a selection to, so a checkbox would sit
there recording an intent nothing reads. The selection moved to U-3, where it
has a destination, and U-3's block now says so. The rows themselves are here,
and so is the sentence that the apply does not exist yet -- an absent control
with an explanation beats a present one with none.

The other correction was the cache. `assistantTranscriberConfig` holds a
config for ten minutes, which is right for the Results card and wrong for
this: the preview is the thing somebody reads immediately before asking for a
change, and a stale "current" column is exactly how you approve an edit to a
value that is no longer there. The preview takes a `fresh` option and skips
the cache; the read is free, and `fetchedAt` is in the response so the screen
can say when it looked.

**And the break test found the blind spot the step created.** Emptying
`keyterms` in the Vapi read changed no test result at all: every test built
`VapiAssistantTranscriber` by hand, so nothing exercised the mapping that
produces it. The mapping is now its own exported function with its own tests
(`artifacts/api-server/src/lib/vapi-assistant-transcriber.test.ts`), and the
same mutation fails two of them. **A field nobody proves you read is a field
you are not reading** -- and a new field added to a hand-built fixture shape
is exactly where that hides.

A second lesson, this one about the break test itself: `git checkout <file>`
to undo a mutation silently reverts anything in that file that has not been
committed. Doing it while the fix for the blind spot was still uncommitted
deleted the fix, and the next run's "restored" line read 6 failures. Mutate
and revert only against a committed tree.

Two smaller things. `VapiAssistantTranscriber` carried `keytermCount` but not
the words, so "already there, not added again" could not be computed at all --
the terms are now read too, and the comparison folds case and whitespace,
because "edison hills" and "Edison Hills" are one boost to Deepgram and two
rows to a naive diff. And two people marking the same word is the normal case,
not an error: the second one lands in `alreadyPresent`, so applying can never
double a boost.

**PR:** one. Spends nothing — Vapi **reads** only, which are free.
**Depends on:** U-1.
**Files:** artifacts/api-server/src/routes/agent-marks.ts (from U-1a),
`artifacts/api-server/src/lib/vapi.ts` (read side only),
`lib/api-spec/openapi.yaml`, a new review component in
`artifacts/stt-benchmark/src/`.

**Today:** `fetchVapiAssistantTranscriber` (`vapi.ts:324-386`) reads five
fields off the live assistant. Nothing computes what the open marks would turn
those five into.

**Change:** `GET /benchmark/agent-marks/preview?assistantId=…` reads the live
assistant and returns, per field the open marks touch, the current value and
the value the marks would produce — keyterms as added / already present /
would exceed Deepgram's 100 (M-19a's cap), `numerals` as false → true, prompt
marks as text for a human to act on, never as an automatic edit. The screen
renders one row per field, before → after, each row selectable, with the
selection carried to U-3.

**Acceptance:** WHEN an assistant has open keyterm marks THEN the preview SHALL
show its current keyterm list and the list after; AND WHEN a marked term is
already on the assistant THEN it SHALL be listed as already present and SHALL
NOT appear in the "after" as a duplicate; AND WHEN the marks would push the
list past 100 terms THEN the preview SHALL say so and SHALL NOT silently
truncate.
**Verify:** `pnpm run typecheck`; a unit test on the diff function with a
fixture assistant (no live call); `cd artifacts/stt-benchmark && pnpm run test`.
**Must not:** issue any HTTP method but GET against Vapi; cache the assistant
config in the database; treat a prompt mark as machine-applicable.

---

### U-3 — The first write to a live assistant

**Status:** blocked — needs an explicit go from Abhishek before it ships.
Reverses the posture recorded at `vapi.ts:356` ("Read-only; nothing here
writes to Vapi.") and touches production voice agents taking real calls.

**PR:** one.
**Depends on:** U-2.
**Files:** `artifacts/api-server/src/lib/vapi.ts`,
artifacts/api-server/src/routes/agent-marks.ts (from U-1a), `lib/api-spec/openapi.yaml`,
the U-2 review screen.

**Today:** `vapi.ts` exports fetch/read functions and a private `vapiGet<T>`.
There is no POST, PATCH, PUT or DELETE anywhere in it.

**Change:** `POST /benchmark/agent-marks/apply` takes an assistant id and the
selected mark ids -- **the per-row selection U-2 was originally to carry lives
here**, because this is the first screen where selecting something has
somewhere to go -- **re-reads the assistant immediately before writing**,
merges only the fields the marks touch into the object it just read, and
PATCHes the whole thing back. On success it writes an `audit_log` row carrying
the full before and after transcriber object, and flips those marks to
`applied`.

**The hazard that decides the shape of this step:** `VapiTranscriberSpec`
(`vapi.ts:325`) types only the fields this project reads — its own comment
says anything else stays unread. A PATCH assembled from that type would
silently delete every transcriber field we never modelled. The write must be
read-modify-write on the raw JSON object, never a rebuild from our typed
subset.

**Acceptance:** WHEN apply runs THEN the request body SHALL contain every key
the immediately-preceding read returned, with only the marked fields changed;
AND WHEN the assistant changed between preview and apply THEN the apply SHALL
be refused with **409** and the newer values shown; AND WHEN it succeeds THEN
an `audit_log` row SHALL hold the complete before and after.
**Verify:** the round trip against **one** assistant chosen by Abhishek, with
its transcriber block read and recorded before and after; the 409 proved by
mutating the assistant between preview and apply.
**Must not:** ship before an explicit go; apply without the immediately
preceding read; write a field no mark named; log, store or print a Vapi key;
apply to more than one assistant per request.
