---
id: task-0065
title: Devin vendor must reject non-SWE model families — opus/gemini through devin is currently routable
status: Plan
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
