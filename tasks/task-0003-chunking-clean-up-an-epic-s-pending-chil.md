---
id: task-0003
title: Chunking clean up an epic's pending child cards on cancel/archive
status: Done
type: improvement
priority: medium
labels: []
dependencies: []
created_date: 2026-06-11
source: ui
assignee:
agent: claude
session_id: b91ef17b-f2f4-49c4-b8ec-ab58f8a68beb
worktree:
verification: { attempts: 1, max_attempts: 3, last_verdict: pass }
triaged: 2026-06-11
cost_usd: 3.7893
needs_human_reason:
---

## Description

Pulling an epic back to Review, or archiving/deleting it, currently orphans its not-yet-Done child cards. Cascade the cleanup: archive (reversible, preferred) every child that is not Done, releasing any in-flight build resources; keep Done children (they merged real work).

Touch: src/pipeline.js (humanMove Review-cancel epic branch, reuse releaseCardResources), src/board.js (setArchived/deleteCard cascade when target is an epic). Tests.

## Acceptance Criteria

- [ ] Pulling an epic back to Review archives its non-Done children and leaves Done children intact
- [ ] Archiving/deleting an epic cascades to its pending children
- [ ] Any in-flight child run is cancelled and its worktree/queue/coordination released

## Implementation Plan

1. **Add `setArchived` to the `board.js` import in `src/pipeline.js`** (line 4):
   ```js
   import { loadConfig, loadBoard, readCard, moveCard, patchFrontmatter, appendRunLog, commitCardChanges, withRepoLock, parseChunks, setArchived } from './board.js';
   ```

2. **Add `cascadeEpicCleanup(project, epicId)` in `src/pipeline.js`** (after `releaseCardResources`, around line 214):
   ```js
   export async function cascadeEpicCleanup(project, epicId) {
     const board = loadBoard(project.path); // active (non-archived) children only
     const pending = board.cards.filter((c) => c.parent === epicId && c.status !== 'Done' && !c.epic);
     for (const child of pending) {
       const childKey = runKey(project.name, child.id);
       const childLive = children.get(childKey);
       if (childLive) {
         const run = runs.get(childKey);
         run.cancelled = true;
         run.revertTo = 'Review';
         childLive.kill('SIGTERM');
         // cancel handler releases resources async; setArchived below serializes via withRepoLock
       } else {
         await releaseCardResources(project, child.id);
       }
       await setArchived(project.path, child.id, true);
     }
     if (pending.length) {
       await appendRunLog(project.path, epicId,
         `- ${now()} · cascade-archive: archived ${pending.length} pending child(ren)`);
     }
   }
   ```

3. **Wire `humanMove → Review` (no-live-run branch) in `src/pipeline.js`** (line 295):
   Currently `return moveCard(project.path, id, 'Review', { reason: 'retriage' });` — change to:
   ```js
   const result = await moveCard(project.path, id, 'Review', { reason: 'retriage' });
   if (card.data.epic) await cascadeEpicCleanup(project, id);
   return result;
   ```

