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

`docs/PRD-v5-optimize.md` holds the reasoning. This file holds the work. Only the parts
that have been **grilled and settled** appear as steps; the rest are listed at the bottom
with the questions that must be answered before they can be stepped.

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

## Part A — Setup page

### S-1 — Group Deepgram's domain variants under their base engine

**PR:** one.
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
