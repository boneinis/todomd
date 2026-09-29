---
id: task-0038
title: Command routing confirmation browser tests
status: Done
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
session_id: 019fc286-e635-7023-8d3a-7d58ef8d0f4e
worktree:
verification: { attempts: 3, max_attempts: 3, last_verdict: pass }
base_branch:
cost_usd: 40.3103
needs_human_reason:
recovery_stage:
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
- 2026-08-02 01:03Z · Build attempt 1 · 101 turns · $9.071 · checkpoint 1: progress detected; continuing
- 2026-08-02 01:10Z · Build attempt 1 · 30 turns · $4.819 · ok
- 2026-08-02 01:15Z · Verify attempt 1 · 1 turns · $0.000 · verdict: fail (unmet: 2)
  - retrying with findings (attempt 2/3)
- 2026-08-02 01:38Z · Build attempt 2 · 101 turns · $15.925 · checkpoint 1: progress detected; continuing
- 2026-08-02 01:43Z · Build attempt 2 · 6 turns · $3.456 · ok
- 2026-08-02 01:50Z · Verify attempt 2 · 1 turns · $0.000 · verdict: fail (unmet: 2)
  - escalating after 2 failed reviews: Fable diagnosis → Opus repair → final Codex gate
- 2026-08-02 01:52Z · Escalate attempt 2 · 12 turns · $1.583 · diagnosis complete
- 2026-08-02 02:04Z · Build attempt 3 · 69 turns · $5.456 · ok (escalation repair)
- 2026-08-02 02:09Z · Verify attempt 3 · 1 turns · $0.000 · verdict: fail (unmet: 1)
  - attempts_exhausted: `npm test` passed with normal runtime permissions: 449 core tests and 25 browser tests. However, the confirmation read-back has a reachable response-correlation race. `public/voice/commands.js:68-125` stores one global `pendingReadback` and binds it to the first `response.created` observed; the `response.create` sent at lines 240-242 contains no correlation metadata. An unrelated response already 
- 2026-08-02 12:11Z · Verify attempt 3 · 1 turns · $0.000 · verdict: fail (unmet: 2)
  - attempts_exhausted: `npm test` passes with localhost access: 450 unit tests and 25 UI tests. Two reachable bugs remain. First, confirmation transcripts are not fenced by capture time: microphone transcription remains active during read-back, and audio committed then may finish transcribing after the confirmation state opens. That delayed challenge phrase is accepted, allowing assistant echo or recorded playback to co
- 2026-08-02 12:29Z · Verify attempt 3 · 1 turns · $0.000 · verdict: fail (unmet: 1)
  - attempts_exhausted: Boolean verdict: false.

1. `public/voice/commands.js:45-49` sends GA `session.update` events without the required `session.type: "realtime"` discriminator. The official generated OpenAPI type requires it ([OpenAI Realtime types](https://raw.githubusercontent.com/openai/openai-node/master/src/resources/realtime/realtime.ts)). The server can reject both suppression and restoration updates, while th
- 2026-08-02 12:43Z · Verify attempt 3 · 1 turns · $0.000 · verdict: fail
  - attempts_exhausted: Blocking adversarial finding: the session uses `tool_choice: 'auto'` without disabling parallel tool calls in [src/realtime.js](/Users/irvinbowman/web%20dev/TODOMD/.todomd/worktrees/task-0038/src/realtime.js:92). The current Realtime API permits `auto` to select one or more tools and supports parallel tool calls for this model family ([official reference](https://developers.openai.com/api/referenc
- 2026-08-02 12:55Z · Verify attempt 3 · 1 turns · $0.000 · verdict: pass
