---
id: task-0033
title: Synchronize team assignments through GitHub
status: Planned
type: improvement
priority: high
labels: [sync, github, team]
dependencies: []
created_date: 2026-07-31
source: ui
assignee:
agent: claude
model: claude-sonnet-5
effort: low
session_id: 8ee5e756-4988-4ee5-b4d1-5249b2b3b92e
worktree:
verification: { attempts: 0, max_attempts: 3, last_verdict: }
triaged: 2026-07-31
cost_usd: 0.5822
needs_human_reason:
epic: true
children: [task-0043, task-0044]
---

## Description

Enable separate To-do MD computers to share assignment updates through the tracked board metadata in GitHub without triggering normal code CI or overwriting active work.

## Acceptance Criteria

- [ ] Publish shared board task and configuration metadata to the dedicated GitHub board-state branch after local card updates and Git actions
- [ ] Provide a visible Sync now action that fetches remote board metadata safely
- [ ] Refresh the open board after local card updates, successful Git pulls, and successful Git pushes
- [ ] Check for remote board metadata changes every 10 minutes while the board is open, plus on start and reconnect
- [ ] Do not overwrite active worktrees or local in-progress card state; show conflicts or deferred sync clearly
- [ ] Board-only metadata updates do not trigger normal code CI
- [ ] Verify the existing Mine view reflects a newly synchronized assignee change

## Implementation Plan

## Chunks

```yaml
- title: Fetch and merge remote board metadata safely
  type: module
  plan: |
    1. `src/github-sync.js` already has `pushMetadata`/`createMetadataScheduler` (subtree-split push
       to the `github_sync.branch` state branch, gated on `cfg.enabled`, wired into `src/server.js`
       around line 752). Add the fetch/merge counterpart alongside it:
       - `fetchMetadata(project)`: `git fetch <remote> <branch>` then diff the fetched tree
         (`git diff --stat HEAD:.todomd <remote>/<branch>`-style, reusing the same clean()/run()
         helpers) against the local `.todomd` tree. Return a structured result describing which
         task files changed remotely.
       - `mergeMetadata(project, remoteResult)`: for each remotely-changed task file, skip (defer)
         it if the local card is `status: Build`/has a live worktree/live run (reuse
         `hasLiveRun`/`hasLiveBuildingChild`-style checks already used by server.js), or if the
         local file has uncommitted/newer local changes than the last known synced state. Otherwise
         fast-forward that file's content from the remote branch. Never touch `config.yml` if the
         local copy differs from the last-synced baseline (config edits are user intent, not a
         merge target). Return `{ applied: [...], deferred: [...], conflicts: [...] }`.
    2. Track "last known synced state" per project (e.g. a small state file under
       `.todomd/` or in-memory map keyed by project path + branch SHA) so merge can tell "remote
       changed since last sync" from "remote == what we last saw."
    3. Add `test/github-sync.test.js` coverage: fetch with sync disabled is inert (existing pattern
       for `pushMetadata`); merge skips a task file whose card has a live worktree/build in progress;
       merge applies a remote assignee change to a card with no local conflict; merge reports a
       conflict when local and remote both changed the same file since the last sync.
  criteria:
    - Provide a visible Sync now action that fetches remote board metadata safely
    - Do not overwrite active worktrees or local in-progress card state; show conflicts or deferred sync clearly

- title: Wire Sync now action and background polling into the board UI
  needs: [Fetch and merge remote board metadata safely]
  type: feature
  plan: |
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
  criteria:
    - Refresh the open board after local card updates, successful Git pulls, and successful Git pushes
    - Check for remote board metadata changes every 10 minutes while the board is open, plus on start and reconnect
    - Verify the existing Mine view reflects a newly synchronized assignee change
    - Board-only metadata updates do not trigger normal code CI
```

## Run Log
- 2026-07-31 21:53Z · Triage · 4 turns · $0.182 · ok
- 2026-08-02 13:37Z · Plan · 12 turns · $0.400 · ok
- 2026-08-02 13:37Z · Plan · split into 2 chunks (DAG): task-0043 → task-0044

## Triage

- **Decision:** Split into smaller cards.
- **Rationale:** This bundles several distinct concerns — a git-backed board-state branch/publish mechanism, a manual Sync-now action, automatic refresh/polling triggers, conflict handling for active worktrees, and a CI-exclusion guarantee for board-only commits. Each has its own design and failure modes and is independently testable.
- **Risks or questions:** Conflict-resolution strategy (what "defer sync" looks like) and the branch/commit scheme for board metadata are non-trivial design choices that should be settled before implementation; CI exclusion mechanism needs to match the existing workflow triggers in `.github/workflows/ci.yml`.
- **Next step:** Split into cards for (1) board-state git branch publish/fetch mechanism with CI exclusion, (2) Sync-now UI action, (3) auto-refresh/polling triggers with conflict-safe merge behavior.
