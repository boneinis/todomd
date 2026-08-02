---
id: task-0037
title: Board mic button and wake gate
status: Done
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
session_id: 019fbfe6-8091-7ab1-8638-d1157f3fc351
worktree:
verification: { attempts: 3, max_attempts: 3, last_verdict: pass }
base_branch:
cost_usd: 28.5062
needs_human_reason:
recovery_stage:
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
- 2026-08-01 23:10Z · Resume Build · continuing attempt 2 in preserved worktree todomd/task-0037
- 2026-08-01 23:18Z · Build attempt 2 · 5 turns · $4.109 · ok
- 2026-08-01 23:18Z · Verify attempt 2 · 0 turns · $0.000 · infrastructure: Codex verification infrastructure: /Users/irvinbowman/.npm-global/bin/codex in /Users/irvinbowman/web dev/TODOMD/.todomd/worktrees/task-0037 exited 1; stderr: file:///Users/irvinbowman/.npm-global/lib/node_modules/@openai/codex/bin/codex.js:105 throw new Error( ^ Error: Missing optional dependency @openai/codex-darwin-x64. Reinstall Codex: npm install -g @openai/codex@latest a; no final message or structured output; no valid verdict
- 2026-08-01 23:18Z · Verify attempt 2 · malformed verdict, re-running once
- 2026-08-01 23:18Z · Verify attempt 2 · 0 turns · $0.000 · infrastructure: Codex verification infrastructure: /Users/irvinbowman/.npm-global/bin/codex in /Users/irvinbowman/web dev/TODOMD/.todomd/worktrees/task-0037 exited 1; stderr: file:///Users/irvinbowman/.npm-global/lib/node_modules/@openai/codex/bin/codex.js:105 throw new Error( ^ Error: Missing optional dependency @openai/codex-darwin-x64. Reinstall Codex: npm install -g @openai/codex@latest a; no final message or structured output; no valid verdict
  - bad_verdict: Codex verification infrastructure: /Users/irvinbowman/.npm-global/bin/codex in /Users/irvinbowman/web dev/TODOMD/.todomd/worktrees/task-0037 exited 1; stderr: file:///Users/irvinbowman/.npm-global/lib/node_modules/@openai/codex/bin/codex.js:105 throw new Error( ^ Error: Missing optional dependency @openai/codex-darwin-x64. Reinstall Codex: npm install -g @openai/codex@latest a; no final message or
- 2026-08-01 23:28Z · Verify attempt 2 · 1 turns · $0.000 · verdict: fail (unmet: 3)
  - escalating after 2 failed reviews: Fable diagnosis → Opus repair → final Codex gate
- 2026-08-01 23:32Z · Escalate attempt 2 · 24 turns · $2.887 · diagnosis complete
- 2026-08-01 23:44Z · Build attempt 3 · 72 turns · $5.437 · ok (escalation repair)
- 2026-08-01 23:48Z · Verify attempt 3 · 1 turns · $0.000 · verdict: fail
  - attempts_exhausted: `npm test` passed: 413 unit/API tests and 12 browser tests. However, adversarial review found three reachable bugs:

1. Fresh supported Chrome profiles cannot install a downloadable language pack. The `install:false` probe reports `supported:false` for `downloadable`, and [main.js](/Users/irvinbowman/web%20dev/TODOMD/.todomd/worktrees/task-0037/public/voice/main.js:110) hides the Arm button. That 
- 2026-08-01 23:58Z · Verify attempt 3 · 1 turns · $0.000 · verdict: fail (unmet: 2)
  - attempts_exhausted: The configured `npm test` passed with normal listener/process permissions: 414 core/API tests and 14 browser tests. `git diff --check main...HEAD` also passed. Adversarial review found three reachable defects:

1. Startup race: `public/app.js:109` emits the one-shot `todomd:context` event after asynchronous board loading, while `public/voice/main.js:91` registers its listener only after the voice 
- 2026-08-02 00:08Z · Verify attempt 3 · 1 turns · $0.000 · verdict: fail (unmet: 1)
  - attempts_exhausted: 1. The push-to-talk fallback is nonfunctional after microphone denial or missing provider configuration. `public/voice/controller.js` marks these failures `fallback: true`, but `pushToTalkStart()` retries the same `getUserMedia` and `/api/voice/session` path that just failed. The tests only verify that the button becomes visible. Provide an actually operable fallback/recovery path instead of treat
- 2026-08-02 00:17Z · Verify attempt 3 · 1 turns · $0.000 · verdict: fail
  - attempts_exhausted: Real cross-file race in public/app.js: loadBoard() does not snapshot the requested project or use a request generation. It fetches the board for the project selected at invocation, but after await it renders that response and publishes the current global currentProject. If an in-flight request for project A finishes after switching to B, it can undo the switch handler's voice revocation by publish
- 2026-08-02 00:24Z · Verify attempt 3 · 1 turns · $0.000 · verdict: fail
  - attempts_exhausted: Reachable cross-project privacy bug: `public/app.js:1208-1212` removes a project, then `loadProjects()` can silently change `currentProject` to another registered project without first publishing the revoked voice context. An armed recognizer or live Realtime session therefore remains active and bound to the removed project until the replacement board request finishes; if that request fails, captu
- 2026-08-02 00:34Z · Verify attempt 3 · 1 turns · $0.000 · verdict: fail (unmet: 1)
  - attempts_exhausted: Reachable push-to-talk cleanup bug in public/voice/main.js:78-105: mouse PTT ends only on mouseup/mouseleave, and blur cleanup is restricted to keyboardHeld. If the user presses PTT, switches windows while the pointer remains over the button, then releases outside Chrome, the browser receives neither mouseup nor mouseleave and ignores focus loss. A headless-Chrome reproduction observed {state:"act
- 2026-08-02 00:40Z · Verify attempt 3 · 1 turns · $0.000 · verdict: pass
