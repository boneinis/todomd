---
id: task-0017
title: bin/todomd.js fanout idempotency and advance validation
status: Done
type: fix
priority: medium
labels: []
dependencies: []
parent: task-0014
created_date: 2026-06-12
source: chunk
assignee:
agent: claude
triaged: n/a (chunk 3/5 of task-0014)
session_id: 15e39522-48ec-4aa0-8fe6-240757c9b26c
worktree:
verification: { attempts: 1, max_attempts: 3, last_verdict: pass }
cost_usd: 1.0084
---

## Description

bin/todomd.js: fanout idempotency and advance validation

## Acceptance Criteria

- [ ] todomd fanout is idempotent (bails when already an epic) and todomd advance validates the id; tests cover both
- [ ] npm test passes

## Implementation Plan

1. In bin/todomd.js fanout handler (after L159 where the card is read),
   add: if `card.data?.epic === true` or `card.data?.children?.length > 0`,
   print `already fanned out: <id>` to stderr and `process.exit(1)`.
2. In bin/todomd.js advance handler (after the card is loaded), add: if
   `!card` or `!card.data?.epic`, print `not an epic: <id>` to stderr
   and `process.exit(1)`.
3. In the test suite (test/cli.test.js or equivalent), add:
   (a) Test: `todomd fanout` on a card that already has `epic: true` in
       frontmatter — assert exit code 1.
   (b) Test: `todomd advance` on a non-epic card id — assert exit code 1.
4. Run `npm test` — all tests must pass.

## Run Log
- 2026-06-12 08:55Z · Build attempt 1 · 22 turns · $0.676 · ok
- 2026-06-12 08:57Z · Verify attempt 1 · 12 turns · $0.333 · verdict: pass
