---
id: task-0012
title: Strengthen budget-chunk tests replace prose-grep assertions with behavioral coverage
status: Done
type: improvement
priority: low
labels: []
dependencies: []
created_date: 2026-06-11
source: ui
assignee:
agent: claude
session_id: 2e8864cd-87d6-4339-a9e3-5a9aee094c88
worktree:
verification: { attempts: 1, max_attempts: 3, last_verdict: pass }
triaged: 2026-06-12
cost_usd: 1.1893
needs_human_reason:
---

## Description

From code review of the agent-built budget support (commit bd31897).

In `test/budget-chunks.test.js`, 3 of the tests assert that CMD_DISPATCH prose *contains* certain instruction strings (grep), which validates wording, not behavior. (The budget epic-completion behavioral test was already added separately by task-0009.)

Fix: replace or supplement the prose-grep assertions with behavioral tests that exercise the budget functions directly — `materializeChunks` fan-out, `advanceEpicChildren` cascade + completion, and the budget-mode `humanMove` epic approval — so the suite fails if the budget cascade logic regresses, not just if the prompt wording changes.

## Acceptance Criteria

- [ ] The prose-grep CMD_DISPATCH assertions are replaced or supplemented with behavioral assertions exercising the budget functions
- [ ] No loss of coverage; the tests fail if budget cascade logic regresses
- [ ] npm test passes

## Triage

**Insight:** The three prose-grep tests live in `test/budget-chunks.test.js` Section A (lines 56–69) and read from the `CMD_DISPATCH` constant in `src/templates.js` (the string written by `initProject()`). All three target substrings (`todomd fanout`, `epic: true`, `todomd advance`) are present in the template today (`src/templates.js:236,240,247`), so Section A currently passes — but would break on a pure prose refactor without any behavioral regression. The behavioral tests for `materializeChunks` fan-out (Section B), `advanceEpicChildren` cascade (Section C), and epic auto-completion (Section D) are **already committed in the test file at HEAD** — task-0009's broader implementation added all three of B, C, D, not just the completion test mentioned in the description.

**Proposed plan of action:**
1. Run `npm test` to confirm the current suite passes cleanly.
2. Confirm Sections B, C, D cover the same behavioral ground as Section A's intent (fan-out, cascade, approval).
3. Delete the 3 prose-grep tests in Section A (lines 56–69 of `test/budget-chunks.test.js`) — they validate wording only, and B/C/D already guard the behavior.
4. Run `npm test` again to confirm no regressions and the trimmed suite still passes.
5. Commit with a `test:` prefix noting prose-grep removal.

**Estimate:** S — the behavioral tests already exist; the change is deleting ~15 lines and verifying the suite.

**Flags:** none — behavioral coverage is already in place; the only decision (remove vs. keep A) leans clearly toward removal per the task description's intent.

## Implementation Plan

1. Run `npm test` to confirm the current suite passes cleanly before making any changes.
2. In `test/budget-chunks.test.js`, delete the three Section A prose-grep tests (lines 56–69):
   - `'budget: CMD_DISPATCH instructs fanout after split plan'`
   - `'budget: CMD_DISPATCH skips epic tracker cards'`
   - `'budget: CMD_DISPATCH cascades via todomd advance'`
   Also remove the `dispatchPrompt()` helper function (lines 22–27) and the `initProject` import if it becomes unused after removal, and remove the Section A comment block (line 54).
3. Run `npm test` again to confirm the trimmed suite still passes with no regressions.

Risks: none — Sections B, C, D already guard the behavior these prose tests were loosely approximating; removing A does not reduce behavioral coverage.

## Run Log
- 2026-06-12 00:01Z · Triage · 14 turns · $0.479 · ok
- 2026-06-12 00:40Z · Plan · 6 turns · $0.146 · ok
- 2026-06-12 00:42Z · Build attempt 1 · 12 turns · $0.318 · ok
- 2026-06-12 00:44Z · Verify attempt 1 · 10 turns · $0.247 · verdict: pass
