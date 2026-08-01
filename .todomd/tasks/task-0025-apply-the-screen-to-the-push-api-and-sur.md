---
id: task-0025
title: Apply the screen to the push API and surface screened mail
status: Verify
type: improvement
priority: medium
labels: []
dependencies: [task-0024]
parent: task-0022
created_date: 2026-07-31
source: chunk
assignee:
agent: codex
triaged: n/a (chunk 3/3 of task-0022)
session_id: 019fbba0-a6b4-7f41-9ff6-4caa11d612ec
worktree: todomd/task-0025
verification: { attempts: 3, max_attempts: 3, last_verdict: fail }
base_branch: main
cost_usd: 16.0398
needs_human_reason:
recovery_stage:
---

## Description

Apply the screen to the push API and surface screened mail

## Acceptance Criteria

- [ ] The email push API applies the same screen as mailbox polling and reports the verdict in its response.
- [ ] A message pushed to the API and screened as spam creates no card.
- [ ] The intake audit endpoint returns recent screened-out messages, newest first.
- [ ] The UI lists screened email with verdict and reason, covered by a browser test.

## Implementation Plan

1. Find the email push route in `src/server.js` (the one creating cards from
   `emailToCardFields` / with `source: email`) and run the same `screenEmail`
   verdict through it, so a pushed message gets the same three outcomes as a
   polled one. Return the verdict in the response body, with no card id for spam.
2. Add `GET /api/projects/:name/intake-audit` following the existing route and
   auth shape in `src/server.js`, returning the most recent audit records newest
   first, with a bounded count.
3. In `public/index.html` and `public/app.js`, add a compact Screened email list to
   the existing intake settings panel — time, sender, subject, verdict, reason,
   plus an empty state. Escape all of it; the content is untrusted.
4. API tests in `test/server-routes.test.js` — pushing a marketing email returns
   the spam verdict and creates no card; pushing an ambiguous one creates a Needs
   Human card; the audit endpoint returns seeded records newest first.
5. Browser test in `test/browser.js` — the screened-email list renders seeded
   records with their verdict and reason, and a held email card appears in the
   Needs Human column.

Risks: the push route may already have its own card-creation path that bypasses
`emailToCardFields`; if so, screen at the shared point rather than duplicating the
logic. Browser tests skip when no browser starts, so the API test must carry the
real assertion.

## Run Log
- 2026-08-01 04:12Z · Build attempt 1 · 101 turns · $6.683 · checkpoint 1: progress detected; continuing
- 2026-08-01 04:16Z · Build attempt 1 · 21 turns · $2.806 · ok
- 2026-08-01 04:16Z · Verify attempt 1 · malformed verdict, re-running once
- 2026-08-01 04:16Z · Verify attempt 1 · 1 turns · $0.000 · failed: bad_verdict
- 2026-08-01 04:17Z · Verify attempt 1 · malformed verdict, re-running once
- 2026-08-01 04:17Z · Verify attempt 1 · 1 turns · $0.000 · failed: bad_verdict
- 2026-08-01 04:23Z · Verify attempt 1 · 1 turns · $0.000 · verdict: fail (unmet: 3)
  - retrying with findings (attempt 2/3)
- 2026-08-01 04:23Z · Build attempt 2 · 0 turns · $0.000 · failed: agent
  - error: Error: thread/resume: thread/resume failed: no rollout found for thread id a7253b8f-99e1-4761-a537-f4a8e163e97f (code -32600)
- 2026-08-01 04:30Z · Verify attempt 2 · 1 turns · $0.000 · verdict: fail (unmet: 2)
  - escalating after 2 failed reviews: Fable diagnosis → Opus repair → final Codex gate
- 2026-08-01 04:33Z · Escalate attempt 2 · 21 turns · $3.056 · diagnosis complete
- 2026-08-01 04:41Z · Build attempt 3 · 58 turns · $3.496 · ok (escalation repair)
- 2026-08-01 04:46Z · Verify attempt 3 · 1 turns · $0.000 · verdict: fail
  - attempts_exhausted: The full `npm test` gate passes: 267 unit/API tests and 5 browser tests. However, the new push endpoint corrupts valid non-UTF-8 MIME bytes. `readBody()` in src/server.js:34 concatenates request Buffers into a JavaScript string, and that string is passed to `parseInboundMessage()` at line 253. A binary MIME attachment containing bytes [0,127,128,255,65] was parsed as [0,127,239,191,189,239,191,189
