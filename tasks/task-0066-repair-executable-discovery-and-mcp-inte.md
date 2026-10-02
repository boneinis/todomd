---
id: task-0066
title: Repair executable discovery and MCP integration
status: Queue
type: feature
priority: medium
labels: []
dependencies: []
parent: task-0059
created_date: 2026-10-01
source: chunk
assignee:
agent:
triaged: n/a (chunk 1/5 of task-0059)
build_profile: standard
session_id: be8d9dbf-e7d3-4a19-ab01-32a5a924eabb
worktree: todomd/task-0066
verification: { attempts: 3, max_attempts: 4, last_verdict: fail }
base_branch: main
ci_evidence: { head: 44576ba23dc10699fea45f2e5ac6034328e37442, command: npm test, execution: local, passed_at: '2026-10-02T00:19:10.517Z', clean: true }
ci_remote: {  }
build_limits: { max_slices: 3, budget_minutes: 60 }
cost_usd: 0.8975
needs_human_reason:
recovery_stage:
---

## Description

Repair executable discovery and MCP integration

## Acceptance Criteria

- [ ] Both todomd and todomd-mcp resolve in the intended terminal and MCP client launch environment.
- [ ] A viewer get_board call succeeds against the running server, with redacted evidence identifying the runtime.
- [ ] Plugin manifests, installed skill instructions, and documented commands match supported installed capabilities.
- [ ] MCP tests prove viewer writes and unauthorized calls remain refused.

## Implementation Plan

1. Work in an isolated worktree and read applicable AGENTS.md/CLAUDE.md. Identify the authoritative installation and running server among the two named TODOMD checkouts without reading credentials, changing live cards, resuming held agents, or changing global defaults.
2. Both executables already exist in package.json. Repair package installation, executable registration, and terminal/client PATH handling; change package.json, bin/todomd.js, bin/todomd-mcp.js, or packaging scripts only where needed. Test a packed installation before updating the intended runtime, without starting a duplicate live server.
3. Locate both installed plugin manifests and the todomd-control skill. Align launch configuration and README.md with supported CLI capabilities. Correct the unsupported control-enable instruction unless an existing supported implementation is established; preserve viewer, desktop-control, and scoped-agent authorization boundaries.
4. Extend test/mcp-server.test.js and packaging coverage for initialization, tool discovery, viewer reads, hidden/refused writes, invalid credentials, and client argument validation. Verify terminal/client executable discovery and an actual viewer get_board call against the running server using supported credential handling without exposing token contents.
5. Record source/runtime revisions, read-only MCP evidence, and any required client reload or supported write-enablement action. Verify every documented command against the installed version.
Risks: Authoritative installation and plugin/skill locations remain unconfirmed; client environment differences may require a reload. Do not invent an authorization command.

## Run Log
- 2026-10-01 16:11Z · Build attempt 1 · 40 turns · devin/swe-2-high · subscription CLI · 2.54M input, 2.46M cached, 20.6K output · $0.000 est · ok
- 2026-10-01 17:06Z · CI attempt 1 · cancelled (critical resource pressure) — requeued
- 2026-10-01 17:50Z · CI attempt 1 · cancelled (critical resource pressure) — requeued
- 2026-10-01 18:23Z · CI attempt 1 · cancelled (critical resource pressure) — requeued
- 2026-10-01 18:56Z · CI attempt 1 · cancelled (critical resource pressure) — requeued
- 2026-10-01 19:38Z · CI attempt 1 · cancelled (critical resource pressure) — requeued
- 2026-10-01 19:59Z · CI attempt 1 · cancelled (critical resource pressure) — requeued
- 2026-10-01 20:51Z · CI attempt 1 · cancelled (critical resource pressure) — requeued
- 2026-10-01 21:12Z · CI attempt 1 · cancelled (critical resource pressure) — requeued
- 2026-10-01 21:50Z · CI attempt 1 · cancelled (critical resource pressure) — requeued
- 2026-10-01 22:15Z · CI attempt 1 · 224.8s · `npm test` passed
- 2026-10-01 22:16Z · Verify attempt 1 · 1 turns · codex/gpt-6.1-sol · subscription CLI · 25.5K input, 0 cached, 2.0K output · $0.000 est · preliminary review complete; 2 focused checks queued
- 2026-10-01 22:27Z · Verify attempt 1 · 1 turns · codex/gpt-6.1-sol · subscription CLI · 154.2K input, 101.1K cached, 1.7K output · $0.000 est · verdict: fail (unmet: 3)
  - retrying with findings (attempt 2/3)
- Base refreshed before Build admission.
- 2026-10-01 22:52Z · Build attempt 2 · 90 turns · devin/swe-2-high · subscription CLI · 9.11M input, 8.63M cached, 52.6K output · $0.000 est · ok
- 2026-10-01 23:04Z · CI attempt 2 · cancelled (critical resource pressure) — requeued
- 2026-10-01 23:15Z · CI attempt 2 · cancelled (critical resource pressure) — requeued
- 2026-10-01 23:26Z · CI attempt 2 · 192.9s · `npm test` passed
- 2026-10-01 23:29Z · Verify attempt 2 · 1 turns · codex/gpt-6.1-sol · subscription CLI · 32.7K input, 0 cached, 4.8K output · $0.000 est · verdict: fail
  - escalating after 2 failed reviews: Fable diagnosis → Fable repair → final Codex gate
- 2026-10-01 23:30Z · Escalate attempt 2 · 8 turns · claude/claude-opus-5-5 · subscription CLI · 12 input, 134.8K cached, 4.0K output · $0.206 est · diagnosis complete
- Base refreshed before Build admission.
- 2026-10-01 23:47Z · Build attempt 3 · 26 turns · claude/claude-opus-5-5 · subscription CLI · 38 input, 807.5K cached, 13.2K output · $0.692 est · ok (escalation repair)
- 2026-10-01 23:49Z · CI attempt 3 · cancelled (critical resource pressure) — requeued
- 2026-10-01 23:58Z · CI attempt 3 · cancelled (critical resource pressure) — requeued
- 2026-10-02 00:08Z · CI attempt 3 · cancelled (critical resource pressure) — requeued
- 2026-10-02 00:19Z · CI attempt 3 · 273.9s · `npm test` passed
- 2026-10-02 00:21Z · Verify attempt 3 · 1 turns · codex/gpt-6.1-sol · subscription CLI · 341.2K input, 252.5K cached, 3.0K output · $0.000 est · verdict: fail
  - attempts_exhausted: Trusted npm test passed for the exact clean candidate HEAD. Adversarial review found a credential leak in bin/todomd-mcp
…
, exposing the credential in captured client logs. Consume duplicate values without echoing them, or stop parsing with a generic duplicate-option error. Add a regression test asserting duplicate token arguments exit nonzero without including either token in stdout or stderr.
- 2026-10-02 02:21Z · Return to Build · human approved repair attempt 4/4 with instruction: Verify attempt 3 finding (all acceptance criteria otherwise met): credential leak in bin/todomd-mcp.js ~lines 29-40 — duplicate `--token SECRET --token SECRET` leaves the second value unconsumed; the next iteration treats SECRET as an unrec
