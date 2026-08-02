---
id: task-0042
title: Surface resource state and deferral reasons on the board
status: Planned
type: improvement
priority: medium
labels: []
dependencies: [task-0041]
parent: task-0021
created_date: 2026-08-02
source: chunk
assignee: 
agent: claude
triaged: n/a (chunk 4/4 of task-0021)
session_id:
worktree:
verification: { attempts: 0, max_attempts: 3, last_verdict: }
---

## Description

Surface resource state and deferral reasons on the board

## Acceptance Criteria

- [ ] The board displays current CPU, memory and disk resource state from the governor.
- [ ] A card deferred for load shows the specific reason it was deferred, sourced from the governor reasons.
- [ ] The CI column renders between Build and Verify on the board.
- [ ] npm test passes, including new API, UI and browser coverage for the resource indicator and deferral badge.

## Implementation Plan

1. In `src/server.js`, expose governor + scheduler state — either a new
   `GET /api/resources` or an addition to the existing board state payload —
   returning `{ metrics, deferring, critical, reasons, limits, running: { global, byColumn } }`,
   and include each deferred card's `deferredReason` in its card payload.
2. Push the same state over the existing realtime channel (`src/realtime.js`)
   on each governor tick so the board updates without polling.
3. Render in `public/app.js` + `public/style.css`: a board-level resource
   indicator (CPU / memory / disk with the current governor state) and, on any
   card in `deferred-for-load`, a badge showing the human-readable reason taken
   from `reasons`. Add the CI column to the board's column rendering and to the
   drag/drop rules so a human cannot drag a card into an invalid CI state.
4. Tests: `test/server-routes.test.js` for the endpoint shape; a `test/ui/`
   unit test for the indicator and the deferral badge; and a browser test in
   `test/browser.js` asserting the CI column renders between Build and Verify
   and that a deferred card shows its reason text.
Note: GitHub Actions stays the external safety net — this chunk adds no new
remote CI. Only local job state is displayed.

## Run Log
