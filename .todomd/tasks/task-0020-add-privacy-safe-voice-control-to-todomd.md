---
id: task-0020
title: Add privacy-safe voice control to TODOMD
status: Plan
type: module
priority: critical
labels: [voice, accessibility, realtime]
dependencies: []
created_date: 2026-07-31
source: ui
assignee:
agent: claude
session_id:
worktree:
verification: { attempts: 0, max_attempts: 3, last_verdict: }
triaged: failed (agent)
needs_human_reason:
---

## Description

Add a TODOMD board voice-control experience. A board microphone button must arm a short session, play an earcon, and use a local wake-word gate so ordinary conversation is ignored before audio is sent to the voice service. Supported phrases: Hey To-do (arm), Yes To-do (allow response), Report To-do (board summary), and That is all To-do (end). Require a spoken confirmation before any action that changes a card, routing, or run. The feature must use a dedicated board voice client; it must not attempt to embed or control the Codex desktop voice session. Begin with a technical spike that selects a browser-compatible on-device wake-word component and defines secure real-time voice credentials, then split the planned implementation into independently verifiable chunks.

## Acceptance Criteria

- [ ] The implementation plan selects and documents an on-device wake-word approach and secure voice-service credential flow.
- [ ] The board microphone has a clear armed and inactive state with enter and exit sounds.
- [ ] Ordinary conversation is ignored until a TODOMD wake phrase activates the session.
- [ ] Board-changing actions require spoken confirmation before the API call.
- [ ] Report To-do returns a concise board status without requiring confirmation.
- [ ] That is all To-do ends the session and stops microphone capture.
- [ ] Focused unit, API, and browser tests cover activation, confirmation, and sign-off behavior.

## Implementation Plan

## Run Log
