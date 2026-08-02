---
id: task-0020
title: Add privacy-safe voice control to TODOMD
status: Done
type: module
priority: critical
labels: [voice, accessibility, realtime]
dependencies: []
created_date: 2026-07-31
source: ui
assignee:
agent: claude
session_id: 38a06b75-8ad3-4791-8d2a-3363cb8e39e6
worktree:
verification: { attempts: 0, max_attempts: 3, last_verdict: }
triaged: failed (agent)
needs_human_reason:
cost_usd: 0.7195
epic: true
children: [task-0035, task-0036, task-0037, task-0038]
---

## Description

Add a foreground, privacy-safe TODOMD voice controller. After one deliberate
arm action, Chrome listens locally for **Hey To-do**. Only post-wake audio may
open an OpenAI Realtime WebRTC conversation. TODOMD—not the speech model—owns
action preparation, read-back, confirmation, eligibility checks, and dispatch.

The first release targets the desktop board. It does not automate Codex,
ChatGPT, Siri, Gemini, Slack, or browser chrome. Mobile foreground use and a
native background companion remain follow-ups after the desktop flow is proven.

## Acceptance Criteria

- [ ] The design selects a strict on-device wake path with a measured release gate and no browser-cloud fallback; the board provides push-to-talk when local wake is unavailable.
- [ ] The board has accessible inactive, armed, active, confirming, and error states with distinct entry and exit sounds.
- [ ] Ordinary conversation stays on-device and only exact finalized **Hey To-do** can open the remote voice service.
- [ ] The standard OpenAI key stays server-side and the protected session endpoint exposes only a WebRTC SDP answer.
- [ ] Read-only reports run immediately; every board mutation is prepared, read back, bound to an exact expiring proposal, revalidated, and confirmed at the required tier before execution.
- [ ] **That is all, To-do** closes the active conversation and returns to local armed listening; **Go offline, To-do** stops all microphone tracks and returns to inactive.
- [ ] Guarded Resume Build and Retry Verification reuse preserved task worktrees; destructive or high-risk operations are not voice-only.
- [ ] Focused unit, API, and browser tests cover capability failure, activation, zero pre-wake transport, confirmation, recovery, sign-off, offline, and cleanup, and `npm test` passes.

## Implementation Plan

Deliver the four child cards in order. Do not add a wake dependency or vendor
key unless the task-0035 Chrome hardware gate fails and the fallback is reviewed.
Keep all authority in existing guarded board APIs and do not widen agent, shell,
Git, filesystem, or browser permissions.

## Chunks

```yaml
- title: Voice spike and design doc
  task: task-0035
  plan: Select Chrome strict-local speech conditionally, document Porcupine and native fallbacks, define the SDP and confirmation contracts, and complete the real microphone reliability gate.
  needs: []

- title: Voice session and summary API
  task: task-0036
  plan: Add deterministic summaries plus prepare/confirm/reject endpoints with exact proposal binding, expiry, replay protection, live-state revalidation, and confirmation tiers.
  needs: [task-0035]

- title: Board mic button and wake gate
  task: task-0037
  plan: Add the accessible state machine, strict local wake adapter, Web Audio earcons, protected server-mediated Realtime SDP exchange, cleanup, and push-to-talk fallback.
  needs: [task-0036]

- title: Command routing, confirmation, browser tests
  task: task-0038
  plan: Connect constrained Realtime read/proposal tools to the Actions API, implement confirmation and guarded recovery commands, and verify the complete foreground flow.
  needs: [task-0037]
```

## Run Log
- 2026-08-01 08:38Z · Plan · 10 turns · $0.719 · ok
- 2026-08-01 08:38Z · Plan · split into 4 chunks (DAG): task-0035 → task-0036 → task-0037 → task-0038
