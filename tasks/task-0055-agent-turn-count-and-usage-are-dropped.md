---
id: task-0055
title: Turn count and usage are dropped for the gemini provider
status: Review
type: bug
priority: medium
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
triaged: failed (permission_denied)
---

## Description

Every run log line for the gemini provider reads `0 turns · usage unavailable ·
$0.000`, whatever actually happened. Successful runs that called tools and wrote
files are recorded identically to runs that never started.

The provider does report both. Its streaming result event carries `num_turns`
and a full `usage` object with input, output, thinking and cache-read tokens,
confirmed by invoking the CLI directly with the same flags the runner uses. The
data arrives and is not read.

This is not cosmetic. An operator reading a column of `0 turns` across dozens of
runs reasonably concludes the provider never starts, and that conclusion is
wrong. It happened: a session concluded a provider was completely broken and
recommended removing it from routing, when in fact roughly a third of its runs
had succeeded. A missing metric was read as a measurement.

While fixing, check the result-event shape end to end. One code path keys on a
`type` field while the provider emits its kind under `event`, which is a
plausible source of the drop.

## Acceptance Criteria

- [ ] A gemini run's recorded turn count matches what the provider reported
- [ ] Token usage and cost are recorded when the provider supplies them
- [ ] A run that genuinely took no turns is still distinguishable from one whose metrics were not parsed
- [ ] Where a provider reports no usage at all, the line says so rather than showing zero
- [ ] Coverage over the provider's real result-event shape, not a hand-written fixture

## Verification

Unit coverage of the event parsing against a captured real result event, plus a
board-level check that a completed run's recorded metrics are non-zero.
