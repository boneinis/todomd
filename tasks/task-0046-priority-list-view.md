---
id: task-0046
title: priority list view
status: Planned
type: improvement
priority: medium
labels: []
dependencies: []
created_date: 2026-08-02
source: ui
assignee: 
agent: claude
session_id: d3a6498b-55d5-42b8-ab1c-1b8928dd013a
worktree:
verification: { attempts: 0, max_attempts: 3, last_verdict: }
triaged: 2026-08-02
cost_usd: 1.0497
needs_human_reason:
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

Triage flagged this as "needs human decision"; a human queued it back to Plan, so this plan
picks a concrete default mapping and keeps it in ONE exported table so changing it later is a
one-line edit, not a rewrite. See Risks.

Status taxonomy actually in the code (`src/board.js:10`, `:29`):
`Review, Plan, Planned, Queue, Build, Verify, Needs Human, Done` + an `archived` flag.
There is no `Deferred` status — the group is derived, not a new column.

Group order and mapping (the requested "needing attention, queued, in progress, deferred, done"):

| # | group | members |
|---|-------|---------|
| 1 | Needs attention | `Needs Human`, `Review`, `Planned` (all await a human decision), plus `unparseable` cards |
| 2 | Queued | `Queue`, `Plan` |
| 3 | In progress | `Build`, `Verify` |
| 4 | Deferred | any non-`Done` card that is `archived` OR blocked by unmet dependencies — this overrides its status group |
| 5 | Done | `Done` |

1. **New `public/listview.js`** — a classic script assigning `window.TodomdListView`, same shape as
   `public/hierarchy.js` (so it unit-tests under `vm.runInThisContext`). Export:
   - `GROUPS` — the ordered array `[{key, label, statuses}]` from the table above. This is the single
     place the mapping lives.
   - `groupOf(card, cards)` — returns a group key. Order of checks: `Done` first; then `archived` or
     `TodomdHierarchy.dependencyState(card, cards).blocked` → `deferred`; then status lookup;
     unknown/unparseable status → `attention` (never drop a card).
   - `sortForList(cards)` — returns a flat array sorted by group index, then priority
     (`high > medium > low`, unknown last), then `id` ascending. Stable and pure; no DOM.
   Guard the `TodomdHierarchy` reference so the module still loads if hierarchy.js is absent
   (fall back to "not blocked").
2. **`public/index.html`** — load `listview.js` alongside `hierarchy.js` (before `app.js`). Add a
   `#layout-toggle` button next to `#view-toggle`, and a `<template id="list-group-tpl">` for a
   group header row (label + count).
3. **`public/app.js`**
   - Add `let layout = localStorage.getItem('todomd-layout') === 'list' ? 'list' : 'board';`
     next to `viewMode` (~line 35).
   - Rename the current body of `renderBoard()` (lines 233–285) to `renderColumns()`, and make
     `renderBoard()` a two-line dispatcher: `layout === 'list' ? renderList() : renderColumns()`.
     Do this rather than touching call sites — `renderBoard()` is called from ~6 places
     (`:145, :175, :184, :391, :1011, :1352`) and all of them should follow the active layout.
   - Add `renderList()`: reuse the existing `passesView` predicate (filter / mine / archived all
     keep working), pass an **empty** nested-id set to `renderCard` so every card is bucketed by
     its own status instead of being swallowed by an epic, then walk `TodomdListView.sortForList`
     and emit a group header whenever the group key changes. Skip empty groups.
     Do not call `wireDrop`, and set `el.draggable = false` on list rows — there is no drop target
     in list layout; click-to-open-drawer already works via `renderCard`.
   - Wire `#layout-toggle`: flip `layout`, persist to `localStorage['todomd-layout']`, toggle an
     `.active` class and a `body.list-layout` class, `renderBoard()`.
4. **`public/style.css`** — `body.list-layout #board` switches the column flex row to a single
   vertical stack; style `.list-group` headers (sticky, dim, count on the right). Reuse the
   existing card styles unchanged.
5. **Tests**
   - New `test/listview.test.js`, modelled on `test/hierarchy.test.js` (read the file, run it in a
     `vm` with a stub `window`): assert group order for one card per status; that an archived and a
     dependency-blocked card land in `deferred` while a blocked `Done` card stays in `done`; that a
     card with an unknown status lands in `attention` rather than vanishing; and that within a
     group `high` sorts before `medium` before `low`, ties broken by id.
   - Extend the existing UI test dir only if cheap: one `test/ui/` case that toggles the layout
     button and asserts group headers render in order. Prefer the unit test as the criterion —
     this box runs heavy parallel Playwright loads and `until()` timeouts there are usually
     starvation, not regressions.

Risks:
- **Unresolved from triage (human decision):** the status→group mapping above is a judgement call,
  not a stated requirement. "Needing attention" bundling `Review` + `Planned` + `Needs Human`, and
  `Plan` sitting in "queued" rather than "in progress", are the two most likely to be disputed.
  Both are single-line edits to `GROUPS` in `public/listview.js`.
- **"defrered" in the description is a typo for "deferred"**, and no such status exists. It is
  derived here (archived or dependency-blocked) rather than added as a column — adding a real
  `Deferred` status would touch `DEFAULT_COLUMNS`/`REQUIRED_COLUMNS` and the pipeline, which is
  out of scope for a view change.
- Deferred overriding the status group means a blocked `Queue` card leaves the "queued" group.
  That is intended (it separates ready work from waiting work) but changes where a card appears.
- `renderBoard()` becoming a dispatcher must keep its early `if (!boardData) return;` guard, or
  the first render before the board loads will throw.
- Drag-and-drop is deliberately unavailable in list layout; if a user expects to reorder/move
  there, that is a follow-up, not a bug in this card.

## Run Log
- 2026-08-02 13:46Z · Triage · 4 turns · $0.172 · ok
- 2026-08-02 13:58Z · Plan · 12 turns · $0.878 · ok
