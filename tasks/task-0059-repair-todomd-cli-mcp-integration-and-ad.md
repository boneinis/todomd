---
id: task-0059
title: Repair todomd CLI/MCP integration and add browser-verification gates for 4Upfit BOM-PO-nesting
status: Planned
type: feature
priority: high
labels: [mcp, verification, providers, 4upfit]
dependencies: []
epic: true
created_date: 2026-09-30
source: agent
assignee:
agent:
build_profile: split_required
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
children: [task-0066, task-0067, task-0068, task-0069, task-0070]
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

Split into 5 sequential chunks. Existing frontmatter validated; no files edited.

## Run Log
- 2026-10-01 00:34Z · Triage · 1 turns · gemini/gemini-3.7-flash-high · gateway · usage unavailable · $0.000 est · ok
- 2026-10-01 01:40Z · Plan · 1 turns · codex/gpt-6.1-sol · subscription CLI · 269.2K input, 212.5K cached, 5.2K output · $0.000 est · ok
- 2026-10-01 02:37Z · Build attempt 1 · 31 turns · claude/claude-sonnet-5 · subscription CLI · 32 input, 834.1K cached, 18.4K output · $0.591 est · ok
- 2026-10-01 03:02Z · CI attempt 1 · nothing to test (empty candidate)
  - nothing_to_test: No candidate file changes relative to the base branch. CI did not pass or run; candidate preserved for inspection.
- 2026-10-01 14:47Z · Plan · 1 turns · codex/gpt-6.1-sol · subscription CLI · 227.5K input, 175.2K cached, 5.0K output · $0.000 est · ok
- 2026-10-01 15:39Z · Plan · 1 turns · codex/gpt-6.1-sol · subscription CLI · 317.3K input, 258.7K cached, 6.9K output · $0.000 est · ok
- 2026-10-01 15:39Z · Plan · split into 5 sequential chunks: task-0066 → task-0067 → task-0068 → task-0069 → task-0070
