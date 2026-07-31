---
id: task-0034
title: Expose To-do MD board controls through MCP
status: Review
type: feature
priority: high
labels: [mcp, agents, integration]
dependencies: []
created_date: 2026-07-31
source: ui
assignee:
agent: claude
model: claude-sonnet-5
effort: low
session_id: 269da096-0d56-4a38-bfef-4c8fc14e5a9f
worktree:
verification: { attempts: 0, max_attempts: 3, last_verdict: }
triaged: 2026-07-31
cost_usd: 0.1616
---

## Description

Add a thin authenticated MCP server over the existing To-do MD API so Codex, Claude, and other agents can use reliable board tools without duplicating board logic.

## Acceptance Criteria

- [ ] Expose read-only tools for projects, board state, cards, run state, and diagnostic information
- [ ] Expose guarded write tools for creating, assigning, moving, retrying, cancelling, and archiving cards
- [ ] Reuse existing API and authorization rules rather than duplicating pipeline behavior
- [ ] Return clear, structured results suitable for agent tool use
- [ ] Prevent unauthorized callers and unsafe cross-project access
- [ ] Document configuration and local connection steps
- [ ] Add focused automated coverage for tool behavior and authorization

## Triage

- **Decision:** Actionable
- **Rationale:** Scope is a well-bounded feature (MCP server wrapping existing API/auth) with clear acceptance criteria; no unresolved architectural unknowns block starting a plan.
- **Risks or questions:** Confirm how MCP server auth maps to existing API auth/session model, and whether it runs in-process or as a separate process, during planning.
- **Next step:** Plan.

## Implementation Plan

## Run Log
- 2026-07-31 21:58Z · Triage · 3 turns · $0.162 · ok
