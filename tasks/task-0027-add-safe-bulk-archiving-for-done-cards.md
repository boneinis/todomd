---
id: task-0027
title: Add safe bulk archiving for Done cards
status: Queue
type: improvement
priority: medium
labels: [board-ui, archive, workflow]
dependencies: []
created_date: 2026-07-31
source: ui
assignee:
agent: claude
triaged: manual bypass
session_id: 405bbef0-2994-4d47-9aac-83f5588a11f0
worktree:
verification: { attempts: 0, max_attempts: 3, last_verdict: }
needs_human_reason:
cost_usd: 0.7488
epic: true
children: [task-0031, task-0032]
---

## Description

Add a safe bulk-archive control for the Done column. The current board archives one card at a time. Add a Done-column action that can archive all currently visible Done cards and optionally archive only items older than a selected retention period. Keep archiving reversible through the existing Archived view. Do not archive cards outside Done, active cards, or cards excluded by the current board filter. Show the exact count before confirmation, report partial failures, and preserve current per-card archive behavior.

## Acceptance Criteria

- [ ] The Done column exposes a bulk archive action without affecting other columns.
- [ ] The action supports all visible Done cards and an age-based retention option.
- [ ] A confirmation states the exact number of cards that will be archived.
- [ ] Only eligible Done cards matching the active filter are archived.
- [ ] The operation reports any cards that could not be archived without hiding those failures.
- [ ] Archived cards remain restorable through the existing Archived view.
- [ ] API, unit, and browser tests cover filtering, age selection, confirmation, success, partial failure, and restore compatibility.

## Implementation Plan

## Chunks

