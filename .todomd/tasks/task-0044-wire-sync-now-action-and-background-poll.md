---
id: task-0044
title: Wire Sync now action and background polling into the board UI
status: Verify
type: feature
priority: medium
labels: []
sprint: sprint-1
dependencies: [task-0043]
parent: task-0033
created_date: 2026-08-02
source: chunk
assignee: 
agent: claude
model: claude-sonnet-5
triaged: n/a (chunk 2/2 of task-0033)
session_id: 2d7bc16d-a18b-4bde-94a5-ade06de0a851
worktree: todomd/task-0044
verification: { attempts: 3, max_attempts: 3, last_verdict: fail }
base_branch: main
ci_evidence: { head: 8283ad8f615ba070ad8f7497b63f03bed80beecc, command: npm test, execution: local, passed_at: '2026-09-29T05:23:21.917Z', clean: true }
ci_remote: {  }
build_profile: standard
build_limits: { max_slices: 3, budget_minutes: 60 }
cost_usd: 45.9258
needs_human_reason:
recovery_stage:
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
- 2026-09-29 03:14Z · Build attempt 1 · 101 turns · claude/claude-sonnet-5 · subscription CLI · 200 input, 10.54M cached, 66.8K output · $3.356 est · checkpoint 1/3 (standard): worktree progress detected; continuing
- 2026-09-29 03:21Z · Build attempt 1 · 54 turns · claude/claude-sonnet-5 · subscription CLI · 108 input, 10.48M cached, 19.6K output · $5.829 est · incomplete: uncommitted candidate changes
  - uncommitted_build: Build finished but left uncommitted changes. Resume Build and commit or intentionally discard them before CI:
M public/app.js
 M public/index.html
 M src/github-sync.js
 M src/server.js
 M test/github-sync.test.js
 M test/server-routes.test.js
?? test/ui/sync.test.js
- 2026-09-29 03:22Z · Resume Build · continuing attempt 1 after uncommitted_build in preserved worktree todomd/task-0044
- 2026-09-29 03:23Z · Build attempt 1 · 4 turns · claude/claude-sonnet-5 · subscription CLI · 8 input, 876.5K cached, 743 output · $6.024 est · incomplete: uncommitted candidate changes
  - uncommitted_build: Build finished but left uncommitted changes. Resume Build and commit or intentionally discard them before CI:
M public/app.js
 M public/index.html
 M src/github-sync.js
 M src/server.js
 M test/github-sync.test.js
 M test/server-routes.test.js
?? test/ui/sync.test.js
- 2026-09-29 03:26Z · Resume Build · continuing attempt 1 after uncommitted_build in preserved worktree todomd/task-0044
- 2026-09-29 03:36Z · Build attempt 1 · 17 turns · claude/claude-sonnet-5 · subscription CLI · 34 input, 3.92M cached, 5.8K output · $6.934 est · ok
- 2026-09-29 03:41Z · CI attempt 1 · 295.9s · `npm test` passed
- 2026-09-29 03:42Z · Verify attempt 1 · 1 turns · codex/gpt-5.6-sol · subscription CLI · 32.4K input, 0 cached, 2.9K output · $0.000 est · verdict: fail (unmet: 1)
  - retrying with findings (attempt 2/3)
- 2026-09-29 04:00Z · Build attempt 2 · 42 turns · claude/claude-sonnet-5 · subscription CLI · 84 input, 11.68M cached, 30.8K output · $9.805 est · ok
- 2026-09-29 04:04Z · CI attempt 2 · 232.5s · `npm test` passed
- 2026-09-29 04:05Z · Verify attempt 2 · 1 turns · codex/gpt-5.6-sol · subscription CLI · 34.3K input, 0 cached, 3.8K output · $0.000 est · verdict: fail
  - escalating after 2 failed reviews: Fable diagnosis → Fable repair → final Codex gate
- 2026-09-29 04:08Z · Escalate attempt 2 · 12 turns · claude/claude-fable-5 · subscription CLI · 18 input, 184.5K cached, 6.9K output · $1.189 est · diagnosis complete
- 2026-09-29 04:18Z · Build attempt 3 · 34 turns · claude/claude-fable-5 · subscription CLI · 58 input, 2.02M cached, 43.3K output · $6.132 est · incomplete: uncommitted candidate changes
  - uncommitted_build: Build finished but left uncommitted changes. Resume Build and commit or intentionally discard them before CI:
