---
id: task-0067
title: Enforce card browser verification across completion paths
status: CI
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
session_id: joyous-cake
worktree: todomd/task-0067
verification: { attempts: 1, max_attempts: 3, last_verdict:  }
base_branch: main
ci_evidence: {  }
ci_remote: {  }
build_limits: { max_slices: 3, budget_minutes: 60 }
cost_usd: 0
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
