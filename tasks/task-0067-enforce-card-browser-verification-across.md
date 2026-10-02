---
id: task-0067
title: Enforce card browser verification across completion paths
status: Build
type: feature
priority: medium
labels: []
dependencies: [task-0066]
parent: task-0059
created_date: 2026-10-01
source: chunk
assignee:
agent:
triaged: n/a (chunk 2/5 of task-0059)
build_profile: standard
session_id: equinox-marlin
worktree: todomd/task-0067
verification: { attempts: 4, max_attempts: 4, last_verdict: fail }
base_branch: main
ci_evidence: {  }
ci_remote: {  }
build_limits: { max_slices: 3, budget_minutes: 60 }
cost_usd: 0.5347
needs_human_reason:
recovery_stage:
---

## Description

Enforce card browser verification across completion paths

## Acceptance Criteria

- [ ] Missing, failed, stale, and capability-blocked verification prevents completion through UI, API, MCP-accessible, automated, and delivery paths.
- [ ] Fresh browser evidence permits completion; backend-only exemptions require rationale and passing relevant tests.
- [ ] Relevant subsequent changes invalidate verification, while unrelated bookkeeping does not.
- [ ] Failed browser assertions return the card for correction and preserve evidence history.
- [ ] Regression tests confirm projects without the policy retain existing completion behavior.

## Implementation Plan

1. Add src/browser-verification.js and project-scoped configuration support in src/board.js. Keep enforcement opt-in. Persist verification classification, exemption rationale, tested commit/source fingerprint, environment revision, scenarios, results, provider/model, artifact references, and evidence history.
2. Require browser evidence for user-visible changes. Permit backend-only exemptions only with documented rationale and relevant automated-test evidence. Represent missing, failed, stale, passed, exempt, and capability-blocked states. Accept passing evidence through an authenticated, validated recording path rather than trusting arbitrary client-supplied flags.
3. Add a shared completion evaluator inside board mutation locks for moveCard, patchFrontmatter status changes, and completed-status creation. Wire src/server.js, src/pipeline.js finalization and orphan recovery, and src/delivery.js/src/delivery-workflow.js terminal transitions to the same rules. Recheck freshness before merging/finalizing and retain blocked candidates.
4. Return failed assertions to correction through existing attempt-budget behavior; park unavailable browser/infrastructure runs as blockers. Invalidate evidence after relevant source, environment, scenario, or policy changes while preserving freshness through unrelated board bookkeeping.
5. Update public/app.js and src/templates.js with requirements, exemption inputs, evidence, stale reasons, and correction guidance. Extend test/browser-verification.test.js, test/board.test.js, test/server.test.js, test/pipeline.test.js, test/mcp-server.test.js, delivery tests, and browser UI coverage for bypass attempts and revision races.
Risks: Completion guards affect recovery and delivery workflows. Exemption classification and evidence submission must not create bypasses; unaffected projects must retain existing behavior.

## Run Log
- 2026-10-02 04:11Z · Build attempt 1 · 0 turns · devin/swe-2-high · subscription CLI · usage unavailable · $0.000 est · run timeout
  - run_timeout: Build exceeded the 45m stage timeout
- 2026-10-02 11:28Z · Resume Build · continuing attempt 1 after run_timeout in preserved worktree todomd/task-0067
- 2026-10-02 11:33Z · Build attempt 1 · 15 turns · devin/swe-2-high · subscription CLI · 416.3K input, 387.2K cached, 2.7K output · $0.000 est · ok
- 2026-10-02 11:37Z · CI attempt 1 · 241.2s · `npm test` passed
- 2026-10-02 11:49Z · Verify attempt 1 · 1 turns · codex/gpt-6.1-sol · subscription CLI · 555.8K input, 473.6K cached, 3.2K output · $0.000 est · verdict: fail (unmet: 3)
  - retrying with findings (attempt 2/3)
