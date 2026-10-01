---
id: task-0055
title: Turn count and usage are dropped for the gemini provider
status: Verify
type: bug
priority: medium
labels: []
dependencies: []
created_date: 2026-09-08
source: ui
assignee:
agent:
build_profile: standard
session_id: a025e950-c01a-4e1f-b7e3-27e2e7749a73
worktree: todomd/task-0055
verification: { attempts: 2, max_attempts: 3, last_verdict: fail }
triaged: 2026-10-01
cost_usd: 8.3086
needs_human_reason:
build_limits: { max_slices: 3, budget_minutes: 60 }
complexity: medium
base_branch: main
ci_evidence: { head: 6c6d106572e1aad4662e1f349d5b2ad1f97422c6, command: npm test, execution: local, passed_at: '2026-10-01T05:47:58.199Z', clean: true }
ci_remote: {  }
recovery_stage:
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

## Triage

- **Decision:** Actionable
- **Rationale:** The issue identifies a specific event field parsing mismatch in the gemini provider result stream. Acceptance criteria and verification requirements are clearly defined and testable.
- **Risks or questions:** none
- **Next step:** Plan

## Run Log

- 2026-10-01 00:59Z · Triage · 1 turns · gemini/gemini-3.7-flash-high · gateway · usage unavailable · $0.000 est · ok
- 2026-10-01 01:05Z · Review note (devin) · Partially stale: num_turns is recorded now (today's triage shows '1 turns'), but usage is still dropped — the agy result event carries a full usage object yet runGemini's finish() never reads body.usage, so the run line still reports 'usage unavailable'. Remaining work is the usage half only.
- 2026-10-01 01:18Z · Plan · 1 turns · codex/gpt-6.1-sol · subscription CLI · 252.4K input, 206.7K cached, 3.1K output · $0.000 est · ok
- 2026-10-01 02:09Z · Build attempt 1 · 55 turns · claude/claude-sonnet-5 · subscription CLI · 104 input, 3.95M cached, 24.8K output · $1.339 est · incomplete: uncommitted candidate changes
  - uncommitted_build: Build finished but left uncommitted changes. Resume Build and commit or intentionally discard them before CI:
M src/runner.js
 M test/fixtures/fake-gemini.js
 M test/pipeline.test.js
 M test/runner.test.js
- 2026-10-01 02:20Z · Resume Build · continuing attempt 1 after uncommitted_build in preserved worktree todomd/task-0055
- 2026-10-01 02:46Z · Build attempt 1 · 3 turns · claude/claude-sonnet-5 · subscription CLI · 6 input, 312.3K cached, 392 output · $1.416 est · incomplete: uncommitted candidate changes
  - uncommitted_build: Build finished but left uncommitted changes. Resume Build and commit or intentionally discard them before CI:
M src/runner.js
 M test/fixtures/fake-gemini.js
 M test/pipeline.test.js
 M test/runner.test.js
- 2026-10-01 02:49Z · Resume Build · continuing attempt 1 after uncommitted_build in preserved worktree todomd/task-0055
- 2026-10-01 03:17Z · Build attempt 1 · 11 turns · claude/claude-sonnet-5 · subscription CLI · 22 input, 1.21M cached, 2.2K output · $1.714 est · ok
- 2026-10-01 03:29Z · CI attempt 1 · cancelled (critical resource pressure) — requeued
- 2026-10-01 03:49Z · CI attempt 1 · cancelled (critical resource pressure) — requeued
- 2026-10-01 04:21Z · CI attempt 1 · cancelled (critical resource pressure) — requeued
- 2026-10-01 04:31Z · CI attempt 1 · cancelled (critical resource pressure) — requeued
- 2026-10-01 04:52Z · CI attempt 1 · 201.8s · `npm test` passed
- 2026-10-01 04:58Z · Verify attempt 1 · 1 turns · codex/gpt-6.1-sol · subscription CLI · 23.0K input, 0 cached, 1.7K output · $0.000 est · preliminary review complete; 3 focused checks queued
- 2026-10-01 05:23Z · Verify attempt 1 · 1 turns · codex/gpt-6.1-sol · subscription CLI · 198.8K input, 144.3K cached, 1.8K output · $0.000 est · verdict: fail (unmet: 2)
  - retrying with findings (attempt 2/3)
- Base refreshed before Build admission.
- 2026-10-01 05:39Z · Build attempt 2 · 45 turns · claude/claude-sonnet-5 · subscription CLI · 90 input, 6.49M cached, 25.2K output · $3.840 est · ok
- 2026-10-01 05:47Z · CI attempt 2 · 282.9s · `npm test` passed
