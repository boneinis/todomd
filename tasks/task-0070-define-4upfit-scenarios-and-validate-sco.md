---
id: task-0070
title: Define 4Upfit scenarios and validate scoped rollout
status: Planned
type: feature
priority: medium
labels: []
dependencies: [task-0069]
parent: task-0059
created_date: 2026-10-01
source: chunk
assignee:
agent:
triaged: n/a (chunk 5/5 of task-0059)
build_profile: standard
session_id:
worktree:
verification: { attempts: 0, max_attempts: 3, last_verdict: }
---

## Description

Define 4Upfit scenarios and validate scoped rollout

## Acceptance Criteria

- [ ] The scenario matrix covers every requested 4Upfit workflow with browser actions, persisted assertions, and revision/environment/evidence requirements.
- [ ] Coordinator corrections and known remaining findings are incorporated without claiming unvalidated rollback safety or historical CI as current evidence.
- [ ] A 4Upfit-only fixture demonstrates card and epic enforcement without changing unrelated projects or live cards.
- [ ] Required browser checks execute with browser capability available, and appropriate TODOMD regression/CI checks pass.
- [ ] A TODOMD PR and final evidence report distinguish source implementation, installed runtime, actual live policy state, and supported remaining user actions.

## Implementation Plan

1. Add docs/4upfit-browser-verification.md with local/test prerequisites, deterministic fixture definitions, numbered browser actions, expected persisted outcomes, and required evidence for BOM/assembly quantities into procurement and nesting; derived-blank sourcing or explicit blocking; PO creation and failure recovery preserving historical lines; persisted initial, large-server, and rerun inputs; receiving/consumption/reversal with duplicate protection; secondary-company access; and geometry/sign-off revision changes.
2. Incorporate the named PR 1227 review with coordinator corrections first. Define assertions for migration-number collision, consumed-rerun status preservation, secondary-company consumption/reversal, and post-claim server errors. Preserve the existing explicit blank-demand block. Record unresolved geometry/sign-off expectations as product decisions; do not count those scenarios as passed until expectations are established.
3. Add a 4Upfit-only policy fixture and staged activation runbook after runtime support passes. Identify the five required GitHub gates from applicable 4Upfit rules and require results for the actual integrated revision. Treat the recorded PR head/check results as historical; validate current PR and integrated revisions during execution. Include rollback compatibility checks because the review does not establish safe application rollback or staged-writer compatibility.
4. Validate the complete fixture through the board and browser with missing, failed, stale, exempt, and successful evidence. Require an available browser for the browser-verification checks; existing Chrome-unavailable skips cannot serve as a pass. Run the focused suites, npm test, and npm run ci. Before any necessary TypeScript check, reuse or wait for an existing run and use a supported scoped check.
5. Submit tested TODOMD source changes as a PR. Report implemented source revision, installed runtime revision, actual viewer MCP evidence, policy state on the live 4Upfit board, and verified remaining user actions separately. Keep activation scoped and preserve live cards, held agents, production boundaries, global defaults, disabled Kimi integration, and the retired-tooling prohibition.
Risks: Application defects may block 4Upfit acceptance scenarios and require separate application cards. This chunk defines and validates board integration/policy; it does not authorize fixing, merging, or deploying 4Upfit application changes.

## Run Log
