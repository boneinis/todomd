---
id: task-0036
title: Voice session and summary API
status: Queue
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
session_id:
worktree:
verification: { attempts: 0, max_attempts: 3, last_verdict: }
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
