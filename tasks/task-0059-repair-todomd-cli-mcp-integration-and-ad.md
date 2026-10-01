---
id: task-0059
title: Repair todomd CLI/MCP integration and add browser-verification gates for 4Upfit BOM-PO-nesting
status: Plan
type: feature
priority: high
labels: [mcp, verification, providers, 4upfit]
dependencies: []
epic: true
created_date: 2026-09-30
source: agent
assignee:
agent:
build_profile: long
session_id: 493ac363-8997-43b5-91fe-08e7b2bbf8db
worktree: todomd/task-0059
verification: { attempts: 1, max_attempts: 3, last_verdict:  }
triaged: 2026-10-01
cost_usd: 0.5905
needs_human_reason:
build_limits: {  }
epic_build_mode: chunks
complexity: high
base_branch: main
ci_evidence: {  }
ci_remote: {  }
recovery_stage: CI
---

## Description

Repair the To-do MD integration and implement browser-verification gates for the 4Upfit BOM → PO → nesting workflow.

First inspect the current implementation and applicable AGENTS.md/CLAUDE.md. Work in an isolated worktree. Do not modify live cards, resume held agents, or change global project defaults as a side effect.

1. Repair CLI/MCP integration
- Neither `todomd` nor `todomd-mcp` currently resolves on the user's terminal PATH.
- Source exists under:
  /Users/irvinbowman/web dev/TODOMD
  /Users/irvinbowman/web dev/TODOMD-worktrees/main
- The installed todomd-control skill instructs the user to run:
  todomd control-enable --minutes 5
  However, the inspected CLI does not implement that command.
- Both plugin manifests invoke `todomd-mcp`, but neither viewer nor control MCP tools appeared in the Codex chat.
- Identify the authoritative runtime and repair executable registration, plugin wiring, and documentation/skill mismatches.
- Preserve viewer-only access and existing control authorization boundaries. Do not read or expose token contents, bypass controls, or invent an approval command.
- Verify CLI discovery and an actual read-only MCP board call. Report any user action genuinely required to enable supported writes.

2. Implement verification at two levels
Per card:
- Require browser verification when the card changes user-visible behavior.
- Allow a documented exemption for backend-only work, supported by relevant automated tests.
- Record the tested commit, environment, scenarios, results, and screenshot/evidence references.
- Failed verification returns the card for correction.
- Relevant subsequent changes invalidate the verification.
- Prevent completion when required verification is missing, failed, or stale.

Per epic:
- Require an integrated end-to-end browser check after all required cards are integrated.
- Individual card passes do not satisfy the epic gate.
- Require required cards complete, applicable review and CI gates passed, and browser evidence for the integrated revision.
- Ensure UI, API, and automated completion paths enforce the same rules.

Use the existing board architecture where possible. If these gates need new runtime support, implement and test it before enabling the policy for 4Upfit. Do not impose it on every project without approval.

3. Use the correct providers
- Gemini 3.8 Flash through Antigravity: browser verification.
- Opus 5.5 through Claude Code: secondary planning and review; preferred over Fable.
- SWE-2 through Devin: implementation when assigned.
- Codex: coordination and final evidence review.
- Devin is exclusively for SWE-2. Do not route Gemini or Opus through Devin.
- Verify supported model identifiers and provider capabilities instead of guessing them. Missing browser capability must block verification, never count as a pass.

4. Define 4Upfit's epic acceptance scenarios
Cover:
- BOM and assembly quantities carried correctly into procurement and nesting.
- Explicit sourcing or blocking of derived blank demand.
- PO creation and failure recovery without deleting historical lines.
- Persisted nesting inputs for initial runs, large server runs, and reruns.
- Receiving, consumption, and reversal without double deductions or lost history.
- Secondary-company access.
- Clear behavior when geometry or sign-off revisions change.

Use local/test environments. Preserve 4Upfit's production boundaries, typecheck coordination, and five required GitHub CI gates. Never use the retired fleet tooling.

5. Incorporate the existing review
PR: https://github.com/Service-Drive-Inc/4Upfit/pull/1227
Last checked head: 2eeeba187d81c8c957defff10717a25a340706ca
Last checked state: open, conflicting with main; five CI gates passed on that unchanged head.

Secondary review and plan:
 /Users/irvinbowman/.codex/visualizations/2026/09/30/4upfit-opus-secondary/opus-review-and-plan.txt

The report includes coordinator corrections; read those before adopting its recommendations. Known remaining findings include a migration-number collision, consumed reruns incorrectly becoming failed, primary-company checks in consumption/reversal, and server errors leaving jobs processing.

