---
id: task-0066
title: Repair executable discovery and MCP integration
status: Planned
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
session_id:
worktree:
verification: { attempts: 0, max_attempts: 3, last_verdict: }
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
