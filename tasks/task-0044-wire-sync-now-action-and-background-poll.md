---
id: task-0044
title: Wire Sync now action and background polling into the board UI
status: Planned
type: feature
priority: medium
labels: []
dependencies: [task-0043]
parent: task-0033
created_date: 2026-08-02
source: chunk
assignee: 
agent: claude
model: claude-sonnet-5
triaged: n/a (chunk 2/2 of task-0033)
session_id:
worktree:
verification: { attempts: 0, max_attempts: 3, last_verdict: }
---

## Description

Wire Sync now action and background polling into the board UI

## Acceptance Criteria

- [ ] Refresh the open board after local card updates, successful Git pulls, and successful Git pushes
- [ ] Check for remote board metadata changes every 10 minutes while the board is open, plus on start and reconnect
- [ ] Verify the existing Mine view reflects a newly synchronized assignee change
- [ ] Board-only metadata updates do not trigger normal code CI

## Implementation Plan

1. Add an authenticated endpoint in `src/server.js` (near the existing card/pipeline routes,
   following the same `primary`/`viewerAuthed` token pattern used elsewhere) that calls
   `fetchMetadata` + `mergeMetadata` for the current project and returns the
   `{ applied, deferred, conflicts }` result; broadcast `{ type: 'board-changed', project }`
   over the websocket (same broadcast already used at server.js:773) when anything was applied.
2. In `public/app.js`, add a "Sync now" button in the board toolbar (near the existing
   col-head/project controls) that calls the new endpoint and surfaces deferred/conflict results
   inline (a small banner, reusing the existing `.banner-*` pattern near line 155) rather than
   silently discarding them.
3. Add client-side polling: while the board is open, call the sync endpoint every 10 minutes,
   plus once on initial load and once on websocket reconnect (the `ws.onopen`/reconnect path
   near app.js:994). Only poll for the currently open project, and only when
   `github_sync.enabled` is true for that project (read from board/project state already
   fetched by `loadBoard()`).
4. Confirm the existing `board-changed` handler (`app.js:1002`) already reloads the board —
   including the Mine view filter — after a sync applies changes; if the Mine view uses a
   separately cached assignee list, refresh that too.
5. Add/extend tests: `test/server-routes.test.js` (or equivalent) for the new sync endpoint
   (auth required, returns structured result, triggers broadcast only when something changed),
   and a UI-level check (existing Playwright/webapp-testing pattern if present in this repo) that
   clicking Sync now updates the Mine view after a simulated remote assignee change.

## Run Log