This task implements board integration and verification controls. Do not silently expand it into fixing or deploying the 4Upfit application.

## Acceptance Criteria

- [ ] `todomd` and `todomd-mcp` resolve on PATH and viewer read-only MCP board call verified against the running server
- [ ] Plugin manifests, installed skills, and CLI capabilities are consistent (e.g. `control-enable` either implemented and documented or the skill corrected); viewer-only and control authorization boundaries preserved
- [ ] Card-level browser-verification gate implemented: required for user-visible changes, documented exemption for backend-only work with test evidence, commit/environment/scenarios/results/evidence recorded, failure returns the card, subsequent changes invalidate, completion blocked when missing/failed/stale
- [ ] Epic-level gate implemented: integrated end-to-end browser check required after required cards integrate; card passes alone do not satisfy it; UI, API, and automated completion paths enforce the same rules
- [ ] Evidence shows missing, failed, stale, and exempt verification states each behave correctly
- [ ] Provider routing verified: Gemini Flash via Antigravity for browser verification, Opus via Claude Code for secondary planning/review, SWE-2 via Devin for implementation, Codex for coordination/final evidence review; missing browser capability blocks rather than passes
- [ ] 4Upfit epic acceptance scenarios defined covering BOM/assembly quantities into procurement and nesting, blank-demand sourcing or blocking, PO failure recovery, persisted nesting inputs (initial/large/rerun), receiving/consumption/reversal, secondary-company access, and geometry/sign-off revision changes
- [ ] PR 1227 review incorporated, including coordinator corrections and remaining findings
- [ ] Deliverables reported: tested source changes and a PR; clear distinction between implemented software, installed runtime, and policy actually enabled on the live 4Upfit board; any remaining user action with commands verified against the installed version

## Triage

- **Decision:** Split into smaller cards
- **Rationale:** The epic bundles three distinct workstreams: fixing todomd CLI/MCP integration, implementing board-level verification gates, and defining 4Upfit acceptance scenarios.
- **Risks or questions:** none
- **Next step:** Split

## Implementation Plan

