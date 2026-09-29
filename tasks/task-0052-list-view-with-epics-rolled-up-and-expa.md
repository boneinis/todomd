---
id: task-0052
title: List view with epics rolled up and expandable
status: Review
type: feature
priority: medium
labels: []
dependencies: []
created_date: 2026-09-08
source: ui
assignee:
agent:
build_profile: standard
session_id:
worktree:
verification: { attempts: 0, max_attempts: 3, last_verdict: }
triaged: failed (permission_denied)
---

## Description

The board renders columns, and an epic's children appear as nested subtask rows
inside the epic's card. That works while an epic is small, but there is no way to
see a programme of epics at a glance, and the nesting is always expanded so a
column holding several epics becomes unreadable.

Add a list view as an alternative to the column view: one row per epic showing
its rolled-up state, expandable to reveal its child cards in build order.

Most of the data layer already exists and should be reused rather than
reimplemented. The hierarchy helper already computes children of an epic ordered
topologically by their dependency chain and tie-broken by id, progress as a count
of completed children against the total, and whether a child is blocked together
with what it is waiting on. The helper is deliberately free of DOM and fetch
calls and is already covered by its own tests, so the new view should be a
presentation layer over it.

Two existing hazards to respect. Card list fields are hand- and agent-written, so
they can arrive as a scalar, a mapping or missing, and a scalar reaching an array
method once blanked the whole board. And a child whose parent is hidden by the
active filter must still surface on its own rather than disappearing, which the
column view already handles.

## Acceptance Criteria

- [ ] A view toggle switches between the column board and the list, and the choice persists
- [ ] Each epic is one row showing title, status, and completed-of-total children
- [ ] A row expands and collapses to show its children in dependency order, collapsed by default
- [ ] A child row shows its status and, when blocked, what it waits on
- [ ] Cards with no parent appear in the list too, so nothing is hidden by switching view
- [ ] A child whose parent is filtered out still appears rather than vanishing
- [ ] Malformed list fields on a card cannot blank the view
- [ ] Selecting any row opens the same detail drawer the column view opens

## Constraints

- Reuse the existing hierarchy helper; do not duplicate ordering or progress logic.
- The helper stays free of DOM and network calls so its tests keep running headless.
- Keep the classic-script loading order; a module helper would execute after the
  main script and race the first render.

## Verification

Unit coverage for the view's data shaping, plus the existing UI smoke test
extended to render the list view and toggle it.
