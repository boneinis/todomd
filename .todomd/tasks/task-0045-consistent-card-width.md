---
id: task-0045
title: consistent card width
status: Verify
type: improvement
priority: medium
labels: []
dependencies: []
created_date: 2026-08-02
source: ui
assignee: 
agent: claude
session_id: 2050dace-bb6e-4ac9-861e-4ecc2b082743
worktree: todomd/task-0045
verification: { attempts: 1, max_attempts: 3, last_verdict:  }
triaged: 2026-08-02
cost_usd: 2.8
needs_human_reason:
base_branch: main
---

## Description

the cards are not a consistent width when moving throught the columns

## Acceptance Criteria

- [ ] Implemented and verified

## Implementation Plan

Root cause (from read-only inspection of `public/style.css`): columns themselves are a fixed
`flex: 0 0 264px` (line 141) and never shrink, so the inconsistency comes from *inside* the column:

1. **Scrollbar gutter (primary cause).** `.col-cards` (line 207) is `overflow-y: auto` with no
   reserved gutter. A column holding enough cards to overflow renders a classic, space-consuming
   scrollbar (Windows/Linux, and macOS when "Show scroll bars: Always" is set), which subtracts
   ~8-15px from the content box — so every card in that column is narrower than cards in the
   non-overflowing columns. Dragging a card between a scrolling and a non-scrolling column visibly
   changes its width.
2. **Status border width (secondary).** `.card.running` sets `border-left-width: 3px` (line 521) and
   `.card.queued` sets `border-left: 3px solid` (line 523) against the `.card` baseline of
   `border: 1px` (line 216). The outer border box still fills the column (block-level, `width: auto`),
   but the content box shrinks by 2px, so the card face and its text shift right relative to
   non-running cards. Since running/queued states cluster in specific columns, this reads as
   "cards change width when they move through the columns".

Steps:

1. `public/style.css`, `.col-cards` (~line 207): add `scrollbar-gutter: stable;` so the gutter is
   reserved whether or not the column currently overflows. Keep the existing
   `scrollbar-width: thin` / `scrollbar-color` declarations. Add a short comment stating the intent
   (card width must not depend on whether the column scrolls).
2. `public/style.css`, `.card.running` (~line 521) and `.card.queued` (~line 523): stop varying
   `border-left-width`. Keep the 1px border from `.card` in all states and render the status stripe
   with `box-shadow: inset 3px 0 0 var(--amber)` (running) and `inset 3px 0 0 var(--faint)` (queued),
   preserving `border-color: var(--amber)` on `.card.running`. `.card` is already
   `position: relative` with `box-shadow: var(--shadow-card)`, so append the inset to the existing
   shadow rather than replacing it (`box-shadow: inset 3px 0 0 var(--amber), var(--shadow-card);`)
   so the drop shadow survives. Verify the same treatment does not fight `.card:hover`
   (line 224) — if hover's `box-shadow: var(--shadow-lift)` drops the stripe, add
   `.card.running:hover` / `.card.queued:hover` variants that re-include the inset.
3. Confirm no other rule reintroduces per-state geometry: `.card.archived` (line 736) only changes
   `border-style`/`opacity`, which is width-neutral — leave it alone.
4. Tests: if the repo has a Playwright/browser test harness, add a case that renders one column with
   enough cards to overflow and one without, plus one `.card.running` and one plain card, and
   asserts all four `.card` elements report the same `getBoundingClientRect().width` (and the same
   `clientWidth`). If no browser harness exists, say so in the Run Log and let verification rest on
   inspecting the two CSS rules above rather than inventing a new harness for this change.

Risks:
- `scrollbar-gutter: stable` reserves the gutter on the right only, so cards in every column sit
  ~8px left of true center on platforms with classic scrollbars. This is the intended trade
  (consistency over centering); `both-edges` would restore symmetry but costs a second gutter's
  worth of the 264px column. Do not switch to `both-edges` without flagging it.
- Swapping the status stripe from border to inset shadow slightly changes how the stripe meets the
  card's rounded corners (`--r-card: 8px`) — the inset shadow follows the radius, the border did
  too, so this should be near-identical, but eyeball a running card before calling it done.
- Triage recorded no open flags or human decisions.

## Run Log
- 2026-08-02 13:43Z · Triage · 4 turns · $0.165 · ok
- 2026-08-02 13:58Z · Plan · 11 turns · $0.607 · ok
- 2026-08-02 17:28Z · Build attempt 1 · 59 turns · $2.027 · ok

## Triage

- **Decision:** Actionable
- **Rationale:** The inconsistency is a concrete, localized CSS styling issue; card layout rules live in `public/style.css` and are likely a simple fixed-width/flex-basis fix.
- **Risks or questions:** none
- **Next step:** Plan
