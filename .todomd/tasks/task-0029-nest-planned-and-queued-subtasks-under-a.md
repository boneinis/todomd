---
id: task-0029
title: Nest planned and queued subtasks under an expandable epic card
status: Needs Human
type: improvement
priority: medium
labels: []
dependencies: [task-0028]
parent: task-0026
created_date: 2026-07-31
source: chunk
assignee:
agent: codex
triaged: n/a (chunk 2/3 of task-0026)
session_id: 019fbac3-5974-7e41-a04f-efd9b081c10c
worktree: todomd/task-0029
verification: { attempts: 3, max_attempts: 3, last_verdict: fail }
base_branch: main
cost_usd: 6.2014
needs_human_reason: attempts_exhausted
recovery_stage:
model:
effort:
workflow:
skill:
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
- 2026-08-01 00:22Z · Build attempt 1 · 83 turns · $4.939 · ok
- 2026-08-01 00:22Z · Verify attempt 1 · malformed verdict, re-running once
- 2026-08-01 00:22Z · Verify attempt 1 · 1 turns · $0.000 · failed: bad_verdict
- 2026-08-01 00:28Z · Verify attempt 1 · 1 turns · $0.000 · verdict: fail
  - retrying with findings (attempt 2/3)
- 2026-08-01 00:28Z · Build attempt 2 · 0 turns · $0.000 · failed: agent
  - error: Error: thread/resume: thread/resume failed: no rollout found for thread id f89b6764-f4e0-41e1-9015-a0a77d2ae943 (code -32600)
- 2026-08-01 00:33Z · Verify attempt 2 · 1 turns · $0.000 · verdict: fail
  - escalating after 2 failed reviews: Fable diagnosis → Opus repair → final Codex gate
- 2026-08-01 00:36Z · Escalate attempt 2 · 16 turns · $1.263 · diagnosis complete
  - retry_failed: The argument 'args[1]' must be a string without null bytes. Received '/todomd-build task-0029\n' +
  '\n' +
  'Previous verifier findings to address:\n' +
  'Adversarial review found a reachable mu...
- 2026-08-01 00:44Z · Verify attempt 3 · 1 turns · $0.000 · verdict: fail
  - attempts_exhausted: The full suite passed: 218 unit tests and 3 browser UI tests, with the clean-console assertion passing. Adversarial review found two reachable bugs:

1. `public/style.css:281` sets `.card-epic { display: flex; }`, which overrides the template's `hidden` attribute. A Chrome probe confirmed its computed display remains `flex`. Every ordinary non-epic card therefore renders an empty epic progress/tog
