---
id: task-0060
title: Present acceptance criteria as a review contract
status: Needs Human
type: bug
priority: medium
labels: []
dependencies: []
parent: task-0053
created_date: 2026-10-01
source: chunk
assignee:
agent:
triaged: n/a (chunk 1/2 of task-0053)
build_profile: standard
session_id: b26aa915-c3a6-4cdc-9cd4-2e849b09c2dc
worktree: todomd/task-0060
verification: { attempts: 1, max_attempts: 3, last_verdict:  }
base_branch: main
ci_evidence: {  }
ci_remote: {  }
build_limits: { max_slices: 3, budget_minutes: 60 }
cost_usd: 1.8143
needs_human_reason: uncommitted_build
recovery_stage: Build
---

## Description

Present acceptance criteria as a review contract

## Acceptance Criteria

- [ ] Card, drawer, summary, and voice presentations describe criteria as review requirements without completion percentages or claims that checked criteria are verified.
- [ ] Only Acceptance Criteria checkboxes contribute to the displayed requirement count.
- [ ] Displaying a card preserves its Acceptance Criteria block unchanged.

## Implementation Plan

1. In src/board.js, retain section-scoped acceptance-criteria parsing and its existing data shape for compatibility; document that checkbox counts are authored contract metadata, not verified completion.
2. In public/app.js, replace the card completion fraction, drawer progress bar, and description-summary completion fraction with a static criterion count and review-time wording. Count only checkboxes within Acceptance Criteria.
3. Update public/index.html and public/style.css to remove the criteria completion bar and completion styling. Preserve the readable criteria body.
4. In src/voice.js, replace the claim that criteria are 'met' with a count of criteria defined for review.
5. Extend test/board.test.js, test/voice.test.js, and test/ui/ui-smoke.test.js for checked and unchecked criteria, absent criteria, and unrelated checkbox sections. Verify with npm run test:unit and npm run test:ui.

## Run Log
- 2026-10-01 02:27Z · Build attempt 1 · 79 turns · claude/claude-sonnet-5 · subscription CLI · 158 input, 5.94M cached, 29.2K output · $1.814 est · incomplete: uncommitted candidate changes
  - uncommitted_build: Build finished but left uncommitted changes. Resume Build and commit or intentionally discard them before CI:
M public/app.js
 M public/index.html
 M public/style.css
 M src/board.js
 M src/server.js
 M src/voice.js
 M test/board.test.js
 M test/ui/ui-smoke.test.js
 M test/voice.test.js
