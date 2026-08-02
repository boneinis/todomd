---
id: task-0034
title: Expose To-do MD board controls through MCP
status: Verify
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
session_id: dcac5bcd-ea08-41ab-98f1-52c0f62d5b59
worktree: todomd/task-0034
verification: { attempts: 3, max_attempts: 3, last_verdict: fail }
triaged: 2026-07-31
cost_usd: 14.7103
needs_human_reason:
base_branch: main
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

1. Add `@modelcontextprotocol/sdk` to `dependencies` in `package.json`.
2. Create `src/mcp-server.js`:
   - Build an MCP server (stdio transport) that calls into the *same* handlers the HTTP API uses in `src/server.js`, rather than re-implementing board/pipeline logic. Import `loadBoard`, `pipeline`, `listProjects`, `findProject`/project lookup helpers, and the field-sanitization logic already in `src/server.js` (reuse or extract shared helpers instead of copy-pasting regexes like the assignee sanitizer at server.js:244/620).
   - Auth: require a token argument/env var (`TODOMD_MCP_TOKEN` or CLI flag) at process start, checked once against the same `token`/`viewerToken` loaded via `loadToken()` (server.js:127-129). Map to two tool tiers: read tools work with either token, write tools require the full token — mirroring `primary`/`viewerAuthed` in server.js:139/174.
   - Read-only tools (map to existing GET routes): `list_projects` (`/api/projects`), `get_board` (`/api/board`, incl. `includeArchived`), `get_card_file` (`/api/file`, still viewer-token-restricted to prevent path traversal outside the repo per server.js:505), `get_run_state`/diagnostics (whatever `hasLiveRun`/`hasLiveBuildingChild` expose), `list_commands` (`/api/commands`).
   - Write tools (map to existing POST routes, full-token only): `create_card` (`/api/cards`), `move_card` (`pipeline.humanMove`, server.js:592-593), `assign_card` (field update path around server.js:620), `retry_verify` (`pipeline.retryVerification`), `cancel_card` (`pipeline.cancel`), `archive_card` (`pipeline.archiveCard`).
   - Each tool validates its `project` argument against the registry (`findProject`) before doing anything, so a caller can't reach outside a registered project — same boundary the HTTP API already enforces.
   - Return structured JSON results/errors (not raw HTTP responses) suitable for MCP tool-call content, translating existing `400`/`401` error shapes into MCP tool errors with the same messages.
3. Add a small bin entrypoint (e.g. `bin/todomd-mcp.js`) that starts the stdio MCP server, reading the token and project registry path the same way `bin/todomd.js`/`src/server.js` do.
4. Document configuration in `README.md` (or `docs/`): how to set the token, how to point an MCP-capable client (Claude, Codex) at the stdio command, and which tools are read vs. write.
5. Add `test/mcp-server.test.js` covering: unauthenticated calls rejected, viewer token can read but not write, full token can read and write, cross-project access blocked for an unregistered project name, and at least one round-trip per write tool against a temp fixture board (reuse patterns from `test/server-routes.test.js` / `test/helpers.js`).

Risks:
- Triage flagged confirming whether the MCP server auth maps onto the existing token model and whether it runs in-process or standalone — resolved here as: reuse the existing token loader/comparison logic, run as a separate stdio process (bin entrypoint), not embedded in the running HTTP server, to keep the trust boundary simple.
- `/api/file` already has a documented path-traversal concern (server.js:505) — the `get_card_file` tool must not loosen that check.

## Run Log
- 2026-07-31 21:58Z · Triage · 3 turns · $0.162 · ok
- 2026-08-02 13:15Z · Plan · 12 turns · $0.392 · ok
- 2026-08-02 13:54Z · Build attempt 1 · 4 turns · $6.348 · ok
- 2026-08-02 14:02Z · Verify attempt 1 · 1 turns · $0.000 · verdict: fail (unmet: 3)
  - retrying with findings (attempt 2/3)
- 2026-08-02 14:12Z · Build attempt 2 · 4 turns · $2.784 · ok
- 2026-08-02 14:19Z · Verify attempt 2 · 1 turns · $0.000 · verdict: fail (unmet: 2)
  - escalating after 2 failed reviews: Fable diagnosis → Opus repair → final Codex gate
- 2026-08-02 14:22Z · Escalate attempt 2 · 19 turns · $2.527 · diagnosis complete
- 2026-08-02 14:30Z · Build attempt 3 · 42 turns · $2.497 · ok (escalation repair)
