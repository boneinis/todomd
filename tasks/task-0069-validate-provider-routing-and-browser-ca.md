---
id: task-0069
title: Validate provider routing and browser capabilities
status: Planned
type: feature
priority: medium
labels: []
dependencies: [task-0068]
parent: task-0059
created_date: 2026-10-01
source: chunk
assignee:
agent:
triaged: n/a (chunk 4/5 of task-0059)
build_profile: standard
session_id:
worktree:
verification: { attempts: 0, max_attempts: 3, last_verdict: }
---

## Description

Validate provider routing and browser capabilities

## Acceptance Criteria

- [ ] Evidence identifies supported installed model identifiers and the executable/provider used for each requested role.
- [ ] Routing tests keep Gemini on Antigravity, Opus on Claude Code, assigned SWE-2 on Devin, and coordination/final evidence review on Codex.
- [ ] This policy refuses Gemini or Opus through Devin and rejects conflicting overrides.
- [ ] Unavailable requested models or missing browser capability block verification and never produce a passing browser verdict.

## Implementation Plan

1. Extend src/models.js and src/runner.js using installed provider inventories and supported capability discovery. Establish the exact supported identifiers corresponding to requested Gemini 3.8 Flash, Opus 5.5, and SWE-2 before configuring routes; do not treat fallback catalogs as proof of availability.
2. Add project-scoped role routing in src/pipeline.js: Antigravity for Gemini browser verification, Claude Code for Opus secondary planning/review, Devin exclusively for assigned SWE-2 implementation, and Codex for coordination/final evidence review. Prefer Opus over Fable for the requested roles.
3. Check browser capability before admission and require execution/artifact evidence before accepting a browser pass. Reject unsupported models, cross-provider routes, unavailable providers, and missing browser capability with explicit blockers. Ensure card overrides and review-chain settings cannot evade this policy.
4. Document configuration and capability checks in docs/providers.md and browser-verification documentation. Extend test/models.test.js, test/runner.test.js, and test/pipeline.test.js with provider inventory fixtures, successful role routing, override rejection, capability failures, and an integration check against supported installed providers.
Risks: The current Gemini fallback includes 3.7 identifiers, and Devin currently accepts other vendors' model families. Requested model availability remains a Build-time dependency; unsupported requests must remain blocked without silent substitution.

## Run Log
