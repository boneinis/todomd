---
id: task-0036
title: Voice session and summary API
status: Verify
type: module
priority: medium
labels: []
dependencies: [task-0035]
parent: task-0020
created_date: 2026-08-01
source: chunk
assignee: 
agent: claude
triaged: n/a (chunk 2/4 of task-0020)
session_id: 019fbe1a-05ba-70c1-813e-5f93c423f7f9
worktree: todomd/task-0036
verification: { attempts: 3, max_attempts: 3, last_verdict: fail }
base_branch: main
cost_usd: 21.2105
needs_human_reason:
recovery_stage:
---

## Description

Add deterministic voice summaries and a prepare/confirm/reject Actions API. The
API remains the sole authority for board changes; the speech model may propose
an action but cannot execute or confirm it.

## Acceptance Criteria

- [ ] `GET /api/voice/summary` returns a deterministic concise status derived from the live board, including Needs Human and active-run details.
- [ ] Voice action preparation returns an opaque proposal ID, exact read-back, expiry, and confirmation policy without changing the board.
- [ ] Confirm and reject endpoints bind to the exact pending proposal, revalidate card state and eligibility, execute at most once, and reject stale, expired, ambiguous, or replayed requests.
- [ ] The allowlist exposes only existing guarded board operations; arbitrary routes, shell commands, Git writes, source edits, deletion, and bulk actions are unavailable.
- [ ] Focused unit and API tests pass.

## Implementation Plan

1. Add a deterministic summary builder over the existing board object. Keep the
   spoken result short and include active runs and actionable Needs Human cards.
2. Add primary-only endpoints to prepare, confirm, and reject one pending voice
   action. Store an opaque, short-lived proposal bound to project, card, expected
   state, action arguments, confirmation policy, and one-time nonce.
3. Reuse the existing transition and recovery guards when confirming. Revalidate
   against the live card before execution and consume the proposal atomically.
4. Allow read-only report/card-status calls without confirmation. Require `Yes
   To-do` for harmless reversible moves, a fresh task-specific challenge for
   actions that start or resume agents, and visible approval for cancel,
   restart-build, and archive. Never expose delete or arbitrary API dispatch.
5. Add focused unit and server-route coverage for proposal binding, expiry,
   replay, stale card state, ambiguity, confirmation tiers, and allowed actions.

## Run Log
- 2026-08-01 14:47Z · Build attempt 1 · 73 turns · $5.964 · ok
- 2026-08-01 14:53Z · Verify attempt 1 · 1 turns · $0.000 · verdict: fail (unmet: 2)
  - retrying with findings (attempt 2/3)
- 2026-08-01 15:07Z · Build attempt 2 · 69 turns · $8.931 · ok
- 2026-08-01 15:13Z · Verify attempt 2 · 1 turns · $0.000 · verdict: fail (unmet: 3)
  - escalating after 2 failed reviews: Fable diagnosis → Opus repair → final Codex gate
- 2026-08-01 15:14Z · Escalate attempt 2 · 12 turns · $1.670 · diagnosis complete
- 2026-08-01 15:28Z · Build attempt 3 · 50 turns · $4.645 · ok (escalation repair)
- 2026-08-01 15:34Z · Verify attempt 3 · 1 turns · $0.000 · verdict: fail (unmet: 3)
  - attempts_exhausted: Configured `npm test` passed outside the restricted sandbox: 305 core/API tests and 5 UI tests. `git diff --check` passed and the worktree remained clean. However, adversarial review found three reachable defects:

1. Cross-project active-run leakage: `src/pipeline.js:1787-1791` associates pending runs using `key.startsWith(projectName + ':')`. With projects named `alpha` and `alpha:beta`, a pendi
- 2026-08-01 15:45Z · Verify attempt 3 · 1 turns · $0.000 · verdict: fail (unmet: 1)
  - attempts_exhausted: Bulk actions remain reachable through voice approval. In src/voice.js, the `approve` eligibility check only requires `status === 'Planned'`; it does not reject an epic with unfinished children. Confirming that proposal calls `humanMove(..., 'Queue')`, whose epic branch invokes `advanceChildren` and releases child cards. An adversarial reproduction prepared the action with HTTP-equivalent status 20
- 2026-08-01 15:55Z · Verify attempt 3 · 1 turns · $0.000 · verdict: fail (unmet: 2)
  - attempts_exhausted: Configured `npm test` passed with normal process/listener permissions: 308 core/API and 5 UI tests. However:

1. `src/pipeline.js:1816-1820` now checks only `pending` in `projectHasLiveRun()`, assuming every child is part of a pending build chain. Plan/custom trigger runs created at `src/pipeline.js:887-912` have a live `runs`/`children` entry but no `pending` entry. Reproduced: a hanging Plan run
- 2026-08-01 16:28Z · Verify attempt 3 · 1 turns · $0.000 · verdict: fail (unmet: 1)
  - attempts_exhausted: Blocking race: `confirmVoiceAction` revalidates at src/voice.js:449, then executes asynchronously at line 455 without holding the board mutation lock. Reproduction: prepare `approve` for a Planned card, begin confirmation, concurrently change it to Needs Human while `humanMove` awaits `isGitRepo`, and confirmation returns 200 after moving the now-stale card to Queue. Make revalidation, eligibility
