---
id: task-0009
title: Fix budget-mode epics never auto-complete after the last chunk
status: Done
type: fix
priority: high
labels: []
dependencies: []
created_date: 2026-06-11
source: ui
assignee:
agent: claude
session_id: 029237d6-ef7c-4867-b14b-7876c9e7815a
worktree:
verification: { attempts: 1, max_attempts: 3, last_verdict: pass }
triaged: 2026-06-11
cost_usd: 1.6074
needs_human_reason:
---

## Description

Found in code review of the agent-built budget support (commits 198ba93, bd31897).

Root cause: `advanceEpicChildren` in `src/chunks.js` only moves ready child chunks to Queue. It lacks the 'all children Done -> move epic to Done' step that launcher's `maybeAdvanceEpic` in `src/pipeline.js` performs. In budget mode the dispatcher cascades via `npx todomd advance <parent>` (which calls `advanceEpicChildren`), so after the LAST chunk reaches Done nothing completes the epic: it stays stuck in Queue forever, and `humanMove` refuses manual moves to Done (ORCH_ONLY).

Fix: make epic auto-completion shared by both the launcher and budget paths. Add an 'all children Done -> move the epic to Done' check into `advanceEpicChildren` (so both the launcher wrapper `advanceChildren` and the `advance` CLI subcommand get it), and make sure launcher's `maybeAdvanceEpic` does not double-move the epic. Only complete when the epic actually has children and every one of them is Done.

## Acceptance Criteria

- [ ] When the last chunk of an epic reaches Done, the epic auto-moves to Done in budget mode (via advanceEpicChildren / the `todomd advance` CLI), matching launcher behavior
- [ ] Launcher-mode epic completion still works with no regression and no double-move of the epic
- [ ] A new test covers budget-mode epic auto-completion (the case the current budget-chunks tests miss)
- [ ] npm test passes

## Triage

**Insight:** The bug is confirmed and precisely located. `advanceEpicChildren` in `src/chunks.js:51-61` only moves Planned children to Queue — it has no "all children Done → complete epic" step. Launcher mode gets that step from `maybeAdvanceEpic` in `src/pipeline.js:522-531`, which reloads the board after calling `advanceChildren` and then calls `orchMove(project, parentId, 'Done', ...)`. Budget mode's `todomd advance` CLI (`bin/todomd.js:163-170`) calls `advanceEpicChildren` directly, bypassing `maybeAdvanceEpic` entirely, so when the last chunk completes the epic stays stuck in Queue forever. `Done` is in `ORCH_ONLY` (`src/pipeline.js:38`), so the user has no manual escape either. The existing `test/budget-chunks.test.js` tests epic approval and inter-chunk cascade but stops short of asserting the epic itself reaches Done after all chunks finish.

**Proposed plan of action:**
1. In `src/chunks.js`, after the Planned→Queue advance loop, reload the board (`loadBoard`) and add an all-children-Done check: if the epic has children and every one has `status === 'Done'`, call `moveCard(repoPath, epicId, 'Done', { reason: 'all chunks complete' })`. The reload is required because the loop above may have just moved some children to Queue, making the original `board` snapshot stale.
2. In `src/pipeline.js`, remove the redundant "all kids Done → orchMove epic" check from `maybeAdvanceEpic` (lines 527-530) — that logic now lives in `advanceEpicChildren` and is shared by both launcher and budget paths. `maybeAdvanceEpic` becomes just the `advanceChildren` call plus the `parentId` guard.
3. Add a test in `test/budget-chunks.test.js`: materialize a 2-chunk epic, move both chunks to Done via `moveCard`, call `advanceEpicChildren(repo, epicId)`, and assert the epic's status is `'Done'`.
4. Run `npm test` and confirm the full test suite passes with no regression.

**Estimate:** S — the root cause is a missing ~5-line block in one function; the fix is a small, self-contained addition to `advanceEpicChildren` plus a minor trim to `maybeAdvanceEpic` and one new test.

**Flags:** None — the description is precise, all relevant code is identified, and no external dependencies or human decisions are needed before implementation.

## Implementation Plan

1. **`src/chunks.js` — add all-children-Done check to `advanceEpicChildren`** (after line 60, before the `return moved` statement):
   - After the Planned→Queue advance loop, call `loadBoard(repoPath, { includeArchived: true })` again to get a fresh snapshot (the prior loop may have just moved children to Queue, making the original `board` stale).
   - Check: if the epic has any children (`kids.length > 0`) and every child has `status === 'Done'`, call `await moveCard(repoPath, epicId, 'Done', { reason: 'all chunks complete' })`.
   - All required symbols (`loadBoard`, `moveCard`) are already imported at line 1 — no new imports needed.

2. **`src/pipeline.js` — remove redundant check from `maybeAdvanceEpic`** (lines 526–530):
   - Delete the board-reload and the `if (kids.length && kids.every(...)) orchMove(...)` block from `maybeAdvanceEpic`.
   - `maybeAdvanceEpic` becomes simply: read `parentId`, guard on it, call `advanceChildren`.
   - This avoids a double-move: `advanceChildren` now delegates to the updated `advanceEpicChildren` which already handles the Done transition.

3. **`test/budget-chunks.test.js` — add budget-mode epic auto-completion test** (after the existing test at line 118):
   - Set up a budget repo with a 2-chunk epic using the existing `budgetRepo()` / `writeEpicCard()` / `materializeChunks()` helpers.
   - Move both child chunks to `Done` via `moveCard`.
   - Call `advanceEpicChildren(repo, epicId)`.
   - Assert `status(repo, epicId) === 'Done'`.

4. **Run `npm test`** and confirm the full suite passes.

Risks: None identified. The only behavioral change in `maybeAdvanceEpic` is removing code that is now subsumed by `advanceEpicChildren`; any launcher-path test covering epic completion will catch a regression.

## Run Log
- 2026-06-11 23:44Z · Triage · 17 turns · $0.599 · ok
- 2026-06-11 23:45Z · Plan · 10 turns · $0.201 · ok
- 2026-06-11 23:47Z · Build attempt 1 · 15 turns · $0.398 · ok
- 2026-06-11 23:48Z · Verify attempt 1 · 12 turns · $0.409 · verdict: pass
