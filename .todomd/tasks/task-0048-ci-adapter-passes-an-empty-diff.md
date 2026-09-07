---
id: task-0048
title: CI adapter passes an empty diff through the docs-only fast path
status: Planned
type: bug
priority: high
labels: [ci]
dependencies: []
created_date: 2026-09-07
source: agent
assignee:
agent: claude
base_branch: main
---

## Description

When a Build produces **no diff at all**, the CI adapter takes its docs-only fast
path and returns a pass in about 0.2s. A green CI on an empty candidate is worse
than a red one: it advanced a card to Verify, which then paid to review nothing.

Seen alongside task-0047 — the two compound, and together they turned two
zero-output runs into two "passing" cards.

## Acceptance Criteria

- A zero-file diff is **not** treated as a docs-only change.
- It short-circuits to a distinct outcome ("nothing to test") that does not read as a
  pass and does not advance the card.
- A genuine docs-only change still takes the fast path and still passes.
- Regression tests for all three cases: empty diff, docs-only diff, code diff.

## Verification

Unit test the adapter's classification directly with each of the three diff shapes.
