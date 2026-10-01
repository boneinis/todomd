---
id: task-0060
title: Present acceptance criteria as a review contract
status: Planned
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
session_id:
worktree:
verification: { attempts: 0, max_attempts: 3, last_verdict: }
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
