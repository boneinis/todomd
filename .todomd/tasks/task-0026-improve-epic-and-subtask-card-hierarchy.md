---
id: task-0026
title: Improve epic and subtask card hierarchy
status: Planned
type: improvement
priority: high
labels: [board-ui, epics, subtasks]
dependencies: []
created_date: 2026-07-31
source: ui
assignee:
agent: claude
triaged: manual bypass
session_id: 6755176b-1ab0-47d7-b7d7-4058e1efc4cb
worktree:
verification: { attempts: 0, max_attempts: 3, last_verdict: }
needs_human_reason:
cost_usd: 1.0064
epic: true
children: [task-0028, task-0029, task-0030]
---

## Description

Redesign TODOMD’s epic and subtask presentation. A parent epic and its generated child cards currently appear as peer cards in the same column, and the parent drawer renders the raw Chunks planner YAML beside the actions rail. Make the hierarchy clear without hiding active work: show the parent as an expandable epic card with compact nested subtask rows while children are still planned or queued; show child cards as full cards when they reach an active execution column. Replace raw Chunks YAML in the normal drawer with a Subtasks view that exposes status, dependency, assignee, and click-to-open behavior. Keep raw planner output available in a collapsed Planner record. Keep Actions as a separate sticky rail while task details scroll independently.

## Acceptance Criteria

- [ ] An epic card shows child count and progress and can expand or collapse its planned and queued subtasks.
- [ ] A subtask row shows title, status, dependency state, and opens that child card.
- [ ] A child becomes a normal full card when it is in an active execution column.
- [ ] The parent drawer has a Subtasks view instead of rendering raw Chunks YAML in the main details flow.
- [ ] Raw planner output remains available in a collapsed Planner record for auditability.
- [ ] The Actions rail remains separate and sticky while details scroll independently.
- [ ] Focused unit and browser tests cover hierarchy, dependency state, drawer switching, and responsive layout.

## Implementation Plan

## Chunks

```yaml
- title: Extract hierarchy helpers behind unit tests
  type: improvement
  plan: |
    1. New `public/hierarchy.js` — a CLASSIC script (an IIFE assigning
       `window.TodomdHierarchy`), NOT an ES module: `public/index.html` loads
       `/app.js` with a plain `<script src>` (index.html:296), and a `type=module`
       helper would execute AFTER it and race the first render.
    2. Export these pure functions (no DOM, no fetch) on that object:
       - `asList(x)` — same coercion as app.js:223 (scalar/mapping/missing → []).
         Every field below is agent- or hand-written, so nothing may throw:
         a scalar `dependencies:` reaching `.some()` once blanked the whole board.
       - `childrenOf(cards, epicId)` → cards where `parent === epicId`, ordered by
         their dependency chain then id, so rows render in build order.
       - `epicProgress(cards, epicId)` → `{ total, done }` (done = status 'Done').
       - `dependencyState(card, cards)` → `{ blocked, waitingOn: [{id, status}] }`;
         blocked when any dependency id is missing from the board or not Done.
       - `isExecutionColumn(status, config)` → `!!(config?.stages || {})[status]`.
         Stage columns ARE the "active execution columns" — derive it from config,
         do not hardcode Build/Verify.
       - `nestedChildIds(cards, config)` → Set of child ids to render nested:
         card has a `parent`, that parent card is present in `cards`, and
         `!isExecutionColumn(card.status, config)`. A child whose parent is absent
         (archived or filtered out) is NOT nested — it must still render as a full
         card or it vanishes from the board entirely.
    3. `public/index.html` — add `<script src="/hierarchy.js"></script>` immediately
       before the existing `<script src="/app.js"></script>` (line 296).
    4. `public/app.js` — rewire the existing `.card-rel` badge (app.js:280-292) and
       the drawer `depChip`/relationship block (app.js:340-393) to call the new
       helpers. Behavior is unchanged in this chunk; this proves the helpers match
       what the UI already does before anything is redesigned.
    5. New `test/hierarchy.test.js` — that name puts it in the existing
       `node --test test/*.test.js` glob. Load the classic script with `node:vm`:
       read `public/hierarchy.js`, run it in a new context with a `{ window: {} }`
       sandbox, and assert against `sandbox.window.TodomdHierarchy`.
    6. Cover: progress counts; blocked vs unblocked dependencies; a dependency id
       with no matching card (blocked); a scalar `dependencies:` string; a scalar
       `children:`; nested-vs-full partition across a stage and a non-stage column;
       an orphan child whose parent is missing (renders full, never nested).
  criteria:
    - "`node --test test/hierarchy.test.js` passes and covers blocked/unblocked dependency state, epic progress, and the nested-vs-full-card partition."
    - "Hostile card shapes (scalar `dependencies:`, scalar `children:`, dependency id with no card, child with a missing parent) return sane values instead of throwing."
    - "`public/hierarchy.js` loads before `/app.js` in `public/index.html`, and `public/app.js` computes the existing epic/chunk badge and drawer dependency chips through `window.TodomdHierarchy`."
    - "`npm test` is green — the board renders exactly as before this chunk."

- title: Nest planned and queued subtasks under an expandable epic card
  type: improvement
  plan: |
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
  criteria:
    - "An epic card shows child count and progress and toggles its planned/queued subtasks between expanded and collapsed, with the state surviving a board re-render."
    - "A subtask row shows title, status, dependency state, and opens that child's drawer on click without opening the parent."
    - "A child in an active execution (stage) column renders as a normal full card in its own column, not as a nested row."
    - "Column counts match the cards actually rendered, and a filter term matching only a child still surfaces that child."
    - "`test/ui/hierarchy.test.js` covers nesting, promotion to a full card, toggling, and row click-through, and `npm test` is green with a clean browser console."

- title: Replace raw Chunks YAML with a drawer Subtasks view
  type: improvement
  plan: |
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
  criteria:
    - "The parent drawer shows a Subtasks view with per-child status, dependency state, and assignee, and no raw Chunks YAML in the main details flow."
    - "Raw planner output is still reachable in a collapsed Planner record that is closed by default."
    - "Clicking a subtask row in the drawer opens that child card, and a non-epic card shows neither the Subtasks tab nor the planner record."
    - "The Actions rail is sticky and separate while the details column scrolls independently, and it stacks below the details at narrow widths."
    - "Browser tests cover drawer switching, the planner record, and the responsive rail layout, and `npm test` is green."
```

Risks:
- `public/app.js` is a classic script with no module system, so helpers are shared via a `window` global — the new script must load before `/app.js`, and every helper must tolerate hostile card shapes. A throw inside `renderBoard` blanks the entire board (see the two documented incidents in `test/ui/ui-smoke.test.js:1-16`).
- Nesting removes children from their own column's flat list: column counts, the `#filter` handler, and drag-and-drop all read that list, so each needs checking or cards will appear to disappear.
- "Active execution column" is derived from `config.stages`, so `Done` is not one — a Done child stays nested under its epic and is reflected in the progress count. That is intentional but is a visible behavior choice worth confirming.
- `test/ui/*` is deliberately outside the `node --test test/*.test.js` glob and needs a browser; per repo policy a browser that won't start skips rather than fails, so a green `npm test` on a browserless box does not prove the UI criteria. Run the UI glob explicitly when verifying.
- Board polling re-renders cards wholesale; any UI state (expansion, active drawer tab) kept in the DOM will be lost on the next poll.

## Run Log
- 2026-07-31 20:58Z · Plan · 14 turns · $1.006 · ok
- 2026-07-31 20:58Z · Plan · split into 3 sequential chunks: task-0028 → task-0029 → task-0030
