---
id: task-0028
title: Extract hierarchy helpers behind unit tests
status: Planned
type: improvement
priority: medium
labels: []
dependencies: []
parent: task-0026
created_date: 2026-07-31
source: chunk
assignee:
agent: claude
triaged: n/a (chunk 1/3 of task-0026)
session_id:
worktree:
verification: { attempts: 0, max_attempts: 3, last_verdict: }
---

## Description

Extract hierarchy helpers behind unit tests

## Acceptance Criteria

- [ ] `node --test test/hierarchy.test.js` passes and covers blocked/unblocked dependency state, epic progress, and the nested-vs-full-card partition.
- [ ] Hostile card shapes (scalar `dependencies:`, scalar `children:`, dependency id with no card, child with a missing parent) return sane values instead of throwing.
- [ ] `public/hierarchy.js` loads before `/app.js` in `public/index.html`, and `public/app.js` computes the existing epic/chunk badge and drawer dependency chips through `window.TodomdHierarchy`.
- [ ] `npm test` is green — the board renders exactly as before this chunk.

## Implementation Plan

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

## Run Log