1. Build in an isolated worktree after reading applicable AGENTS.md/CLAUDE.md. Preserve live cards, held agents, global defaults, production boundaries, and the disabled Kimi integration. The existing card frontmatter parsed successfully; preserve its title and all unauthorized keys. Triage recommends splitting, but neither epic_build_mode: chunks nor epic_split: true is set, so return a unified plan under the explicit split restriction.
2. Establish the authoritative runtime from the running server entry point, installed package, and the two named TODOMD checkouts. Both executables are already declared in package.json. Repair installation/PATH registration and launch configuration; change package.json, bin/todomd.js, bin/todomd-mcp.js, or scripts/ci.mjs only where necessary. Verify executable discovery in terminal and plugin environments and test a packed installation without starting a duplicate live server.
3. Locate the viewer/control plugin manifests and installed todomd-control skill. Align their launch commands and instructions with the authoritative runtime and README.md. The inspected CLI lacks control-enable; correct the skill unless a supported implementation is found. Preserve viewer-only access and existing desktop/scoped control authorization. Extend test/mcp-server.test.js for initialization, tool discovery, and rejected unauthorized writes. Verify an actual viewer get_board call against the running server through supported credential handling without inspecting or exposing token contents. Report any necessary client reload or write-enablement action using commands verified against the installed version.
4. Add src/browser-verification.js and test/browser-verification.test.js for an opt-in, project-scoped policy and persisted evidence schema. Require browser verification for user-visible changes; allow backend-only exemptions with rationale and relevant automated-test results. Record tested commit, relevant source fingerprint, environment/revision, scenarios, results, provider/model, and screenshot/artifact references. Represent missing, failed, stale, passed, exempt, and capability-blocked outcomes. Preserve evidence history and invalidate approval after relevant source, environment, scenario, policy, or required-child changes; unrelated board bookkeeping must not cause perpetual invalidation.
5. Implement a shared completion evaluator and enforce it inside src/board.js mutation locks for moveCard, status patches, and creation with a completed status. Wire src/server.js and active delivery completion transitions in src/delivery.js/src/delivery-session.js to the same evaluator. Update src/pipeline.js to check evidence before merging/finalizing, preserve the candidate when blocked, and guard orphan recovery that currently marks already-merged work Done. Failed browser assertions return the card for correction through existing recovery and attempt-budget behavior; missing capability or infrastructure blocks verification. Extend test/board.test.js, test/pipeline.test.js, test/mcp-server.test.js, and applicable delivery tests to cover bypass attempts and freshness races.
6. Replace src/chunks.js's automatic all-children-Done completion, for opted-in projects, with scheduling of a distinct integrated epic browser check. Require all required cards complete and integrated, applicable review and CI gates passed, and epic evidence tied to the integrated revision and child revisions. Card passes alone never satisfy this gate. Support unified epics as well as epics with children; later relevant integration invalidates the epic pass. Extend test/chunks.test.js and test/pipeline.test.js for incomplete children, unintegrated changes, missing review/CI evidence, stale integrated evidence, and successful epic completion.
7. Add project-scoped provider routing and capability checks in src/models.js, src/runner.js, and src/pipeline.js. Discover supported installed model identifiers before configuring Gemini 3.8 Flash through Antigravity for browser verification, Opus 5.5 through Claude Code for secondary planning/review, SWE-2 through Devin for assigned implementation, and Codex for coordination/final evidence review. Prefer Opus over Fable for the requested roles and restrict this policy's Devin route to SWE-2. Unsupported requested models, unavailable providers, or missing browser capability must produce explicit blockers without substitution or a passing verdict. Add focused coverage in test/models.test.js, test/runner.test.js, and test/pipeline.test.js.
8. Extend public/app.js and src/templates.js to expose verification requirements, exemption rationale, tested revision, evidence, stale reasons, and correction actions. Keep completion authoritative on the server. Extend test/ui/production-readiness.test.js and API tests for missing, failed, stale, passed, exempt, and capability-blocked states, including drag-to-Done and all children passing without an epic pass. Required verification must fail or block when the browser is unavailable; the existing Chrome-unavailable test skip cannot count as browser evidence.
9. Add docs/4upfit-browser-verification.md with local/test fixtures, numbered browser actions, expected persisted outcomes, automated assertions, and evidence requirements. Cover BOM/assembly quantities into procurement and nesting; explicit derived-blank sourcing or blocking; PO failure recovery preserving historical lines; persisted initial, large-server, and rerun nesting inputs; receiving, consumption, reversal, and duplicate protection; secondary-company access; and geometry/sign-off revision changes. Incorporate the cited review's coordinator corrections first, including migration collision, consumed-rerun status corruption, primary-company authorization checks, and server errors leaving jobs processing. Preserve the current explicit blank-demand block pending any product change; surface unresolved geometry behavior as an acceptance decision. Treat the recorded PR 1227 head and five CI passes as historical, and verify the integrated revision and all five required GitHub gates before claiming an epic pass. Document rollout/rollback compatibility risks without implementing, merging, or deploying 4Upfit fixes or using retired fleet tooling.
10. Add a 4Upfit-only policy fixture and activation runbook after runtime support passes. Verify unaffected projects retain existing behavior. Run focused regression suites, then npm test and npm run ci with required browser checks available. Before any needed TypeScript check, reuse or wait for an existing run and use a supported scoped check. Submit tested TODOMD source changes as a PR. Report separately the implemented software revision, installed runtime revision, actual viewer MCP evidence, live 4Upfit policy state, and any verified remaining user action. Preserve live cards and global defaults throughout.
Risks: The runtime defaults unspecified epics to chunks, conflicting with this invocation's unified-plan restriction; the board must reconcile execution mode outside this plan's authorized scope. Authoritative installation and plugin/skill locations remain unconfirmed. Current model fallbacks list Gemini 3.7, and Devin validation permits other model families, so requested routing may be blocked by availability. Shared completion guards can affect recovery, delivery adapters, and existing boards; opt-in compatibility coverage is required. Geometry/sign-off expectations and any alternative derived-blank policy remain unresolved product choices. The review does not establish safe rollback or staged rollout compatibility.
Summary: Wrote a single unified implementation plan; no files edited.

## Run Log
- 2026-10-01 00:34Z · Triage · 1 turns · gemini/gemini-3.7-flash-high · gateway · usage unavailable · $0.000 est · ok
- 2026-10-01 01:40Z · Plan · 1 turns · codex/gpt-6.1-sol · subscription CLI · 269.2K input, 212.5K cached, 5.2K output · $0.000 est · ok
- 2026-10-01 02:37Z · Build attempt 1 · 31 turns · claude/claude-sonnet-5 · subscription CLI · 32 input, 834.1K cached, 18.4K output · $0.591 est · ok
- 2026-10-01 03:02Z · CI attempt 1 · nothing to test (empty candidate)
  - nothing_to_test: No candidate file changes relative to the base branch. CI did not pass or run; candidate preserved for inspection.
- 2026-10-01 14:47Z · Plan · 1 turns · codex/gpt-6.1-sol · subscription CLI · 227.5K input, 175.2K cached, 5.0K output · $0.000 est · ok
