---
id: task-0014
title: Fix the chunking/budget adversarial-review gaps
status: Done
type: fix
priority: high
labels: []
dependencies: []
created_date: 2026-06-12
source: ui
assignee:
agent: claude
session_id: 545386af-c4a3-4185-8bd0-15327a1268df
worktree:
verification: { attempts: 0, max_attempts: 3, last_verdict: }
triaged: 2026-06-12
cost_usd: 1.1607
needs_human_reason:
epic: true
children: [task-0015, task-0016, task-0017, task-0018, task-0019]
---

## Description

Backlog of correctness gaps found by the adversarial multi-agent review of the chunking/budget feature, plus two session follow-ups. These are independent fixes across separate files, so split this into one chunk per fix.

1. board.js `createCard` (~L437): the chunk `plan` is interpolated into `## Implementation Plan` UNSANITIZED, so a plan containing a `## ` heading creates a duplicate section and `appendRunLog` then writes into the wrong place, corrupting the Run Log. Sanitize/guard the injected plan so it can't introduce a top-level `## ` heading (title is already sanitized; do the same for plan).

2. board.js `parseChunks` (~L153): it is fence-UNAWARE (`split(/^## /m)` + bare ```yaml regex), so a card that documents the chunk format inside a fenced code block is parsed as a real split. Make it ignore `## Chunks` / yaml inside fenced code blocks, the way `appendRunLog` already tracks fences.

3. chunks.js `advanceEpicChildren` (~L62): the completion check and dependency gate use `includeArchived: true`, so an archived/cancelled chunk that is not Done strands the epic in Queue forever and blocks the next chunk. Exclude archived children. Also guard the epic-completion move so it only fires when the epic is still a live tracker (don't resurrect an epic a human dragged to Review).

4. chunks.js `materializeChunks` (~L33): on a partial chunk-create failure the loop `continue`s before updating `prev`, wiring the next chunk's dependency past the dropped one, so the epic auto-completes with silently missing work. On any chunk-create failure, abort/rollback cleanly (don't materialize a partial epic).

5. bin/todomd.js `fanout` (~L154) is not idempotent — it only checks `parseChunks >= 2`, never whether the card is already an epic, so a re-run creates DUPLICATE child cards. Bail if the card already has `epic: true` / `children`. Also `advance` (~L168) exits 0 on a wrong/non-epic id (silent cascade stall) — validate the id resolves to an epic and report a non-zero / clear no-op.

6. pipeline.js `cascadeEpicCleanup`: for a LIVE child it sets run.cancelled + SIGTERMs then immediately `await setArchived(child)`, without awaiting the async cancel cleanup, which later moves the card to Review — leaving an inconsistent `archived + status:Review` card. Order it so the cancel cleanup completes before (or instead of) the archive.

7. server.js / pipeline.js: the destructive-op guard checks `hasLiveRun(epicId)` only — epics never run, so deleting/archiving an epic with a BUILDING child isn't refused. Detect a live child. And DELETE-epic should cancel/cleanup pending children, not orphan them.

8. templates.js `CMD_BUILD`: instruct the build agent to commit ONLY its changed source/test files (never `git add -A`/`git add .`, never anything under `.todomd/`), so non-claude builders don't trip the `board_tampering` guard.

9. test/pipeline.test.js `cancel mid-build`: make it timing-independent so it stops flaking under full-suite CPU load (don't depend on real SIGTERM delivery timing).

## Acceptance Criteria

- [ ] createCard sanitizes the injected chunk plan so it cannot create a duplicate top-level heading; a test covers it
- [ ] parseChunks ignores ## Chunks / yaml inside fenced code blocks; a test with a fenced example returns []
- [ ] advanceEpicChildren excludes archived children from completion + dep-gate, and won't complete a withdrawn epic; tests cover both
- [ ] materializeChunks aborts cleanly on a partial chunk-create failure (no contiguous-chain gap); a test covers it
- [ ] todomd fanout is idempotent (bails when already an epic) and todomd advance validates the id; tests cover both
- [ ] cascadeEpicCleanup no longer leaves an archived+Review child for a live cancellation
- [ ] the destructive-op guard detects a building child of an epic, and DELETE-epic cleans up children
- [ ] CMD_BUILD instructs committing only changed source/test files (never git add -A or .todomd/)
- [ ] the cancel mid-build test is timing-independent and stable under load
- [ ] npm test passes

## Triage

**Insight:** All 9 bugs are real and confirmed in the current code. The most dangerous are #4 (`materializeChunks` partial-failure silently leaves a gapped epic that later auto-completes with missing work) and #6 (`cascadeEpicCleanup` races `setArchived` against the async cancel handler, leaving an `archived+Review` card). Fix #3 is a double bug: `advanceEpicChildren` includes archived children in both the dep-gate filter (L69) and the completion check (L76-78), and has no guard on the epic's own current status. The `CMD_BUILD` prompt gap (#8) is subtle — rule 5 says "commit your changes" without explicitly forbidding `git add -A`, which is exactly what non-claude builders do, tripping `board_tampering`. The cancel mid-build test (#9) already uses `until()` polling but still depends on real SIGTERM delivery timing for the intermediate `Build` state assertion.

**Proposed plan of action:**
1. **board.js `createCard`** — before interpolating `plan` into the card body, strip or escape any line-leading `##` sequences (e.g. replace `/^#{1,6}\s/gm` with an indented equivalent, as is done for `title` with `[:#[\]{}]`); add a test: a plan containing `## Foo` must not create a `## Foo` section in the resulting card.
2. **board.js `parseChunks`** — replace the bare `body.split(/^## /m)` with a fence-aware section splitter (track `` ``` `` open/close as `appendRunLog` does) so that `## Chunks` / yaml inside a fenced block is ignored; add a test: a card body with a fenced `## Chunks` yaml block returns `[]`.
3. **chunks.js `advanceEpicChildren`** — change both `loadBoard` calls to `{ includeArchived: false }` so archived/cancelled children are excluded from the dep-gate and completion check; add a guard so the epic-completion `moveCard` only fires when the epic's current status is a live tracker state (not Review/Done/Needs Human); add tests for both.
4. **chunks.js `materializeChunks`** — on any `createCard` failure, call `deleteCard` for all already-created siblings and return early without calling `patchFrontmatter` or `moveCard`; add a test: a failure on chunk 2 of 3 leaves zero children and the epic unmoved.
5. **bin/todomd.js `fanout`** — add a pre-check: bail with exit 1 if `card.data.epic === true` or `(card.data.children?.length > 0)`; in `advance`, resolve the card and bail with exit 1 + non-zero if it's not an epic; add tests for both idempotency and the invalid-id case.
6. **pipeline.js `cascadeEpicCleanup`** — for live children, do NOT call `setArchived` immediately; instead let the existing cancel-cleanup handler finish (it already handles worktree/status/resources), then call `setArchived` from within that handler's post-cancel path; for non-live children the current `releaseCardResources + setArchived` ordering is fine; add/extend a test that verifies no `archived+Review` card is left.
7. **server.js + pipeline.js destructive-op guard** — in `server.js`, before the `hasLiveRun(epicId)` check for DELETE and archive, also check `loadBoard` for any live children of an epic (or export a `hasLiveBuildingChild` helper from `pipeline.js`); ensure DELETE-epic cancels/cleans up children via `cascadeEpicCleanup` before deleting (it already calls this but only after the live-run check); add a test: DELETE on an epic with a building child returns 400.
8. **templates.js `CMD_BUILD`** — replace rule 5 with an explicit instruction: stage only the specific source/test files that were changed (e.g. `git add <files>`), never `git add -A` or `git add .`, and never add or commit anything under `.todomd/`; verify the `CMD_BUILD` template test covers this wording.
9. **test/pipeline.test.js cancel mid-build** — remove the intermediate `status === 'Build'` assertion that depends on real SIGTERM timing; keep only the terminal `status === 'Review'` + `!fs.existsSync(wt)` + `worktree === ''` polls (all already use `until()`); optionally skip the intermediate assertion or restructure the test around the fake-agent hang marker alone.

**Estimate:** L — 9 independent fixes across 6 files (`board.js`, `chunks.js`, `bin/todomd.js`, `pipeline.js`, `server.js`, `templates.js`) plus the test file; each fix is targeted, but the breadth and the requirement for a new or extended test per fix makes this a large task even though no individual fix exceeds ~15 lines.

**Flags:** Fix #6 requires a decision on where to call `setArchived` for live children — two approaches: (a) skip `setArchived` inside `cascadeEpicCleanup` for live children and instead call it at the end of the existing cancel-cleanup path in the child's exit handler (cleaner, but requires threading `setArchived` into the exit-handler flow); or (b) add a short `await waitForExit(childLive)` before `setArchived` inside `cascadeEpicCleanup`. Option (a) is architecturally cleaner; option (b) risks blocking the event loop. Human should confirm which approach is preferred before the Build agent touches `cascadeEpicCleanup`.

## Implementation Plan

## Chunks

```yaml
- title: "board.js: sanitize plan injection and fence-aware parseChunks"
  type: fix
  needs: []
  plan: |
    1. In src/board.js createCard (around L441), before interpolating `plan`
       into the card body, sanitize it: replace line-leading heading markers
       so they cannot create new `##` sections. Apply
       `plan.replace(/^(#{1,6}) /gm, (_, h) => '\\' + h + ' ')` to the local
       `plan` variable (backslash-escapes leading `#` chars so they render as
       literals). Apply this BEFORE the template literal.
    2. In src/board.js parseChunks (L153-154), replace
       `body.split(/^## /m)` with a fence-aware split: iterate lines,
       toggle a `fenced` boolean on lines whose first non-whitespace chars
       are ` ``` ` (same pattern as `appendRunLog`), and split only on
       `## `-prefixed lines when `!fenced`. The rest of parseChunks
       (finding the Chunks section, extracting yaml) remains unchanged.
    3. In test/board.test.js, add:
       (a) A test calling createCard with a plan containing `## Foo\n\n## Bar`
           and asserting the resulting file body contains no unescaped `## Foo`
           or `## Bar` section headings.
       (b) A test calling parseChunks on a body where `## Chunks` and the yaml
           are inside a fenced code block and asserting it returns [].
    4. Run `npm test` — all tests must pass.
  criteria:
    - createCard sanitizes the injected chunk plan so it cannot create a duplicate top-level heading; a test covers it
    - parseChunks ignores ## Chunks and yaml inside fenced code blocks; a test with a fenced example returns []
    - npm test passes

- title: "chunks.js: exclude archived in advanceEpicChildren and abort materializeChunks on failure"
  type: fix
  needs: []
  plan: |
    1. In src/chunks.js advanceEpicChildren (L67 and L75), change BOTH
       `loadBoard` calls from `{ includeArchived: true }` to
       `{ includeArchived: false }`.
    2. After the completion check (before L78 `moveCard`), add a guard:
       call `readCard(repoPath, epicId)` to get the current epic status and
       only call `moveCard` to Done if `epic.data.status` is one of
       `Planned`, `Queue`, or `Build` (i.e., skip if the epic is already
       in Review/Done/Needs Human/Cancelled — the human dragged it there
       intentionally).
    3. In src/chunks.js materializeChunks (L45-48), replace the `continue`
       block with an abort-and-rollback:
       (a) Add `import { readCard, loadBoard, createCard, patchFrontmatter,
           appendRunLog, moveCard, deleteCard } from './board.js';` at the top
           (add `deleteCard`).
       (b) On `!res.ok`: iterate `ids` in reverse and `await deleteCard(
           repoPath, deletedId)` for each already-created sibling, then
           `return []` immediately — never reach `patchFrontmatter` or
           `moveCard`.
    4. In test/chunks.test.js (or equivalent), add:
       (a) Test: advanceEpicChildren with an archived non-Done child — epic
           still completes (archived child is excluded from the `every Done`
           check).
       (b) Test: epic already in Review status — advanceEpicChildren does NOT
           call moveCard to Done.
       (c) Test: createCard fails on chunk 2 of 3 — returned ids is [], no
           child cards exist on disk, epic frontmatter unchanged.
    5. Run `npm test` — all tests must pass.
  criteria:
    - advanceEpicChildren excludes archived children from completion and dep-gate, and won't complete a withdrawn epic; tests cover both
    - materializeChunks aborts cleanly on a partial chunk-create failure (no contiguous-chain gap); a test covers it
    - npm test passes

- title: "bin/todomd.js: fanout idempotency and advance validation"
  type: fix
  needs: []
  plan: |
    1. In bin/todomd.js fanout handler (after L159 where the card is read),
       add: if `card.data?.epic === true` or `card.data?.children?.length > 0`,
       print `already fanned out: <id>` to stderr and `process.exit(1)`.
    2. In bin/todomd.js advance handler (after the card is loaded), add: if
       `!card` or `!card.data?.epic`, print `not an epic: <id>` to stderr
       and `process.exit(1)`.
    3. In the test suite (test/cli.test.js or equivalent), add:
       (a) Test: `todomd fanout` on a card that already has `epic: true` in
           frontmatter — assert exit code 1.
       (b) Test: `todomd advance` on a non-epic card id — assert exit code 1.
    4. Run `npm test` — all tests must pass.
  criteria:
    - todomd fanout is idempotent (bails when already an epic) and todomd advance validates the id; tests cover both
    - npm test passes

- title: "pipeline.js + server.js: cascadeEpicCleanup ordering and destructive-op guard"
  type: fix
  needs: []
  plan: |
    1. In src/pipeline.js cascadeEpicCleanup (L219-231), for LIVE children:
       do NOT call `await setArchived(...)` immediately after the kill.
       Instead set `run.cascadeArchive = true` on the run object (alongside
       `run.cancelled = true`). Remove `await setArchived(project.path,
       child.id, true)` from the live branch; keep it only in the else
       (non-live) branch.
    2. In the Build cancel path (~L666-674), after `removeWorktree` and
       `patchFrontmatter({ worktree: '' })`, add:
         if (run.cascadeArchive) {
           await setArchived(project.path, id, true);
           return sendState(project, id, 'idle');
         }
       This archives the card AFTER cleanup is complete and skips `orchMove`
       so the card never gets status=Review.
    3. Repeat step 2 for the Verify cancel path (~L711-718) with the same
       pattern.
    4. Add a helper export to src/pipeline.js:
         export function hasLiveBuildingChild(projectName, epicPath, epicId) {
           const board = loadBoard(epicPath, { includeArchived: false });
           return board.cards
             .filter(c => c.parent === epicId && !c.epic)
             .some(c => hasLiveRun(projectName, c.id));
         }
       (Adjust signature to match the project/path pattern used elsewhere.)
    5. In src/server.js DELETE handler (L370-376): before the `hasLiveRun`
       check, also check `pipeline.hasLiveBuildingChild(...)` for the card
       and return 400 if true.
    6. In src/server.js archive handler (L448-459): same — add
       `hasLiveBuildingChild` check before the existing guard.
    7. In the test suite, add:
       (a) Test: cascadeEpicCleanup on an epic with a live child — after
           cleanup the child card is archived and does NOT have status Review.
       (b) Test: DELETE on an epic with a building child — assert HTTP 400.
    8. Run `npm test` — all tests must pass.
    Risks: The cascadeArchive-flag approach (option a from triage) requires
    every cancel path (Build AND Verify) to handle the flag. If a new stage
    is added in future, it must handle cascadeArchive. Option (b) — awaiting
    child exit inside cascadeEpicCleanup — was rejected (blocks event loop).
  criteria:
    - cascadeEpicCleanup no longer leaves an archived+Review child for a live cancellation
    - the destructive-op guard detects a building child of an epic, and DELETE-epic cleans up children
    - npm test passes

- title: "templates.js + test: CMD_BUILD commit instruction and timing-stable cancel test"
  type: fix
  needs: []
  plan: |
    1. In src/templates.js CMD_BUILD rule 5 (L117): replace the current text
       with: "Commit your changes on the current branch. Stage only the
       specific source/test files you modified (`git add <file1> <file2>
       ...`). **Never use `git add -A` or `git add .`**, and **never add or
       commit anything under `.todomd/`**. Follow the repository's commit
       conventions — if commitlint/husky enforce Conventional Commits, use an
       appropriate type (`feat:`/`fix:`/`test:`…); include the task id in the
       message. Do not push, do not switch branches, do not merge."
    2. In test/pipeline.test.js cancel mid-build test (L137): change the
       `until()` condition from
         `status(repo, 'task-0001') === 'Build' && fs.existsSync(marker)`
       to just `fs.existsSync(marker)`. The hang marker is sufficient to
       prove the fake agent is running — no need for the Build status flip.
    3. On L139 (`assert.ok(fs.existsSync(wt))`): wrap with
         `await until(() => fs.existsSync(wt), { timeout: 15000 })`
       before the assertion, since the worktree may appear slightly after
       the marker in the fake agent startup sequence.
    4. If a CMD_BUILD template test exists (e.g. test/templates.test.js),
       update it to assert the new rule 5 text explicitly prohibits
       `git add -A` and `.todomd/`.
    5. Run `npm test` — all tests must pass.
  criteria:
    - CMD_BUILD instructs committing only changed source/test files (never git add -A or .todomd/)
    - the cancel mid-build test is timing-independent and stable under load
    - npm test passes
```

## Run Log
- 2026-06-12 08:33Z · Triage · 21 turns · $0.591 · ok
- 2026-06-12 08:38Z · Plan · 8 turns · $0.570 · ok
- 2026-06-12 08:38Z · Plan · split into 5 chunks (DAG): task-0015 → task-0016 → task-0017 → task-0018 → task-0019
