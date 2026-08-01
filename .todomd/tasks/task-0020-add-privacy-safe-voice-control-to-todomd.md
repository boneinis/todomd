---
id: task-0020
title: Add privacy-safe voice control to TODOMD
status: Planned
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

## Chunks

```yaml
- title: Voice spike and design doc
  plan: |
    1. Create `docs/voice.md`. This chunk changes no source files.
    2. Section "Wake-word component": evaluate at least three browser on-device options against this repo's real constraints (no bundler, no build step, ESM served straight from `public/`, tests run under `node --test` with no network). Score at minimum Picovoice Porcupine Web (WASM + custom keyword, requires an AccessKey), an onnxruntime-web / openWakeWord model, and a Web Speech API interim-transcript gate. Record the pick, its rationale, and why each rejected option lost. State explicitly that the chosen engine is vendored under `public/vendor/` and loaded lazily only after the mic button is pressed.
    3. Same section: write the privacy contract. Audio frames stay in the page and are discarded until the wake gate fires; only post-wake audio may reach the voice service; the gate re-closes on `That is all To-do` and on idle timeout. Define the no-key fallback so the board still boots when no wake-word key is configured (mic button disabled with a visible reason).
    4. Section "Credential flow": the long-lived voice-service key lives only in server config/env; the browser receives a short-TTL ephemeral token from a new `POST /api/voice/session`; that route is gated by the same `primary(req)` check `/api/lan` uses in `src/server.js`; the raw key never appears in any API response. Give the exact request/response JSON shape chunk 2 must implement.
    5. Section "Phrases and confirmation": table the four phrases (Hey To-do, Yes To-do, Report To-do, That is all To-do), classify every intent as read-only or board-changing, and state that each board-changing intent is spoken back and confirmed with `Yes To-do` before any fetch.
    6. Add a cross-reference line to `docs/security.md` pointing at `docs/voice.md`.
    7. Risks: the wake-word engine and the realtime voice service both likely require an account and an API key, which is a human decision on cost and vendor. Do not sign up for anything in this chunk. If the pick needs a key, document the exact env var and the disabled-button fallback, and flag the signup as a human decision in the run log rather than blocking.
  criteria:
    - "`docs/voice.md` exists and names one selected on-device wake-word component with rationale plus at least two rejected alternatives."
    - "`docs/voice.md` documents the ephemeral-token credential flow, states that the long-lived key never reaches the browser, and specifies the request/response shape of `POST /api/voice/session`."
    - "`docs/voice.md` lists all four wake phrases and marks which intents require spoken confirmation."
  type: improvement
  needs: []

- title: Voice session and summary API
  plan: |
    1. New `src/voice.js`:
       - `buildVoiceSummary(board)` takes the board object already produced for `/api/board` (see `src/board.js`) and returns `{ text, counts }`. `text` is one or two spoken sentences covering per-column counts, anything sitting in Needs Human, and the currently running card. Deterministic, under ~300 characters.
       - `mintVoiceSession({ config, env, now })` reads the voice-service key from config/env and returns `{ token, expiresAt, model }` with a short TTL (60s), or `null` when unconfigured. It never returns the source key.
    2. `src/server.js`, inside `handleApi` alongside the existing `/api/...` branches:
       - `GET /api/voice/summary` responds `json(res, 200, buildVoiceSummary(...))`.
       - `POST /api/voice/session` responds 403 unless `primary(req)` (mirror the `/api/lan` gate), 503 with `{ error }` when `mintVoiceSession` returns null, else 200 with the minted session.
    3. New `test/voice.test.js` under `node --test`: summary text reflects column counts and flags Needs Human; `mintVoiceSession` returns null when unconfigured and a short-TTL token when configured; the minted payload does not contain the raw key.
    4. Extend `test/server-routes.test.js`: `GET /api/voice/summary` returns 200 with text; `POST /api/voice/session` returns 503 when unconfigured and 403 for a non-primary request.
  criteria:
    - "`GET /api/voice/summary` returns a concise board status string derived from the live board."
    - "`POST /api/voice/session` returns a short-TTL ephemeral token, 403 for non-primary clients, and 503 when no voice key is configured, and no response contains the long-lived key."
    - "`npm run test:unit` passes, including the new coverage in `test/voice.test.js` and `test/server-routes.test.js`."
  type: module

- title: Board mic button and wake gate
  plan: |
    1. New `public/voice-session.js`, a dependency-injected ESM module so it is testable under `node --test` without a browser:
       - `createVoiceSession({ mic, wakeWord, transport, earcons, clock })` returns `{ state, arm(), handleWake(phrase), handleTranscript(text), end(reason), on(event, fn) }`.
       - States `inactive -> arming -> armed -> listening -> ending -> inactive`. `arm()` plays the enter earcon and opens the mic, but the gate stays closed.
       - Gate rule: `transport.send` is never called until `handleWake` sees a TODOMD wake phrase; every frame before that is dropped. `That is all To-do` calls `end('signoff')`, plays the exit earcon, calls `mic.stop()` which must stop every `MediaStream` track, and returns to `inactive`.
       - An idle timeout driven by the injected `clock` re-closes the gate without ending the session.
    2. New `public/voice-earcons.js`: two short WebAudio tones (rising for enter, falling for exit) generated from an `AudioContext` oscillator so no audio assets are needed.
    3. `public/index.html`: add the board mic button to the existing header/toolbar row as `id="voice-mic"` with `aria-pressed` and `data-voice-state`.
    4. `public/style.css`: visually distinct `inactive` and `armed` styling driven off `[data-voice-state]`, with a live indicator when armed, matching the existing control styling.
    5. `public/app.js`: wire the button. On click, `POST /api/voice/session`, then lazily import `voice-session.js` and the vendored wake-word engine from chunk 1, arm the session, and mirror session state onto the button's `data-voice-state` and `aria-pressed`. If the session endpoint returns 403 or 503, leave the button disabled with a title explaining why.
    6. New `test/voice-session.test.js`: ordinary conversation transcripts produce zero `transport.send` calls; a wake phrase opens the gate; the enter and exit earcons each fire exactly once per session; `That is all To-do` stops every mic track and returns state to `inactive`.
  criteria:
    - "The board mic button renders with distinct inactive and armed states and plays an enter sound on arm and an exit sound on end."
    - "Transcripts containing no TODOMD wake phrase never reach the transport, and a wake phrase opens the gate, covered by `test/voice-session.test.js`."
    - "`That is all To-do` ends the session, stops every microphone track, and returns the button to the inactive state."
    - "`npm run test:unit` passes."
  type: module

- title: Command routing, confirmation, browser tests
  plan: |
    1. New `public/voice-commands.js`:
       - `parseIntent(text)` returns `{ kind, ... }` for `report`, `confirm` (Yes To-do), `signoff` (That is all To-do), the board-changing intents (move a card to a stage, cancel a run, retry verify), and `unknown`.
       - A `CHANGES_BOARD` set marks which kinds mutate the board. `report` and `signoff` are read-only.
    2. Extend `createVoiceSession` with a confirmation gate: a board-changing intent moves the session to `confirming` and stores the pending action together with a spoken read-back. The action's `execute()` runs only after a `confirm` intent; any other intent, or the confirm timeout, discards it. `report` executes immediately with no confirmation.
    3. `public/app.js`: map executed intents onto the existing endpoints (`POST /api/cards/:id/move`, `/set`, `/cancel`, `/retry-verify`) and map `report` onto `GET /api/voice/summary`, speaking the returned text.
    4. Extend the unit tests (in `test/voice-session.test.js` or a new `test/voice-commands.test.js`): a move intent performs no fetch until `Yes To-do` arrives and then performs exactly one; a non-confirming reply discards the pending action; `Report To-do` fetches the summary with no confirmation step.
    5. New `test/ui/voice.test.js` following the existing harness in `test/browser.js` as used by `test/ui/ui-smoke.test.js`: the mic button exists and starts inactive, clicking it moves it to armed, and a simulated `That is all To-do` returns it to inactive. Stub the wake-word engine and the mic so the test needs no real microphone and no network.
  criteria:
    - "Board-changing voice intents perform no API call until a spoken confirmation is received, and a non-confirming reply discards the pending action."
    - "`Report To-do` returns a board status with no confirmation step."
    - "`test/ui/voice.test.js` drives the mic button through inactive, armed, and back to inactive in the browser harness with no real microphone or network."
    - "`npm test` passes, covering the unit, API, and browser tests."
  type: module
```

## Run Log
- 2026-08-01 08:38Z · Plan · 10 turns · $0.719 · ok
- 2026-08-01 08:38Z · Plan · split into 4 chunks (DAG): task-0035 → task-0036 → task-0037 → task-0038
