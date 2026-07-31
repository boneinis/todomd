---
id: task-0016
title: chunks.js exclude archived in advanceEpicChildren and abort materializeChunks on failure
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
triaged: n/a (chunk 2/5 of task-0014)
session_id: 5dbdbc55-6e9a-4ac2-9a30-0ed0eac33e40
worktree:
verification: { attempts: 1, max_attempts: 3, last_verdict: pass }
cost_usd: 0.8769
---

## Description

chunks.js: exclude archived in advanceEpicChildren and abort materializeChunks on failure

## Acceptance Criteria

- [ ] advanceEpicChildren excludes archived children from completion and dep-gate, and won't complete a withdrawn epic; tests cover both
- [ ] materializeChunks aborts cleanly on a partial chunk-create failure (no contiguous-chain gap); a test covers it
- [ ] npm test passes

## Implementation Plan

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

## Run Log
- 2026-06-12 08:50Z · Build attempt 1 · 25 turns · $0.527 · ok
- 2026-06-12 08:52Z · Verify attempt 1 · 10 turns · $0.350 · verdict: pass
