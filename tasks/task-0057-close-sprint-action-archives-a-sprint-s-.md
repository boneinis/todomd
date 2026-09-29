---
id: task-0057
title: Close sprint action archives a sprint s Done cards from Dev Flow
status: Review
type: improvement
priority: medium
labels: [devflow, archive]
dependencies: []
created_date: 2026-09-29
source: ui
assignee:
agent:
build_profile: standard
session_id:
worktree:
verification: { attempts: 0, max_attempts: 3, last_verdict: }
triaged: 2026-09-29
sprint: sprint-2
cost_usd: 0
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

## Run Log
- 2026-09-29 17:19Z · Triage · 1 turns · gemini/gemini-3.7-flash-high · gateway · usage unavailable · $0.000 est · ok
