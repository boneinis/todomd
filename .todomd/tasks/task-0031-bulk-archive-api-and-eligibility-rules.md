---
id: task-0031
title: Bulk archive API and eligibility rules
status: Planned
type: improvement
priority: medium
labels: []
dependencies: []
parent: task-0027
created_date: 2026-07-31
source: chunk
assignee: 
agent: claude
triaged: n/a (chunk 1/2 of task-0027)
session_id:
worktree:
verification: { attempts: 0, max_attempts: 3, last_verdict: }
---

## Description

Bulk archive API and eligibility rules

## Acceptance Criteria

- [ ] bulkArchiveTargets selects only existing, non-archived, Done cards and reports a reason for every id it rejects.
- [ ] The age option excludes cards newer than the cutoff and never archives a card whose created_date is missing or unparseable.
- [ ] POST /api/cards/bulk-archive archives the eligible cards and returns every non-archived id with its reason in a failed list.
- [ ] One card failing does not abort the batch, and cards outside Done are never archived.
- [ ] Bulk-archived cards are restorable through the existing per-card archive route.
- [ ] Unit tests in test/board.test.js and API tests in test/server-routes.test.js cover selection, age cutoff, mixed eligibility, partial failure, viewer rejection, and restore.

## Implementation Plan

1. `src/board.js` — add and export a pure helper
   `bulkArchiveTargets(cards, { ids, olderThanDays = null, today })` next to
   `setArchived` (~line 358). It takes board cards (the flat shape
   `loadBoard` returns), and partitions the requested `ids` into
   `{ eligible: [id...], skipped: [{ id, reason }...] }`. A card is eligible
   only when it exists, `status === 'Done'`, is not already `archived`, is
   not `unparseable`, and — when `olderThanDays` is set — its `created_date`
   is on or before `today - olderThanDays` days. Reasons are stable strings:
   `not-found`, `not-done`, `already-archived`, `too-recent`, `no-date`.
   A card with `olderThanDays` set but no parseable `created_date` is
   skipped as `no-date` — never archived by an age rule it can't be judged by.
2. `src/server.js` — add a `POST /api/cards/bulk-archive` route beside the
   per-card archive route (~line 508). Parse `{ ids: [], olderThanDays }`;
   reject a non-array `ids`, an empty list, or a list over 500 with 400.
   Load the board (`includeArchived: true`) and call `bulkArchiveTargets`
   to get the eligible set — the client's list is a *request*, the server
   re-derives what is actually archivable.
3. In that route, archive eligible cards **sequentially**, reusing the exact
   per-card guard sequence already at `src/server.js:514-519`: skip with
   reason `run-in-progress` if `pipeline.hasLiveRun`, skip with
   `child-building` if it's an epic with `pipeline.hasLiveBuildingChild`,
   else `await pipeline.releaseCardResources`, then
   `pipeline.cascadeEpicCleanup` for epics, then `await setArchived(..., true)`.
   Wrap each card in try/catch so one failure cannot abort the batch.
   Sequential, not parallel: `setArchived` commits per card and the repo
   lock/index is shared.
4. Return 200 with `{ ok, requested, archived: [id...], failed: [{ id, reason }...] }`
   — `failed` merges ineligible and errored cards. `ok` is true only when
   `failed` is empty; the response always lists every id that did not
   archive, so no failure is hidden. Never return a bare success count.
5. Gate the route to full access exactly like the other write routes (mirror
   how `/api/cards/:id/archive` is reached — a viewer must get the same
   rejection; see the viewer assertion in `test/server-routes.test.js:265`).
6. Unit tests in `test/board.test.js`: `bulkArchiveTargets` keeps only Done
   cards, drops non-Done / already-archived / unknown ids with the right
   reason, applies the age cutoff at the boundary (a card exactly N days old
   is eligible; N-1 days is `too-recent`), and skips a Done card with a
   missing or malformed `created_date` as `no-date`. Pass a fixed `today` —
   do not let the test depend on the wall clock.
7. API tests in `test/server-routes.test.js`: bulk-archive hides the listed
   Done cards from the default board and shows them with `?archived=1`;
   a mixed request (one Done, one Queue, one unknown id) archives only the
   Done card and reports the other two in `failed`; `olderThanDays` archives
   only the older card; a viewer is rejected; the archived cards restore via
   the existing `POST /api/cards/:id/archive` `{"archived":false}` route.

## Run Log
