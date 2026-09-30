---
id: task-0057
title: Close sprint action archives a sprint s Done cards from Dev Flow
status: Build
type: improvement
priority: medium
labels: [devflow, archive]
dependencies: []
created_date: 2026-09-29
source: ui
assignee:
agent: codex
build_profile: standard
session_id: 01a0f289-1ba2-7fb1-bfcf-2c046205ab03
worktree: todomd/task-0057
verification: { attempts: 2, max_attempts: 3, last_verdict: fail }
triaged: 2026-09-29
sprint: sprint-2
cost_usd: 5.0606
needs_human_reason:
build_limits: { max_slices: 3, budget_minutes: 60 }
complexity: medium
base_branch: main
ci_evidence: {  }
ci_remote: {  }
recovery_stage:
model: gpt-5.6-sol
---

## Description

Dev Flow groups cards by their sprint tag, but there is no way to retire a finished sprint — its Done cards pile up on the board forever (archiving is per-card and manual). Add an explicit close-sprint action that bulk-archives every Done card carrying that sprint tag.

This must be an explicit, human-triggered action rather than automatic on last-card-Done: sprint membership can change mid-flight, Done cards are sometimes reopened by verify failures, and sprint close is a review checkpoint. Cards in any status other than Done must never be archived by it.

## Acceptance Criteria

- [ ] A close-sprint endpoint (e.g. POST /api/sprints/<sprint>/close) archives every card whose sprint tag matches AND whose status is Done, using the existing archiveCard path so the live-run guard and epic cascade still apply
- [ ] Cards in non-Done statuses are skipped and reported back in the response; cards that fail the live-run guard are reported as skipped too — the action is best-effort per card, not all-or-nothing
- [ ] Dev Flow shows a close-sprint control for each sprint lane that has at least one Done card, with a confirm step; after closing, archived cards vanish from board + Dev Flow and reappear under the archived view
- [ ] Closing a sprint with zero Done cards reports nothing-to-archive instead of erroring; the action is idempotent
- [ ] Document the behavior in docs/ if a sprint/devflow doc exists

## Triage

- **Decision:** Actionable
- **Rationale:** The scope is well-defined to add a bulk-archive sprint endpoint and a Dev Flow UI control with confirmation. It reuses existing card archiving mechanics and error handling.
- **Risks or questions:** none
- **Next step:** Plan

## Implementation Plan

1. Add `closeSprint(project, sprint)` in `src/pipeline.js`: inspect active cards with the matching normalized sprint, report non-Done cards as skipped, call the existing `archiveCard(project, id, true)` for each Done card, and return per-card archived/skipped results plus a `nothing_to_archive` outcome when applicable. Keep processing after individual guard failures so the operation remains best-effort and idempotent.
2. Add `POST /api/sprints/<sprint>/close` handling in `src/server.js`, including safe sprint decoding/validation and a successful structured response even when no cards are archived or some cards are skipped.
3. Extend `test/server-routes.test.js` and the relevant pipeline test coverage to verify matching Done cards are archived, other sprints and non-Done cards remain active and are reported, live-run refusals are reported without blocking other cards, archived cards appear only in the archived board response, and repeated/empty closes return `nothing_to_archive`.
4. Update `public/devflow.js` to show a close control only for named sprint groups containing at least one Done card and only for users with write access. Require browser confirmation, call the close endpoint, summarize archived/skipped results through the existing toast path, and reload board data so archived cards disappear from Board/Dev Flow immediately.
5. Add focused Dev Flow helper tests in `test/devflow.test.js`, browser interaction coverage in `test/ui/ui-smoke.test.js`, and any small control styling needed in `public/style.css`. Verify hidden controls for viewers and zero-Done/unscheduled groups, cancellation without a request, URL-safe sprint names, confirmation, result messaging, and refreshed rendering.
6. No filename-specific sprint or Dev Flow document exists under `docs/`; therefore no documentation file is currently required by the conditional acceptance criterion. If an existing relevant section is identified while implementing the named files, update that section rather than creating unrelated documentation.
Risks: Sprint names must be encoded and compared consistently with existing `sprintOf` coercion, and the response contract must distinguish ordinary non-Done skips from `archiveCard` guard failures without weakening archive-side resource cleanup or epic cascade behavior.

Summary: wrote a single cohesive implementation plan.

## Run Log
- 2026-09-29 17:19Z · Triage · 1 turns · gemini/gemini-3.7-flash-high · gateway · usage unavailable · $0.000 est · ok
- 2026-09-29 17:22Z · Plan · 1 turns · codex/gpt-5.6-sol · subscription CLI · 146.3K input, 114.0K cached, 3.5K output · $0.000 est · ok
- 2026-09-29 17:48Z · Build attempt 1 · 8 turns · claude/claude-sonnet-5 · subscription CLI · 14 input, 1.04M cached, 1.9K output · $2.530 est · ok
- 2026-09-29 17:49Z · CI attempt 1 · cancelled (critical resource pressure) — requeued
- 2026-09-29 18:02Z · CI attempt 1 · 220.0s · `npm test` passed
- 2026-09-29 18:03Z · Verify attempt 1 · 1 turns · codex/gpt-5.6-sol · subscription CLI · 25.1K input, 0 cached, 2.9K output · $0.000 est · verdict: fail (unmet: 1)
  - retrying with findings (attempt 2/3)
- 2026-09-29 18:11Z · Build attempt 2 · 1 turns · claude/claude-sonnet-5 · subscription CLI · usage unavailable · $2.530 est · failed: agent
  - agent_error: You've hit your weekly limit · resets Sep 30 at 6pm (America/New_York)
- 2026-09-30 13:37Z · Resume Build · continuing attempt 2 after agent_error in preserved worktree todomd/task-0057
- 2026-09-30 13:57Z · Build attempt 2 · 1 turns · codex/gpt-5.6-sol · subscription CLI · 4.48M input, 4.34M cached, 20.6K output · $0.000 est · incomplete: uncommitted candidate changes
  - uncommitted_build: Build finished but left uncommitted changes. Resume Build and commit or intentionally discard them before CI:
M public/devflow.js
 M src/pipeline.js
 M test/devflow.test.js
 M test/pipeline.test.js
 M test/server-routes.test.js
 M test/ui/ui-smoke.test.js
- 2026-09-30 15:02Z · Resume Build · continuing attempt 2 after uncommitted_build in preserved worktree todomd/task-0057
- 2026-09-30 15:11Z · Build attempt 2 · 1 turns · codex/gpt-5.6-sol · subscription CLI · 5.65M input, 5.47M cached, 22.6K output · $0.000 est · blocked: no response and no worktree change
  - blocked_build: Build reported success but produced no response and left the worktree unchanged — nothing was built. Check the stage run log for a refused tool permission, then Resume Build.
- 2026-09-30 15:26Z · Resume Build · continuing attempt 2 after blocked_build in preserved worktree todomd/task-0057
- 2026-09-30 15:26Z · Build attempt 2 · 1 turns · codex/gpt-5.6-sol · subscription CLI · 6.04M input, 5.85M cached, 22.9K output · $0.000 est · blocked: no response and no worktree change
  - blocked_build: Build reported success but produced no response and left the worktree unchanged — nothing was built. Check the stage run log for a refused tool permission, then Resume Build.
- 2026-09-30 15:31Z · Resume Build · continuing attempt 2 after blocked_build in preserved worktree todomd/task-0057
