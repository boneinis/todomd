---
id: task-0037
title: Board mic button and wake gate
status: Needs Human
type: module
priority: medium
labels: []
dependencies: [task-0036]
parent: task-0020
created_date: 2026-08-01
source: chunk
assignee: 
agent: claude
triaged: n/a (chunk 3/4 of task-0020)
session_id: 63d840af-a120-414c-862c-91bfd64a73b0
worktree: todomd/task-0037
verification: { attempts: 2, max_attempts: 3, last_verdict: fail }
base_branch: main
cost_usd: 16.0735
needs_human_reason: orphaned_run
recovery_stage: Build
---

## Description

Add the board voice control, strict local Chrome wake adapter, and protected
post-wake OpenAI Realtime WebRTC setup. The board must remain fully usable when
local speech or provider configuration is unavailable.

## Acceptance Criteria

- [ ] The mic control exposes inactive, arming, armed, active, confirming, and error states with visible text and distinct enter/exit earcons.
- [ ] Armed-state recognition requires `processLocally` and a local language pack; ordinary speech stays local and no remote fallback is permitted.
- [ ] Exact finalized `Hey To-do` pauses the wake recognizer and opens a Realtime WebRTC session through a primary-only TODOMD SDP endpoint; the standard OpenAI key never reaches the browser.
- [ ] `That is all, To-do` closes Realtime and returns to local armed listening; `Go offline, To-do` stops every microphone track and returns to inactive.
- [ ] Missing local capability, microphone denial, or missing provider configuration leaves the board usable and provides an understandable diagnostic plus push-to-talk fallback.
- [ ] Focused unit, API, and browser tests pass without a real microphone or network.

## Implementation Plan

1. Turn the spike adapter into a dependency-injected `WakeWordEngine`; keep the
   browser API behind feature checks and never remove `processLocally` on a
   fallback path. Initialize and install the language pack only after an
   explicit arm gesture.
2. Implement the session state machine and Web Audio earcons. Pre-wake results
   are discarded locally; only an exact finalized wake may open remote audio.
3. Add a primary-only `POST /api/voice/session` SDP exchange that forwards to
   OpenAI Realtime with server-owned model, tools, and instructions. Return SDP,
   never the standard key. Missing configuration returns a bounded error.
4. Add the accessible board mic control and diagnostics. Sign-off closes the
   paid session and resumes local listening; offline stops recognition and all
   media tracks. Enforce idle, confirmation, and maximum armed-lifetime limits.
5. Keep push-to-talk available when the local wake release gate is unavailable.
6. Cover strict local behavior, no pre-wake transport, state transitions,
   cleanup, server authorization, secret non-disclosure, and unavailable states.

## Run Log
- 2026-08-01 22:42Z · Build attempt 1 · 101 turns · $11.289 · checkpoint 1: progress detected; continuing
- 2026-08-01 22:47Z · Build attempt 1 · 26 turns · $4.785 · ok
- 2026-08-01 22:52Z · Verify attempt 1 · 1 turns · $0.000 · verdict: fail (unmet: 3)
  - retrying with findings (attempt 2/3)
  - orphaned_run: server restarted during a run — unmerged work is PRESERVED in the worktree/branch
