---
id: task-0037
title: Board mic button and wake gate
status: Planned
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
session_id:
worktree:
verification: { attempts: 0, max_attempts: 3, last_verdict: }
---

## Description

Board mic button and wake gate

## Acceptance Criteria

- [ ] The board mic button renders with distinct inactive and armed states and plays an enter sound on arm and an exit sound on end.
- [ ] Transcripts containing no TODOMD wake phrase never reach the transport, and a wake phrase opens the gate, covered by `test/voice-session.test.js`.
- [ ] `That is all To-do` ends the session, stops every microphone track, and returns the button to the inactive state.
- [ ] `npm run test:unit` passes.

## Implementation Plan

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

## Run Log
