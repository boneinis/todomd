---
id: task-0035
title: Voice spike and design doc
status: Needs Human
type: improvement
priority: medium
labels: []
dependencies: []
parent: task-0020
created_date: 2026-08-01
source: chunk
assignee: 
agent: claude
triaged: n/a (chunk 1/4 of task-0020)
session_id: 019fbda7-c74b-7202-8d34-3a03e57105ef
worktree: todomd/task-0035
verification: { attempts: 3, max_attempts: 3, last_verdict: fail }
base_branch: main
cost_usd: 5.7676
needs_human_reason: attempts_exhausted
recovery_stage:
---

## Description

Voice spike and design doc

## Acceptance Criteria

- [ ] `docs/voice.md` selects Chrome's strictly local Web Speech API as the dependency-free macOS capability spike, compares at least two alternatives, and defines the measured gate that decides whether Porcupine is needed.
- [ ] `docs/voice.md` requires `processLocally`, local language-pack availability, and a hard refusal instead of browser-cloud fallback.
- [ ] `docs/voice.md` documents the primary-only, server-mediated WebRTC setup for `POST /api/voice/session` and states that the long-lived OpenAI key never reaches the browser.
- [ ] `docs/voice.md` distinguishes sign-off from going offline and documents confirmation requirements for read-only, reversible, agent-starting, and high-risk actions.

## Implementation Plan

1. Create `docs/voice.md` without changing production source files.
2. Evaluate Chrome on-device Web Speech, Porcupine, openWakeWord, and Apple's native command recognizer against this repository's no-bundler and local-privacy constraints.
3. Select Chrome's local API conditionally and define exact capability checks, phrase matching, restart behavior, diagnostics, and the four-hour hardware release gate.
4. Document the no-cloud-fallback privacy contract and the separate sign-off and offline states.
5. Specify the primary-only `POST /api/voice/session` SDP request/response and server-owned Realtime configuration; keep `OPENAI_API_KEY` out of browser code and responses.
6. Specify deterministic proposal/read-back/confirmation behavior and the permissions that Voice must never gain.
7. Cross-reference the voice security boundary from `docs/security.md` and leave the existing board usable when Voice is unavailable.

## Run Log
- 2026-08-01 11:07Z · Build attempt 1 · 31 turns · $1.105 · ok
- 2026-08-01 11:07Z · Verify attempt 1 · malformed verdict, re-running once
- 2026-08-01 11:07Z · Verify attempt 1 · 1 turns · $0.000 · failed: bad_verdict
- 2026-08-01 11:39Z · Verify attempt 1 · 1 turns · $0.000 · verdict: fail (unmet: 1)
  - retrying with findings (attempt 2/3)
- 2026-08-01 11:45Z · Build attempt 2 · 37 turns · $1.240 · ok
- 2026-08-01 11:49Z · Verify attempt 2 · 1 turns · $0.000 · verdict: fail (unmet: 1)
  - escalating after 2 failed reviews: Fable diagnosis → Opus repair → final Codex gate
- 2026-08-01 11:51Z · Escalate attempt 2 · 18 turns · $1.867 · diagnosis complete
- 2026-08-01 11:57Z · Build attempt 3 · 23 turns · $1.556 · ok (escalation repair)
- 2026-08-01 12:01Z · Verify attempt 3 · 1 turns · $0.000 · verdict: fail
  - attempts_exhausted: `npm test` passes: 267 unit/integration and 5 UI tests. However, `docs/voice.md:30,76-83` incorrectly claims Chrome's Web Speech API cannot operate on-device and necessarily streams audio to Google. Chrome 139 added stable on-device recognition specifically to keep audio and transcripts local ([official release notes](https://developer.chrome.com/release-notes/139)). Porcupine may remain preferabl
- 2026-08-01 14:14Z · Verify attempt 3 · 1 turns · $0.000 · verdict: fail (unmet: 1)
  - attempts_exhausted: `npm test` passed: 267 unit/API and 5 browser tests. However, docs/voice.md:114-160 specifies an SDP-proxy endpoint and relegates ephemeral tokens to an unspecified fallback. Replace this with the required short-TTL token JSON contract—request body and `{ token, expiresAt, model }` response—and update docs/security.md consistently. Cross-file review also found incompatible downstream contracts: do
