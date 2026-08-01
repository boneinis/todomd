---
id: task-0030
title: Replace raw Chunks YAML with a modal Subtasks view
status: Build
type: improvement
priority: medium
labels: []
dependencies: [task-0029]
parent: task-0026
created_date: 2026-07-31
source: chunk
assignee:
agent: codex
triaged: n/a (chunk 3/3 of task-0026)
session_id: 019fbadd-0276-7ac0-860a-dd911a937c02
worktree: todomd/task-0030
verification: { attempts: 2, max_attempts: 3, last_verdict: fail }
base_branch: main
cost_usd: 4.0298
needs_human_reason:
recovery_stage:
model:
effort:
workflow:
skill:
---

## Description

Replace raw Chunks YAML with a drawer Subtasks view

## Acceptance Criteria

- [ ] The centered card-details modal shows a Subtasks view with per-child status, dependency state, and assignee, and no raw Chunks YAML in the main details flow.
- [ ] Raw planner output is still reachable in a collapsed Planner record that is closed by default.
- [ ] Clicking a subtask row in the drawer opens that child card, and a non-epic card shows neither the Subtasks tab nor the planner record.
- [ ] The card detail surface is a centered, accessible modal over the board; it keeps board context visible, closes with Escape, and adapts for narrow screens.
- [ ] Browser tests cover drawer switching, the planner record, and the responsive rail layout, and `npm test` is green.

## Implementation Plan

1. `public/index.html` drawer markup (lines 47-88) — inside `.drawer-main`, add a
   `.drawer-tabs` nav with Details and Subtasks buttons (Subtasks shown only for
   epics), a `#drawer-subtasks` section, and a collapsed
   `<details id="drawer-planner"><summary>planner record</summary>` holding a
   `<pre>` for the raw planner YAML. Leave `.drawer-rail` where it is — it is
   already a separate column; this chunk makes it sticky, not new.
2. `public/app.js` `openDrawer` (line 404) — today `mdToHtml(card.body)` dumps the
   whole body, raw `## Chunks` YAML included. For an epic, split the body: strip
   the `## Chunks` section before rendering `#drawer-body`, and put its raw fenced
   block verbatim into `#drawer-planner` so the planner output stays auditable.
   Match the section the same way `parseChunks` does in `src/board.js:183-198`
   so the UI and the parser never disagree about what the Chunks section is.
3. Build `#drawer-subtasks` from `childrenOf()` + `dependencyState()`: one row per
   child with status, dependency state, assignee, and click → `openDrawer(childId)`.
   Reuse the `#subtask-row-tpl` from the previous chunk rather than a second row
   markup. Empty epic → an explicit "no subtasks yet" line, not a blank panel.
4. Non-epic cards: hide the Subtasks tab and the planner record, and keep the
   drawer on Details. Reset the active tab on every `openDrawer` so a click-through
   from a subtask row doesn't land on a Subtasks tab the child doesn't have.
5. `public/style.css` — `.drawer-rail` becomes `position: sticky; align-self: start`
   with its own `max-height`/`overflow`, and `.drawer-main` scrolls independently.
   Update the existing drawer media query so the rail stacks under the details at
   narrow widths instead of sticking to a collapsed column.
6. Extend `test/ui/hierarchy.test.js`: opening an epic shows no raw `chunks:` YAML
   in `#drawer-body`; `#drawer-planner` exists, is closed by default, and still
   contains the planner YAML when opened; the Subtasks tab lists children with
   dependency state and click-through opens the child; a non-epic card shows
   neither tab nor planner record; the rail computes to `position: sticky` at wide
   width and stacks at a narrow viewport.

## Run Log
- 2026-08-01 01:04Z · Build attempt 1 · 65 turns · $4.030 · ok
- 2026-08-01 01:04Z · Verify attempt 1 · malformed verdict, re-running once
- 2026-08-01 01:04Z · Verify attempt 1 · 1 turns · $0.000 · failed: bad_verdict
- 2026-08-01 01:07Z · Verify attempt 1 · malformed verdict, re-running once
- 2026-08-01 01:07Z · Verify attempt 1 · 1 turns · $0.000 · failed: bad_verdict
- 2026-08-01 01:11Z · Verify attempt 1 · 1 turns · $0.000 · verdict: fail (unmet: 2)
  - retrying with findings (attempt 2/3)
