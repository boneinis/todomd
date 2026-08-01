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
session_id: 8b22a194-cfe7-47ec-9b10-ceee5d8bd08b
worktree: todomd/task-0035
verification: { attempts: 1, max_attempts: 3, last_verdict:  }
base_branch: main
cost_usd: 1.1054
needs_human_reason: bad_verdict
recovery_stage:
---

## Description

Voice spike and design doc

## Acceptance Criteria

- [ ] `docs/voice.md` exists and names one selected on-device wake-word component with rationale plus at least two rejected alternatives.
- [ ] `docs/voice.md` documents the ephemeral-token credential flow, states that the long-lived key never reaches the browser, and specifies the request/response shape of `POST /api/voice/session`.
- [ ] `docs/voice.md` lists all four wake phrases and marks which intents require spoken confirmation.

## Implementation Plan

1. Create `docs/voice.md`. This chunk changes no source files.
2. Section "Wake-word component": evaluate at least three browser on-device options against this repo's real constraints (no bundler, no build step, ESM served straight from `public/`, tests run under `node --test` with no network). Score at minimum Picovoice Porcupine Web (WASM + custom keyword, requires an AccessKey), an onnxruntime-web / openWakeWord model, and a Web Speech API interim-transcript gate. Record the pick, its rationale, and why each rejected option lost. State explicitly that the chosen engine is vendored under `public/vendor/` and loaded lazily only after the mic button is pressed.
3. Same section: write the privacy contract. Audio frames stay in the page and are discarded until the wake gate fires; only post-wake audio may reach the voice service; the gate re-closes on `That is all To-do` and on idle timeout. Define the no-key fallback so the board still boots when no wake-word key is configured (mic button disabled with a visible reason).
4. Section "Credential flow": the long-lived voice-service key lives only in server config/env; the browser receives a short-TTL ephemeral token from a new `POST /api/voice/session`; that route is gated by the same `primary(req)` check `/api/lan` uses in `src/server.js`; the raw key never appears in any API response. Give the exact request/response JSON shape chunk 2 must implement.
5. Section "Phrases and confirmation": table the four phrases (Hey To-do, Yes To-do, Report To-do, That is all To-do), classify every intent as read-only or board-changing, and state that each board-changing intent is spoken back and confirmed with `Yes To-do` before any fetch.
6. Add a cross-reference line to `docs/security.md` pointing at `docs/voice.md`.
7. Risks: the wake-word engine and the realtime voice service both likely require an account and an API key, which is a human decision on cost and vendor. Do not sign up for anything in this chunk. If the pick needs a key, document the exact env var and the disabled-button fallback, and flag the signup as a human decision in the run log rather than blocking.

## Run Log
- 2026-08-01 11:07Z · Build attempt 1 · 31 turns · $1.105 · ok
- 2026-08-01 11:07Z · Verify attempt 1 · malformed verdict, re-running once
- 2026-08-01 11:07Z · Verify attempt 1 · 1 turns · $0.000 · failed: bad_verdict