4. **Wire the archive handler in `src/server.js`** (around line 452–455):
   After the existing `releaseCardResources` call, before `setArchived`, read the card and cascade if epic:
   ```js
   if (on) await pipeline.releaseCardResources(project, archiveMatch[1]);
   const archCard = readCard(project.path, archiveMatch[1]);
   if (on && archCard?.data?.epic) await pipeline.cascadeEpicCleanup(project, archiveMatch[1]);
   const result = await setArchived(project.path, archiveMatch[1], !!on);
   ```
   (`pipeline.cascadeEpicCleanup` requires adding `cascadeEpicCleanup` to the named import of `pipeline` — the server already does `import * as pipeline from './pipeline.js'` so it's available automatically once exported.)

5. **Wire the delete handler in `src/server.js`** (around line 370–374):
   After the existing `releaseCardResources` call, before `deleteCard`, read the card and cascade if epic:
   ```js
   await pipeline.releaseCardResources(project, cardMatch[1]);
   const delCard = readCard(project.path, cardMatch[1]);
   if (delCard?.data?.epic) await pipeline.cascadeEpicCleanup(project, cardMatch[1]);
   const result = await deleteCard(project.path, cardMatch[1]);
   return json(res, result.ok ? 200 : 400, result);
   ```

6. **Add tests in `test/pipeline.test.js`** — three tests using the existing `makeRepo` / `writeCard` / `until` helpers:

   a. *humanMove Review on an epic archives non-Done chunks, preserves Done chunks:*
      - `writeCard(repo, 'epic-001', { status: 'Queue', extra: 'epic: true\nchildren: [chunk-001, chunk-002]\n' })`
      - `writeCard(repo, 'chunk-001', { status: 'Done', extra: 'parent: epic-001\n' })`
      - `writeCard(repo, 'chunk-002', { status: 'Queue', extra: 'parent: epic-001\n' })`
      - `await pipeline.humanMove(p, 'epic-001', 'Review')`
      - Assert `chunk-001` status is `Done` and not archived; assert `chunk-002` is archived.

   b. *cascadeEpicCleanup directly archives all non-Done children:*
      - Same setup as (a) but with one more child at `Build` status.
      - Call `await pipeline.cascadeEpicCleanup(p, 'epic-001')` directly.
      - Assert each non-Done child has `archived` frontmatter set; Done child unchanged.

   c. *Done children preserved when epic is retried to Review:*
      - Setup: epic with all children Done except one at `Needs Human`.
      - `humanMove → Review` on the epic.
      - Assert Done children untouched; Needs Human child is archived.

   Risks:
   - **SIGTERM race on live children**: when `cascadeEpicCleanup` SIGTERMs a live child and then immediately calls `setArchived`, the child's cancel handler (which later calls `orchMove` + possibly `removeWorktree`) serializes via `withRepoLock`. The child may land at `archived=true, status=Review` — acceptable. Un-archive cascade on epic restore is **out of scope** (only archive direction is required).
   - **Double worktree removal**: if a child had a live run and a worktree, the cancel handler removes the worktree AND `releaseCardResources` (which is skipped for live children in the cascade) would also try to remove it. Since we skip `releaseCardResources` for live children, this double-removal is avoided.

## Triage

**Insight:** Three distinct entry points in the codebase currently handle an epic being removed from the board — `humanMove → Review` (pipeline.js:283-294, the no-live-run branch), the `archive` handler (server.js:452-455), and the `delete` handler (server.js:370-374) — and none of them look up the epic's children or cascade. `releaseCardResources` (pipeline.js:202) already handles all per-card cleanup (queue slot, retry findings, coordination, worktree); the missing piece is a loop over the epic's non-Done children that calls it and then archives each. One subtle edge: a child may itself have a live run when the cascade fires, and SIGTERM + archive needs to be sequenced so the child's cancel handler doesn't race against archiving the card.

**Proposed plan of action:**
1. Add `cascadeEpicCleanup(project, epicId)` in pipeline.js: load the board (including archived), filter children where status !== 'Done', for each: mark any live run cancelled via the existing `run.cancelled = true` + SIGTERM path, call `releaseCardResources`, then `setArchived`; append a single summary line to the epic's run log.
2. In `humanMove` (pipeline.js:291-294), after the no-live-run `releaseCoordination` + `moveCard` block, check `card.data.epic` and `await cascadeEpicCleanup(project, id)` before returning.
3. Export `cascadeEpicCleanup` and call it from server.js archive handler (after `releaseCardResources`, before `setArchived`) when the target card has `epic: true`.
4. Call the same exported function from server.js delete handler for epic cards before `deleteCard`.
5. Add tests in `test/pipeline.test.js`: (a) humanMove Review on an in-progress epic archives non-Done chunks; (b) archiving an epic cascades to pending children; (c) Done children are preserved across all three paths.

**Estimate:** M — three wiring points, an edge case around live-run cancellation ordering, and tests for each path; no schema changes, no new pipeline stages, but care is needed around the async SIGTERM + archive race.

**Flags:**
- When a live child run is SIGTERMed during cascade, should the child's cancel handler still record a run-log entry on the child card (normal cancel path does this), or is a silent kill acceptable given the child is about to be archived? The current `cancel()` function does not await child exit before returning, so a race between the build's cancel cleanup and `setArchived` is real.
- After un-archiving the epic, should the cascade be reversible (i.e., un-archive the children too)? The description says "archive (reversible, preferred)" but the reverse direction is not mentioned — confirm whether that is out of scope.

## Run Log
- 2026-06-11 21:14Z · Triage · 11 turns · $0.475 · ok
- 2026-06-12 00:51Z · Plan · 20 turns · $0.564 · ok
- 2026-06-12 01:00Z · Build attempt 1 · 26 turns · $0.675 · ok
- 2026-06-12 01:02Z · Verify attempt 1 · malformed verdict, re-running once
- 2026-06-12 01:06Z · Verify attempt 1 · 16 turns · $0.275 · failed: bad_verdict
- 2026-06-12 01:19Z · Build attempt 1 · 38 turns · $1.247 · ok
- 2026-06-12 01:25Z · Verify attempt 1 · 26 turns · $0.553 · verdict: pass