M src/github-sync.js
 M test/github-sync.test.js
 M test/server-routes.test.js
 M test/ui/sync.test.js
- 2026-09-29 04:19Z · Resume Build · continuing attempt 3 after uncommitted_build in preserved worktree todomd/task-0044
- 2026-09-29 04:20Z · Build attempt 3 · 10 turns · claude/claude-sonnet-5 · subscription CLI · 20 input, 729.0K cached, 3.1K output · $6.657 est · ok
- 2026-09-29 04:25Z · CI attempt 3 · 296.7s · `npm test` passed
- 2026-09-29 04:26Z · Verify attempt 3 · 1 turns · codex/gpt-5.6-sol · subscription CLI · 39.8K input, 0 cached, 2.4K output · $0.000 est · verdict: fail
  - attempts_exhausted: Adversarial review found a reachable cross-project race in public/app.js. runSync() does not capture the project or veri
…
ning A's banner. Capture the requested project/generation at invocation and discard UI effects when it no longer matches currentProject; optionally abort the obsolete request. Trusted CI passed npm test for exact clean candidate HEAD f929fdbb7f1a2a6e19700f4daab2a2da153eea56.
- 2026-09-29 04:36Z · CI attempt 3 · 148.5s · `npm test` passed
- 2026-09-29 04:39Z · Verify attempt 3 · 1 turns · codex/gpt-5.6-sol · subscription CLI · 856.9K input, 762.5K cached, 8.8K output · $0.000 est · verdict: fail
  - attempts_exhausted: Concrete transactional bug in src/github-sync.js:169-243. mergeMetadata writes or deletes remote files before commitPath
…
on wedged and the board changed despite the failed response. Make application transactional and restore both worktree and index on commit failure, or preflight all refusal conditions and preserve accurate result/state semantics. Add regression coverage for a rejected commit.
- 2026-09-29 04:46Z · CI attempt 3 · 181.0s · `npm test` passed
- 2026-09-29 04:49Z · Verify attempt 3 · 1 turns · codex/gpt-5.6-sol · subscription CLI · 455.3K input, 322.9K cached, 6.8K output · $0.000 est · verdict: fail
  - attempts_exhausted: `src/github-sync.js:202-205` and `:228-233` can silently overwrite a genuine local edit. `historicalBaseMatches()` treat
…
ormal three-way conflict when `lastRef` exists, and for first sync require evidence from local history that the path has not diverged; otherwise defer it as a conflict. Trusted CI reports `npm test` passed at the exact clean candidate HEAD; it was not rerun per instructions.
- 2026-09-29 04:58Z · CI attempt 3 · 173.8s · `npm test` passed
- 2026-09-29 05:03Z · Verify attempt 3 · 1 turns · codex/gpt-5.6-sol · subscription CLI · 842.0K input, 754.7K cached, 9.9K output · $0.000 est · verdict: fail
  - attempts_exhausted: 1. `mergeMetadata()` can overwrite an actively running card. The path-level merge in `src/github-sync.js:200` applies th
…
edits remain unable to publish. Preserve/reconcile the fetched metadata ancestry or use a lease-protected publication strategy, and add a two-clone pull → local edit → push regression test.

Trusted CI for exact HEAD 964348a passed `npm test`; it was not rerun as instructed.
- 2026-09-29 05:12Z · CI attempt 3 · 174.8s · `npm test` passed
- 2026-09-29 05:16Z · Verify attempt 3 · 1 turns · codex/gpt-5.6-sol · subscription CLI · 1.13M input, 1.03M cached, 8.1K output · $0.000 est · verdict: fail (unmet: 1)
  - attempts_exhausted: 1. Partial merges can destroy unresolved remote changes. When mergeMetadata applies some paths while reporting other pat
…
estructive source-deleting push a fast-forward. That can update the code branch and trigger normal CI. Reject the remote default/protected/current code branches before creating or pushing the metadata commit.
- unmet: Board-only metadata updates do not trigger normal code CI
- 2026-09-29 05:23Z · CI attempt 3 · 170.8s · `npm test` passed
