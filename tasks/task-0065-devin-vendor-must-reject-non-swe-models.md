---
id: task-0065
title: Devin vendor must reject non-SWE model families — opus/gemini through devin is currently routable
status: Verify
type: bug
priority: high
labels: [runner, models]
dependencies: []
created_date: 2026-10-01
source: agent
assignee:
agent:
triaged: 2026-10-01
cost_usd: 0
needs_human_reason:
build_profile: standard
build_limits: { max_slices: 3, budget_minutes: 60 }
complexity: medium
base_branch: main
worktree: todomd/task-0065
ci_evidence: { head: 5ab8e79508992265238071af86707a3d9c6a5895, command: npm test, execution: local, passed_at: '2026-10-02T12:39:16.982Z', clean: true }
ci_remote: {  }
verification: { attempts: 1, max_attempts: 3, last_verdict:  }
session_id: excessive-jaborosa
---

## Description

`validateModelRoute` in src/models.js explicitly exempts the devin vendor from cross-family rejection (`family !== vendor && vendor !== 'devin'`), because Devin hosts third-party models. But the board's policy is that Devin is exclusively for SWE-2: a card or stage setting `agent: devin` with `model: claude-opus-5-5` (or any claude-/gemini-/codex-family model) currently validates and routes through Devin. The models picker doesn't offer them, but card-level agent/model overrides bypass the picker. Root cause of a real misrouting incident: Opus 5.5 must come through the claude provider, never Devin.

## Acceptance Criteria

- [ ] `validateModelRoute('devin', <model>)` rejects any model outside the swe-/devin-native family (e.g. `claude-opus-5-5`, `gemini-3.8-flash`, `gpt-6.1-sol` → routing_error)
- [ ] swe-2 family models (`swe-2`, `swe-2-high|medium|max`) still validate
- [ ] The same rejection applies to stage config and per-card overrides (UI set path + direct file edit both blocked or flagged)
- [ ] Regression tests cover the cross-family rejection for devin and confirm other vendors' behavior is unchanged

## Verification

- [ ] `validateModelRoute` unit tests: devin+opus/gemini/gpt refused, devin+swe-2 accepted, claude+opus still accepted

## Triage

- **Decision:** Actionable
- **Rationale:** The issue has well-defined scope and explicit acceptance criteria targeting Devin model route validation. All validation rules and regression testing expectations are clear.
- **Risks or questions:** none
- **Next step:** Plan

## Run Log
- 2026-10-01 15:54Z · Triage · 1 turns · gemini/gemini-3.7-flash-high · gateway · usage unavailable · $0.000 est · ok
- 2026-10-02 02:39Z · Plan · 1 turns · codex/gpt-6.1-sol · subscription CLI · 171.7K input, 133.0K cached, 2.6K output · $0.000 est · ok
- 2026-10-02 11:47Z · Build attempt 1 · 22 turns · devin/swe-2-high · subscription CLI · 758.7K input, 720.9K cached, 12.2K output · $0.000 est · ok
- 2026-10-02 11:50Z · CI attempt 1 · cancelled (critical resource pressure) — requeued
- 2026-10-02 12:39Z · CI attempt 1 · 266.3s · `npm test` passed
