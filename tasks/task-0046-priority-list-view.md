---
id: task-0046
title: priority list view
status: Review
type: improvement
priority: medium
labels: []
dependencies: []
created_date: 2026-08-02
source: ui
assignee: 
agent: claude
session_id: 9e9336ff-57ae-43d1-a63f-5df071114479
worktree:
verification: { attempts: 0, max_attempts: 3, last_verdict: }
triaged: 2026-08-02
cost_usd: 0.1721
---

## Description

all viewing the todo in a list, the list will be sorted by items needing attention, queued, in progress, defrered
 and done

## Acceptance Criteria

- [ ] Implemented and verified

## Triage

- **Decision:** Needs human decision.
- **Rationale:** Description names a status ordering ("needing attention, queued, in progress, defrered, done") that doesn't map cleanly to the existing todomd status taxonomy, and the request doesn't specify where this list view lives (new view vs. existing board) or what "needing attention" means.
- **Risks or questions:** Which existing statuses map to "needing attention" vs "queued"? Is this a new UI view or a sort mode on an existing one? Note the typo "defrered" (deferred) in the source text — confirm intended status name.
- **Next step:** Ask the human to clarify status mapping and target view before planning.

## Implementation Plan

## Run Log
- 2026-08-02 13:46Z · Triage · 4 turns · $0.172 · ok