```yaml
- title: Bulk archive API and eligibility rules
  type: improvement
  plan: |
    1. `src/board.js` — add and export a pure helper
       `bulkArchiveTargets(cards, { ids, olderThanDays = null, today })` next to
       `setArchived` (~line 358). It takes board cards (the flat shape
       `loadBoard` returns), and partitions the requested `ids` into
       `{ eligible: [id...], skipped: [{ id, reason }...] }`. A card is eligible
       only when it exists, `status === 'Done'`, is not already `archived`, is
       not `unparseable`, and — when `olderThanDays` is set — its `created_date`
       is on or before `today - olderThanDays` days. Reasons are stable strings:
       `not-found`, `not-done`, `already-archived`, `too-recent`, `no-date`.
       A card with `olderThanDays` set but no parseable `created_date` is
       skipped as `no-date` — never archived by an age rule it can't be judged by.
    2. `src/server.js` — add a `POST /api/cards/bulk-archive` route beside the
       per-card archive route (~line 508). Parse `{ ids: [], olderThanDays }`;
       reject a non-array `ids`, an empty list, or a list over 500 with 400.
       Load the board (`includeArchived: true`) and call `bulkArchiveTargets`
       to get the eligible set — the client's list is a *request*, the server
       re-derives what is actually archivable.
    3. In that route, archive eligible cards **sequentially**, reusing the exact
       per-card guard sequence already at `src/server.js:514-519`: skip with
       reason `run-in-progress` if `pipeline.hasLiveRun`, skip with
       `child-building` if it's an epic with `pipeline.hasLiveBuildingChild`,
       else `await pipeline.releaseCardResources`, then
       `pipeline.cascadeEpicCleanup` for epics, then `await setArchived(..., true)`.
       Wrap each card in try/catch so one failure cannot abort the batch.
       Sequential, not parallel: `setArchived` commits per card and the repo
       lock/index is shared.
    4. Return 200 with `{ ok, requested, archived: [id...], failed: [{ id, reason }...] }`
       — `failed` merges ineligible and errored cards. `ok` is true only when
       `failed` is empty; the response always lists every id that did not
       archive, so no failure is hidden. Never return a bare success count.
    5. Gate the route to full access exactly like the other write routes (mirror
       how `/api/cards/:id/archive` is reached — a viewer must get the same
       rejection; see the viewer assertion in `test/server-routes.test.js:265`).
    6. Unit tests in `test/board.test.js`: `bulkArchiveTargets` keeps only Done
       cards, drops non-Done / already-archived / unknown ids with the right
       reason, applies the age cutoff at the boundary (a card exactly N days old
       is eligible; N-1 days is `too-recent`), and skips a Done card with a
       missing or malformed `created_date` as `no-date`. Pass a fixed `today` —
       do not let the test depend on the wall clock.
    7. API tests in `test/server-routes.test.js`: bulk-archive hides the listed
       Done cards from the default board and shows them with `?archived=1`;
       a mixed request (one Done, one Queue, one unknown id) archives only the
       Done card and reports the other two in `failed`; `olderThanDays` archives
       only the older card; a viewer is rejected; the archived cards restore via
       the existing `POST /api/cards/:id/archive` `{"archived":false}` route.
  criteria:
    - bulkArchiveTargets selects only existing, non-archived, Done cards and reports a reason for every id it rejects.
    - The age option excludes cards newer than the cutoff and never archives a card whose created_date is missing or unparseable.
    - POST /api/cards/bulk-archive archives the eligible cards and returns every non-archived id with its reason in a failed list.
    - One card failing does not abort the batch, and cards outside Done are never archived.
    - Bulk-archived cards are restorable through the existing per-card archive route.
    - Unit tests in test/board.test.js and API tests in test/server-routes.test.js cover selection, age cutoff, mixed eligibility, partial failure, viewer rejection, and restore.

- title: Done column bulk archive control
  type: improvement
  plan: |
    1. `public/app.js` — in `renderBoard()` (~line 208), when `col === 'Done'`,
       `boardData.access !== 'viewer'`, `!showArchived`, and `cards.length > 0`,
       add a `<button class="col-bulk-archive">⌦ archive all</button>` into the
       existing `.col-head-right` span alongside the count and the settings
       button. No other column gets it. Wire its click like the sibling buttons
       (`e.stopPropagation()`), passing the already-filtered `cards` array — that
       array is the active filter (text + `mine` view) applied, so eligibility
       follows the board the user is actually looking at.
    2. Add a small `openBulkArchive(doneCards)` dialog to `public/index.html`
       (next to the other overlays) + `public/app.js`. It offers two modes:
       "all visible Done cards" and "older than …" with a retention select
       (7 / 14 / 30 / 90 days). Reuse the existing overlay/dialog markup and
       styles rather than introducing a new pattern.
    3. The dialog recomputes the target count live from `doneCards` whenever the
       mode or retention changes, using the same rule as the server helper
       (Done, not archived, `created_date` on or before the cutoff; cards with
       no usable date are excluded and shown as an explicit "N skipped — no
       date" note). The confirm button states the exact number, e.g.
       "archive 12 cards". When the count is 0 the confirm button is disabled
       and the dialog says nothing matches — never send an empty request.
    4. On confirm, POST the explicit id list plus `olderThanDays` to
       `/api/cards/bulk-archive` with the project query param, matching the
       fetch/headers shape of the drawer archive handler at
       `public/app.js:460-471`. On the response: `toast` the archived count; if
       `failed` is non-empty, surface it in the dialog (or a persistent notice —
       not a toast that disappears) listing each id and its reason, and keep the
       dialog open so the user sees it. Do not report success when cards failed.
       Then `loadBoard()` to refresh.
    5. Confirm the archived-view path still works: the `archived` toggle
       (`public/app.js:144`) re-fetches with `&archived=1`, and each bulk-archived
       card restores from its drawer via the existing `#drawer-archive` button.
       No change should be needed here — verify it, don't rewrite it.
    6. Browser tests in the existing UI test file: the button appears only on the
       Done column and only for full access; a text filter narrows the confirm
       count; picking a retention period lowers the count; confirming archives
       the cards and they vanish from the board; the archived toggle shows them
       and one restores; a request with a failing card renders the failure list
       instead of a plain success. Follow the existing browser-test convention
       that a browser which won't start SKIPS rather than fails (commit af49d20).
    Risks: there is no completion timestamp in card frontmatter — the fields are
    `created_date` and nothing recording when a card reached Done. The age option
    is therefore "created before X", which is NOT the same as "done for X days";
    a long-lived card finished yesterday can match a 90-day cutoff. This plan
    uses `created_date` deliberately (no schema/pipeline change) and labels the
    UI honestly as created-based. If done-based retention is actually wanted,
    that needs a new `done_date` stamped when a card enters Done — a pipeline
    change beyond this card's scope, and a human call.
    Second risk: bulk archiving commits once per card via `setArchived`, so a
    large batch produces many commits and takes time proportional to the count.
    Third risk: `releaseCardResources` / `cascadeEpicCleanup` run per card — an
    epic in Done cascades to its children exactly as a single archive would.
  criteria:
    - The Done column shows a bulk archive control and no other column does.
    - The dialog supports all visible Done cards and an age-based retention option.
    - The confirmation states the exact number of cards that will be archived and is disabled when that number is zero.
    - Only Done cards matching the active board filter are sent for archiving.
    - Any card that could not be archived is listed with its reason and is not reported as a success.
    - Bulk-archived cards appear in the archived view and restore from the card drawer.
    - Browser tests cover filter narrowing, age selection, the confirmation count, a successful run, a partial failure, and restore.
```

## Run Log
- 2026-07-31 21:00Z · Plan · 11 turns · $0.749 · ok
- 2026-07-31 21:00Z · Plan · split into 2 sequential chunks: task-0031 → task-0032
