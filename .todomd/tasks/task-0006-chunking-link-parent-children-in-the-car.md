---
id: task-0006
title: Chunking link parent/children in the card drawer
status: Done
type: improvement
priority: low
labels: []
dependencies: []
created_date: 2026-06-11
source: ui
assignee: 
agent: claude
session_id: 359d76c7-20ae-44f1-97fe-3dad116133ac
worktree:
verification: { attempts: 1, max_attempts: 3, last_verdict: pass }
triaged: 2026-06-11
cost_usd: 2.9228
needs_human_reason:
---

## Description

The board cards show small epic/chunk badges, but the drawer has no relationship navigation. Add clickable parent<->children links and show chunk order + blocked-by in the card drawer.

Touch: public/app.js (openDrawer), public/index.html drawer markup, public/style.css.

## Acceptance Criteria

- [ ] Opening an epic lists its child chunks (clickable, in order)
- [ ] Opening a chunk links back to its epic and shows its blocked-by state

## Triage

**Insight:** The drawer's `openDrawer` function (`public/app.js:301`) fetches a card via `/api/cards/${id}`, which returns `card.data` — the raw YAML frontmatter. Epic cards already carry `epic: true` and `children: [id1, id2, ...]` (written by `pipeline.js:522`); chunk cards carry `parent: epicId` and `dependencies: [prevId]` (written at `createCard` time). The board card list in `boardData.cards` (a client-side global) already has live `status` for every card, so blocked-by state can be resolved without an extra API call. The board card renderer (`renderCard`, `app.js:246`) already does this same cross-card lookup for the badge — the drawer just doesn't. No backend changes are needed.

**Proposed plan of action:**
1. Add a `<section id="drawer-rel" hidden>` element inside the drawer markup in `public/index.html`, positioned between `#drawer-meta` and `#drawer-body`.
2. In `openDrawer` (`public/app.js:301`), after populating `#drawer-meta`, check `card.data.epic` and `card.data.parent` to build and inject relationship HTML into `#drawer-rel`; hide the section when neither is set.
3. For epics: iterate `card.data.children` (ordered array), look each id up in `boardData.cards` for its current status, and render each as a clickable chip that calls `openDrawer(childId)`.
4. For chunks: render a clickable "epic: <epicId>" back-link chip plus a dependency line showing each `card.data.dependencies` entry and whether it is Done (unblocked) or not (blocked with a lock icon), again using `boardData.cards` for status.
5. Wire click delegation on `#drawer-rel` (single listener) to call `openDrawer` on chips, so navigation between epic and chunks works without reloading the board.
6. Add minimal CSS in `public/style.css` for the relationship section (chip row + status color cues matching the existing `.card-rel` / `.card-prio` patterns).

**Estimate:** S — pure UI change confined to three files, all required data already flows through the existing API response and the `boardData` global; no server-side work needed.

**Flags:** `card.data.children` may be absent on epic cards created before the `children` field was introduced — guard with `|| []` to avoid a crash. Confirm whether `boardData` is guaranteed non-null when a drawer can be opened (it should be, since the board renders before any card click is possible, but worth a defensive check).

## Implementation Plan

1. Update `public/index.html` drawer markup by inserting `<section id="drawer-rel" class="drawer-rel" hidden></section>` immediately after `<div class="drawer-meta" id="drawer-meta"></div>` and before `#drawer-question`, so relationship navigation appears near the card metadata and ahead of action controls/body content.

2. In `public/app.js`, add small drawer relationship helpers near the drawer code, keeping all generated HTML escaped with the existing `esc()` function:
   - `findBoardCard(id)` should return `boardData?.cards?.find((c) => c.id === id)`.
   - `relChip(id, label)` should render a clickable `<button type="button" class="rel-chip" data-id="...">...<span class="rel-status">...</span></button>` using the matching board card's current status, falling back to `?` when the card is not present in `boardData`.
   - `depChip(id)` should render a non-clickable dependency status chip whose `done` state is `findBoardCard(id)?.status === 'Done'`; blocked dependencies should be visibly marked as blocked and include the dependency id.

3. In `openDrawer(id)`, immediately after populating `#drawer-meta`, populate `#drawer-rel` from `card.data`:
   - For epic cards (`card.data.epic`), read `card.data.children || []` and render the child ids in that exact stored order as clickable chips. Include an empty-state label such as `no chunks` when the list is empty so older epic cards without `children` do not look broken.
   - For chunk cards (`card.data.parent`), render a clickable parent epic chip, then render `card.data.dependencies || []` as a blocked-by/depends-on row. Show when each dependency is Done versus still blocking based on `boardData.cards` status.
   - For cards that are neither epic nor chunk, clear `#drawer-rel` and set `hidden = true`.

4. In `public/app.js`, add one delegated click listener for `#drawer-rel` alongside the other static drawer listeners. It should find the closest element with `data-id`, prevent default, and call `openDrawer(chip.dataset.id)` so navigating epic to chunk and chunk to epic reuses the existing drawer fetch/render flow without a board reload.

5. Add CSS in `public/style.css` after the `.drawer-meta` / `.meta-chip` rules for `.drawer-rel`, `.rel-label`, `.rel-chip`, `.rel-status`, and dependency state classes. Match the existing compact monospace chip style and existing variables (`--line`, `--ink`, `--dim`, `--faint`, `--amber`, `--green`); ensure the row wraps cleanly in the mobile drawer width.

6. Verify with `npm test`, then run the app and manually smoke-test an epic/chunk set: opening an epic shows child chunks in `children` order; clicking a child opens that chunk; opening a chunk links back to the epic; blocked-by chips change between blocked and done based on dependency card status; a normal non-epic card hides the relationship section.

Risks: Older epic cards can lack `children`, so the implementation must guard with `card.data.children || []`. `boardData` should be available whenever a drawer can be opened from the rendered board, but helper lookups should still use optional chaining so archived/missing/out-of-date cards show `?` rather than crashing.

## Run Log
- 2026-06-11 21:13Z · Triage · 11 turns · $0.459 · ok
- 2026-06-12 01:45Z · Plan · 24 turns · $0.471 · ok
- 2026-06-12 02:13Z · Plan · 1 turns · $0.000 · ok
- 2026-06-12 02:21Z · Build attempt 1 · 1 turns · $0.000 · ok
- 2026-06-12 02:23Z · Verify attempt 1 · 15 turns · $0.350 · verdict: pass
  - board_tampering: task branch modifies .todomd/
- 2026-06-12 02:31Z · Build attempt 1 · 1 turns · $0.000 · ok
- 2026-06-12 02:34Z · Verify attempt 1 · 31 turns · $0.629 · verdict: pass
  - board_tampering: task branch modifies .todomd/
- 2026-06-12 02:38Z · Build attempt 1 · 28 turns · $0.659 · ok
- 2026-06-12 02:40Z · Verify attempt 1 · 14 turns · $0.355 · verdict: pass
