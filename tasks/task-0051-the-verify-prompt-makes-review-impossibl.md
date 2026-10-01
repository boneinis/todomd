---
id: task-0051
title: The Verify prompt makes review impossible for providers whose only file access is a shell
status: Review
type: bug
priority: high
labels: []
dependencies: []
created_date: 2026-09-08
source: ui
assignee:
agent:
build_profile: standard
session_id:
worktree:
verification: { attempts: 0, max_attempts: 3, last_verdict: }
triaged: 2026-10-01
cost_usd: 0
---

## Description

The Verify stage appends an instruction not to run tests, typecheck, builds, database resets, containers, git mutations or other local processes. The intent is to stop a reviewer re-running the trusted CI result. For a provider with native file-reading tools that is harmless. For a provider whose file access goes exclusively through a shell, the same sentence removes its only way to read the diff, so it cannot review anything. Observed on two cards that had both passed CI: identical single-turn verdicts of fail whose findings said review was blocked for want of a file reader and explicitly stated that no code defect was established. The board treated each as a real failure and re-queued Build, so green candidates were sent for rework against findings that named no defect. This is not load related; the tool-less review path and the resource governor were not involved.

## Acceptance Criteria

- [ ] The read-only instruction distinguishes execution from inspection, so read-only file and diff commands stay available
- [ ] A shell-only provider can read the candidate diff during Verify
- [ ] A verdict of fail requires an identified defect; an unperformable review reports a setup error instead
- [ ] A review that reports a setup error does not re-queue Build
- [ ] Regression coverage for a shell-only provider reviewing a passing candidate

## Triage

- **Decision:** Actionable
- **Rationale:** The issue and its impact on shell-only providers during Verify are clearly defined. The acceptance criteria establish concrete requirements for prompt phrasing, error handling, and test coverage.
- **Risks or questions:** none
- **Next step:** Plan

## Implementation Plan

## Run Log
- 2026-10-01 00:56Z · Triage · 1 turns · gemini/gemini-3.7-flash-high · gateway · usage unavailable · $0.000 est · ok