- 2026-10-02 12:34Z · Build attempt 2 · 23 turns · devin/swe-2-high · subscription CLI · 2.12M input, 2.05M cached, 9.9K output · $0.000 est · ok
- 2026-10-02 12:42Z · CI attempt 2 · cancelled (critical resource pressure) — requeued
- 2026-10-02 12:54Z · CI attempt 2 · cancelled (critical resource pressure) — requeued
- 2026-10-02 13:20Z · CI attempt 2 · cancelled (critical resource pressure) — requeued
- 2026-10-02 13:44Z · CI attempt 2 · cancelled (critical resource pressure) — requeued
- 2026-10-02 14:05Z · CI attempt 2 · 246.3s · `npm test` passed
- 2026-10-02 14:06Z · Verify attempt 2 · 1 turns · codex/gpt-6.1-sol · subscription CLI · 41.9K input, 0 cached, 1.5K output · $0.000 est · preliminary review complete; 3 focused checks queued
- 2026-10-02 14:20Z · Verify attempt 2 · 1 turns · codex/gpt-6.1-sol · subscription CLI · 991.7K input, 889.5K cached, 4.9K output · $0.000 est · verdict: fail (unmet: 3)
  - escalating after 2 failed reviews: Fable diagnosis → Fable repair → final Codex gate
- 2026-10-02 14:21Z · Escalate attempt 2 · 9 turns · claude/claude-opus-5-5 · subscription CLI · 14 input, 172.5K cached, 6.8K output · $0.535 est · diagnosis complete
- Base refreshed before Build admission.
- 2026-10-02 15:19Z · Build attempt 3 · ? turns · claude/claude-opus-5-5 · subscription CLI · usage unavailable · $0.000 est · run timeout
  - run_timeout: Build exceeded the 45m stage timeout
- 2026-10-02 15:50Z · Resume Build · continuing attempt 3 after run_timeout in preserved worktree todomd/task-0067
- 2026-10-02 15:50Z · Build attempt 3 · terminated a background process group the finished slice left running
- 2026-10-02 15:50Z · Build attempt 3 · 0 turns · devin/swe-2-high · subscription CLI · usage unavailable · $0.000 est · checkpoint 1/3 (standard): no worktree progress (4 changed paths)
- 2026-10-02 15:55Z · Build attempt 3 · 12 turns · devin/swe-2-high · subscription CLI · 305.6K input, 283.4K cached, 2.7K output · $0.000 est · ok
- 2026-10-02 15:56Z · CI attempt 3 · cancelled (critical resource pressure) — requeued
- 2026-10-02 16:03Z · CI attempt 3 · cancelled (critical resource pressure) — requeued
- 2026-10-02 16:08Z · CI attempt 3 · cancelled (critical resource pressure) — requeued
- 2026-10-02 16:17Z · CI attempt 3 · 191.0s · `npm test` passed
- 2026-10-02 16:19Z · Verify attempt 3 · 1 turns · codex/gpt-6.1-sol · subscription CLI · 42.6K input, 0 cached, 1.4K output · $0.000 est · preliminary review complete; 4 focused checks queued
- 2026-10-02 16:23Z · Verify attempt 3 · 1 turns · codex/gpt-6.1-sol · subscription CLI · 1.16M input, 1.04M cached, 4.6K output · $0.000 est · verdict: fail (unmet: 3)
  - attempts_exhausted: Reviewed all 19 changed files and relevant callers/callees. Accepted trusted npm test evidence for clean HEAD f0d868e3d0
…
nts completion through UI, API, MCP-accessible, automated, and delivery paths.
- unmet: Relevant subsequent changes invalidate verification, while unrelated bookkeeping does not.
- unmet: Failed browser assertions return the card for correction and preserve evidence history.
- 2026-10-02 21:58Z · Return to Build · human approved repair attempt 4/4 with instruction: Verify attempt 3 found 3 defects in evidence freshness/finalization — fix exactly these, preserving prior work in the preserved worktree:

1. src/board.js ~694-737 finalizeCard never checks base_branch against the checked-out branch — a can
