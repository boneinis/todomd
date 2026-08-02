---
id: task-0043
title: Fetch and merge remote board metadata safely
status: Planned
type: module
priority: medium
labels: []
dependencies: []
parent: task-0033
created_date: 2026-08-02
source: chunk
assignee: 
agent: claude
model: claude-sonnet-5
triaged: n/a (chunk 1/2 of task-0033)
session_id:
worktree:
verification: { attempts: 0, max_attempts: 3, last_verdict: }
---

## Description

Fetch and merge remote board metadata safely

## Acceptance Criteria

- [ ] Provide a visible Sync now action that fetches remote board metadata safely
- [ ] Do not overwrite active worktrees or local in-progress card state; show conflicts or deferred sync clearly

## Implementation Plan

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

## Run Log
