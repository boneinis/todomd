---
id: task-0048
title: CI adapter passes an empty diff through the docs-only fast path
status: Done
type: bug
priority: high
labels: [ci]
dependencies: []
sprint: sprint-1
created_date: 2026-09-07
source: agent
assignee:
agent: claude
base_branch: main
worktree: todomd/task-0048
ci_evidence: {  }
ci_remote: {  }
build_profile: standard
build_limits: { max_slices: 3, budget_minutes: 60 }
verification: { attempts: 2, max_attempts: 3, last_verdict:  }
session_id: 78f1e54b-fc88-48fe-a484-f29ea5bf5203
cost_usd: 1.6174
needs_human_reason: nothing_to_test
recovery_stage: CI
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

## Run Log

- 2026-09-29 02:09Z · Build attempt 1 · 49 turns · claude/claude-sonnet-5 · subscription CLI · 92 input, 3.00M cached, 15.3K output · $1.045 est · ok
- 2026-09-29 02:51Z · CI attempt 1 · nothing to test (empty candidate)
  - nothing_to_test: No candidate file changes relative to the base branch. CI did not pass or run; candidate preserved for inspection.
- 2026-09-29 02:53Z · Return to Build · human approved repair attempt 2/3 with instruction: Retry: the previous Build session ended while waiting on a background test run and produced zero committed changes. Implement the CI-adapter fix (empty diff must not take the docs-only fast path; docs-only and code diffs keep their current 
- 2026-09-29 02:59Z · Build attempt 2 · 3 turns · claude/claude-sonnet-5 · subscription CLI · 6 input, 177.1K cached, 985 output · $0.572 est · ok
- 2026-09-29 02:59Z · CI attempt 2 · nothing to test (empty candidate)
  - nothing_to_test: No candidate file changes relative to the base branch. CI did not pass or run; candidate preserved for inspection.

- 2026-09-29 · Closed: already shipped in 3dd9c28 — empty-diff guard (pipeline.js ~2972) + nothing_to_test outcome + 3-case regression test (recommended-fixes.test.js) verified on main. Two builds confirmed zero diff. Stale card.
