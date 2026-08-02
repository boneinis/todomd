---
id: task-0038
title: Command routing confirmation browser tests
status: Build
type: module
priority: medium
labels: []
dependencies: [task-0037]
parent: task-0020
created_date: 2026-08-01
source: chunk
assignee: 
agent: claude
triaged: n/a (chunk 4/4 of task-0020)
session_id:
worktree: todomd/task-0038
verification: { attempts: 1, max_attempts: 3, last_verdict:  }
base_branch: main
---

## Description

Connect Realtime read/proposal tools to the Actions API, implement deterministic
confirmation and recovery commands, and verify the complete foreground flow.

## Acceptance Criteria

- [ ] Realtime tools are limited to board report, card status, and action proposal; the model has no execute or confirm tool.
- [ ] Read-only commands run immediately, while every mutation uses the server proposal and its required confirmation tier; unrelated speech, rejection, timeout, stale state, and replay execute nothing.
- [ ] Voice exposes guarded Resume Build and Retry Verification using preserved worktrees, and clearly distinguishes Resume Build from destructive Restart Build.
- [ ] Sign-off closes only the active conversation and returns to armed; offline stops all capture and returns to inactive.
- [ ] Browser tests cover reporting, proposal/read-back/confirm, rejection, recovery actions, sign-off, offline, unavailable capability, and zero pre-wake network traffic.
- [ ] `npm test` passes.

## Implementation Plan

1. Configure Realtime with only `read_board_report`, `read_card`, and
   `propose_board_action`. Validate every tool argument and render deterministic
   server results; never let model prose become an executable action.
2. Implement normalized card references and constrained intents for report,
   status, move, resume build, retry verification, restart build, cancel,
   confirm, reject, sign-off, and offline. Ambiguity asks for clarification.
3. Bind the browser confirmation state to the server proposal. Suppress model
   tool/response generation while awaiting confirmation, discard buffered
   audio, accept only finalized user input, and execute exactly once through the
   confirm endpoint.
4. Map Resume Build and Retry Verification to their existing eligibility guards
   and preserved worktree behavior. Keep cancel, Restart Build, and archive
   behind visible approval; never expose delete.
5. Add mocked end-to-end browser coverage for wake, reports, action confirmation
   tiers, cancellation paths, recovery actions, sign-off/offline, cleanup, and
   unavailable states. Assert no real microphone, provider call, or pre-wake
   network traffic is used in tests.

## Run Log
