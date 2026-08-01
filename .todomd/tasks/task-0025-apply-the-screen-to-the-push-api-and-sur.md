---
id: task-0025
title: Apply the screen to the push API and surface screened mail
status: Needs Human
type: improvement
priority: medium
labels: []
dependencies: [task-0024]
parent: task-0022
created_date: 2026-07-31
source: chunk
assignee:
agent: claude
triaged: n/a (chunk 3/3 of task-0022)
session_id: a7253b8f-99e1-4761-a537-f4a8e163e97f
worktree: todomd/task-0025
verification: { attempts: 1, max_attempts: 3, last_verdict:  }
base_branch: main
cost_usd: 9.4887
needs_human_reason: bad_verdict
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
