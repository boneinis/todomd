---
id: task-0018
title: pipeline.js + server.js cascadeEpicCleanup ordering and destructive-op guard
status: Done
type: fix
priority: medium
labels: []
dependencies: []
parent: task-0014
created_date: 2026-06-12
source: chunk
assignee: 
agent: claude
triaged: n/a (chunk 4/5 of task-0014)
session_id: 02afb45f-91c8-4435-8c7d-a609ef3f1640
worktree:
verification: { attempts: 1, max_attempts: 3, last_verdict: pass }
cost_usd: 1.8467
---

## Description

pipeline.js + server.js: cascadeEpicCleanup ordering and destructive-op guard

## Acceptance Criteria

- [ ] cascadeEpicCleanup no longer leaves an archived+Review child for a live cancellation
- [ ] the destructive-op guard detects a building child of an epic, and DELETE-epic cleans up children
- [ ] npm test passes

## Implementation Plan

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

## Run Log
- 2026-06-12 09:03Z · Build attempt 1 · 40 turns · $1.347 · ok
- 2026-06-12 09:06Z · Verify attempt 1 · 17 turns · $0.500 · verdict: pass
