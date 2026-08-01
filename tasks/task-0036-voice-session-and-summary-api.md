---
id: task-0036
title: Voice session and summary API
status: Planned
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

Voice session and summary API

## Acceptance Criteria

- [ ] `GET /api/voice/summary` returns a concise board status string derived from the live board.
- [ ] `POST /api/voice/session` returns a short-TTL ephemeral token, 403 for non-primary clients, and 503 when no voice key is configured, and no response contains the long-lived key.
- [ ] `npm run test:unit` passes, including the new coverage in `test/voice.test.js` and `test/server-routes.test.js`.

## Implementation Plan

1. New `src/voice.js`:
   - `buildVoiceSummary(board)` takes the board object already produced for `/api/board` (see `src/board.js`) and returns `{ text, counts }`. `text` is one or two spoken sentences covering per-column counts, anything sitting in Needs Human, and the currently running card. Deterministic, under ~300 characters.
   - `mintVoiceSession({ config, env, now })` reads the voice-service key from config/env and returns `{ token, expiresAt, model }` with a short TTL (60s), or `null` when unconfigured. It never returns the source key.
2. `src/server.js`, inside `handleApi` alongside the existing `/api/...` branches:
   - `GET /api/voice/summary` responds `json(res, 200, buildVoiceSummary(...))`.
   - `POST /api/voice/session` responds 403 unless `primary(req)` (mirror the `/api/lan` gate), 503 with `{ error }` when `mintVoiceSession` returns null, else 200 with the minted session.
3. New `test/voice.test.js` under `node --test`: summary text reflects column counts and flags Needs Human; `mintVoiceSession` returns null when unconfigured and a short-TTL token when configured; the minted payload does not contain the raw key.
4. Extend `test/server-routes.test.js`: `GET /api/voice/summary` returns 200 with text; `POST /api/voice/session` returns 503 when unconfigured and 403 for a non-primary request.

## Run Log
