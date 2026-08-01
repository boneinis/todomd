---
id: task-0029
title: Nest planned and queued subtasks under an expandable epic card
status: Queue
type: improvement
priority: medium
labels: []
dependencies: [task-0028]
parent: task-0026
created_date: 2026-07-31
source: chunk
assignee:
agent: claude
triaged: n/a (chunk 2/3 of task-0026)
session_id:
worktree:
verification: { attempts: 0, max_attempts: 3, last_verdict: }
---

## Description

Nest planned and queued subtasks under an expandable epic card

## Acceptance Criteria

- [ ] An epic card shows child count and progress and toggles its planned/queued subtasks between expanded and collapsed, with the state surviving a board re-render.
- [ ] A subtask row shows title, status, dependency state, and opens that child's drawer on click without opening the parent.
- [ ] A child in an active execution (stage) column renders as a normal full card in its own column, not as a nested row.
- [ ] Column counts match the cards actually rendered, and a filter term matching only a child still surfaces that child.
- [ ] `test/ui/hierarchy.test.js` covers nesting, promotion to a full card, toggling, and row click-through, and `npm test` is green with a clean browser console.

## Implementation Plan

1. `public/index.html` — add a `#subtask-row-tpl` <template> (title, status pill,
   dependency lock, assignee disc). In `#card-tpl`, add an `.epic-toggle` button
   and an empty `.card-subtasks` list container.
2. `public/app.js` `renderColumns` (around line 190-218) — before rendering a
   column's cards, compute `const nested = TodomdHierarchy.nestedChildIds(...)`
   once per render and filter those ids out of the flat per-column list. The
   column's `.col-count` must count what it actually shows, otherwise a nested
   child reads as a lost card.
3. `renderCard` — when `card.epic`, render child count and progress
   (`⊞ epic done/total` plus a small progress meter), an `.epic-toggle` with
   `aria-expanded`, and one subtask row per nested child inside `.card-subtasks`.
   Non-epic cards are untouched.
4. Expanded/collapsed state must survive the board's polling re-render: keep a
   module-level `Set` of collapsed epic ids in app.js (default = expanded) and
   apply it in `renderCard`. Do not read expansion state back off the DOM — the
   node is replaced on every poll.
5. Subtask row content: title, status, dependency state from
   `dependencyState()` (`🔒 waiting on task-00NN` when blocked), assignee
   initials via the existing `initials()`. Click calls `openDrawer(childId)`
   and must `stopPropagation()` so it doesn't open the parent epic instead.
   Rows are not draggable; the parent card stays draggable as it is today.
6. Check the `#filter` handler: if a filter term matches a nested child but not
   its parent, render that child as a full card so filtering can still find it.
7. `public/style.css` — styles for `.card-subtasks`, `.subtask-row`,
   `.epic-toggle`, the progress meter, and the collapsed state. Rows are
   visually subordinate (indent, smaller type) so an epic still reads as one card.
8. New `test/ui/hierarchy.test.js`, modeled on `test/ui/ui-smoke.test.js`
   (same `openPage` helper, same skip-if-no-browser behavior, budget mode so no
   agent spawns). Seed an epic with two children in Queue/Planned and one child
   in Build, then assert: both non-execution children render as rows inside the
   epic card and NOT as cards in their own column; the Build child renders as a
   normal full card in the Build column; the toggle collapses and re-expands and
   survives a re-render; clicking a row opens that child's drawer; the console
   stays clean.

## Run Log
