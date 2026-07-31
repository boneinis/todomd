---
id: task-0032
title: Done column bulk archive control
status: Planned
type: improvement
priority: medium
labels: []
dependencies: [task-0031]
parent: task-0027
created_date: 2026-07-31
source: chunk
assignee:
agent: claude
triaged: n/a (chunk 2/2 of task-0027)
session_id:
worktree:
verification: { attempts: 0, max_attempts: 3, last_verdict: }
---

## Description

Done column bulk archive control

## Acceptance Criteria

- [ ] The Done column shows a bulk archive control and no other column does.
- [ ] The dialog supports all visible Done cards and an age-based retention option.
- [ ] The confirmation states the exact number of cards that will be archived and is disabled when that number is zero.
- [ ] Only Done cards matching the active board filter are sent for archiving.
- [ ] Any card that could not be archived is listed with its reason and is not reported as a success.
- [ ] Bulk-archived cards appear in the archived view and restore from the card drawer.
- [ ] Browser tests cover filter narrowing, age selection, the confirmation count, a successful run, a partial failure, and restore.

## Implementation Plan

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

## Run Log
