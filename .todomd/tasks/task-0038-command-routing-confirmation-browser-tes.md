---
id: task-0038
title: Command routing confirmation browser tests
status: Planned
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
session_id:
worktree:
verification: { attempts: 0, max_attempts: 3, last_verdict: }
---

## Description

Command routing, confirmation, browser tests

## Acceptance Criteria

- [ ] Board-changing voice intents perform no API call until a spoken confirmation is received, and a non-confirming reply discards the pending action.
- [ ] `Report To-do` returns a board status with no confirmation step.
- [ ] `test/ui/voice.test.js` drives the mic button through inactive, armed, and back to inactive in the browser harness with no real microphone or network.
- [ ] `npm test` passes, covering the unit, API, and browser tests.

## Implementation Plan

1. New `public/voice-commands.js`:
   - `parseIntent(text)` returns `{ kind, ... }` for `report`, `confirm` (Yes To-do), `signoff` (That is all To-do), the board-changing intents (move a card to a stage, cancel a run, retry verify), and `unknown`.
   - A `CHANGES_BOARD` set marks which kinds mutate the board. `report` and `signoff` are read-only.
2. Extend `createVoiceSession` with a confirmation gate: a board-changing intent moves the session to `confirming` and stores the pending action together with a spoken read-back. The action's `execute()` runs only after a `confirm` intent; any other intent, or the confirm timeout, discards it. `report` executes immediately with no confirmation.
3. `public/app.js`: map executed intents onto the existing endpoints (`POST /api/cards/:id/move`, `/set`, `/cancel`, `/retry-verify`) and map `report` onto `GET /api/voice/summary`, speaking the returned text.
4. Extend the unit tests (in `test/voice-session.test.js` or a new `test/voice-commands.test.js`): a move intent performs no fetch until `Yes To-do` arrives and then performs exactly one; a non-confirming reply discards the pending action; `Report To-do` fetches the summary with no confirmation step.
5. New `test/ui/voice.test.js` following the existing harness in `test/browser.js` as used by `test/ui/ui-smoke.test.js`: the mic button exists and starts inactive, clicking it moves it to armed, and a simulated `That is all To-do` returns it to inactive. Stub the wake-word engine and the mic so the test needs no real microphone and no network.

## Run Log
