---
id: task-0030
title: Replace raw Chunks YAML with a drawer Subtasks view
status: Planned
type: improvement
priority: medium
labels: []
dependencies: [task-0029]
parent: task-0026
created_date: 2026-07-31
source: chunk
assignee: 
agent: claude
triaged: n/a (chunk 3/3 of task-0026)
session_id:
worktree:
verification: { attempts: 0, max_attempts: 3, last_verdict: }
---

## Description

Replace raw Chunks YAML with a drawer Subtasks view

## Acceptance Criteria

- [ ] The parent drawer shows a Subtasks view with per-child status, dependency state, and assignee, and no raw Chunks YAML in the main details flow.
- [ ] Raw planner output is still reachable in a collapsed Planner record that is closed by default.
- [ ] Clicking a subtask row in the drawer opens that child card, and a non-epic card shows neither the Subtasks tab nor the planner record.
- [ ] The Actions rail is sticky and separate while the details column scrolls independently, and it stacks below the details at narrow widths.
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
