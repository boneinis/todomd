---
id: task-0059
title: Repair todomd CLI/MCP integration and add browser-verification gates for 4Upfit BOM-PO-nesting
status: Needs Human
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
needs_human_reason: nothing_to_test
build_limits: { max_slices: 6, budget_minutes: 120 }
epic_build_mode: teamwork
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

1. Build in an isolated worktree after checking applicable AGENTS.md/CLAUDE.md. Preserve live cards, held agents, project defaults, production boundaries, and the disabled Kimi integration. Frontmatter was parsed successfully; preserve the existing title and all unauthorized keys.
2. Establish the authoritative runtime by comparing the running server entry point, installed package, and the two named source checkouts. Repair executable packaging/registration through package.json, bin/todomd.js, bin/todomd-mcp.js, and scripts/ci.mjs as needed. Verify both executables resolve in the user's terminal and plugin launch environment. Exercise the packed installation in a temporary environment without starting a duplicate live server.
3. Locate and correct the installed viewer/control plugin manifests and todomd-control skill source; update README.md to describe capabilities actually supported by the installed version. The inspected CLI lacks control-enable: correct that instruction unless an existing supported implementation is found. Preserve viewer-only access, desktop approval, and scoped authorization boundaries. Add regression coverage in test/mcp-server.test.js, then verify MCP initialization, tool discovery, and an actual viewer get_board call against the running server through authorized credential handling without inspecting or exposing token contents. Report any required client reload or supported write-enablement action separately.
4. Add src/browser-verification.js and focused tests defining project-scoped policy, user-visible classification, backend-only exemptions with rationale and automated-test evidence, and persisted verification evidence. Record tested commit, relevant source fingerprint, environment revision, scenarios, results, provider/model, and screenshot or artifact references. Represent missing, failed, stale, exempt, and passed states explicitly. Invalidate evidence after relevant source, scenario, policy, environment, or required-child changes while preserving audit history.
5. Enforce one completion evaluator through src/board.js, src/server.js, src/pipeline.js, src/chunks.js, and active completion adapters in src/delivery.js/src/delivery-session.js. Guard creation, status patches, manual moves, MCP requests, and automated completion so they cannot bypass required evidence. Revalidate under the repository mutation lock before completion. Browser failures return the card to correction; missing capability or infrastructure failure blocks verification. Preserve existing review, CI, recovery, attempt-budget, and authorization behavior.
6. Replace src/chunks.js's unconditional all-children-Done epic completion with scheduling of a distinct integrated browser verification. Require every required card complete and integrated, applicable review and CI gates passed, and epic evidence for the integrated revision. Individual card passes never satisfy this gate. Recheck freshness after integration and before Done; relevant later integration invalidates the epic evidence. Support the same gate for unified epics without children.
7. Extend public/app.js and src/templates.js to show verification requirements, exemptions, evidence, stale reasons, and correction actions. Keep completion decisions authoritative on the server. Extend test/pipeline.test.js, test/chunks.test.js, test/mcp-server.test.js, delivery-adapter tests, and test/ui/production-readiness.test.js to cover missing, failed, stale, passed, and exempt states; direct API bypass attempts; post-verification changes; and all children passing without an epic pass. Required browser checks must block when Chrome or the designated provider is unavailable rather than treating skipped tests as successful evidence.
8. Update src/models.js, src/runner.js, and src/pipeline.js with project-scoped provider routing and browser capability checks. Verify installed provider inventories and supported model identifiers before configuring Gemini 3.8 Flash through Antigravity, Opus 5.5 through Claude Code, SWE-2 through Devin, and Codex coordination/final evidence review. Prefer Opus over Fable for the requested roles; permit only SWE-2 through Devin for this policy. Add routing and capability regression tests in test/models.test.js and runner/pipeline tests. Unsupported requested models or unavailable browser capability remain explicit blockers; do not silently substitute a model or count static review as browser verification.
9. Add docs/4upfit-browser-verification.md with local/test fixtures, expected results, automated assertions, and browser evidence requirements for BOM/assembly quantity propagation; explicit derived-blank sourcing or blocking; PO failure recovery preserving historical lines; persisted initial, large-server, and rerun nesting inputs; receiving, consumption, reversal, and duplicate protection; secondary-company access; and geometry/sign-off revision changes. Incorporate the cited review's coordinator corrections first. Include regression scenarios for migration collisions, consumed-rerun status corruption, primary-company authorization checks, and server validation failures leaving processing jobs. Treat PR 1227's recorded head and CI state as historical; recheck its actual revision and five required GitHub gates before claiming integrated verification. Do not implement, merge, or deploy 4Upfit fixes under this task.
10. Add a documented 4Upfit-only activation procedure and policy fixture after runtime support passes. Do not enable policy or alter live cards during this build without separately established authorization for that live change. Run focused tests, then npm test and npm run ci for the packaged runtime, API, and browser behavior. Coordinate any supported scoped typecheck before starting it. Submit the tested source changes as a PR and report implemented software, installed runtime revision, live policy activation state, evidence, blockers, and verified remaining user commands separately.
Risks: Triage recommends splitting, but this epic has neither epic_build_mode: chunks nor epic_split: true, so the explicit split restriction requires an empty chunks array. src/build-mode.js currently defaults unspecified epics to chunks; execution mode must be reconciled by the board outside this plan's authorized frontmatter scope. Installed plugin/skill locations and authoritative runtime remain to be confirmed. Existing model fallbacks advertise Gemini 3.7 rather than the requested 3.8, and Devin routing currently permits other model families; capability discovery may block the requested policy. Derived-blank and geometry/sign-off product choices remain unresolved acceptance expectations. Shared completion changes can affect existing boards, so opt-in policy and compatibility tests are essential. The review establishes neither safe rollback nor rollout compatibility.
Summary: Returned one unified implementation plan; no files edited.

## Run Log
- 2026-10-01 00:34Z · Triage · 1 turns · gemini/gemini-3.7-flash-high · gateway · usage unavailable · $0.000 est · ok
- 2026-10-01 01:40Z · Plan · 1 turns · codex/gpt-6.1-sol · subscription CLI · 269.2K input, 212.5K cached, 5.2K output · $0.000 est · ok
- 2026-10-01 02:37Z · Build attempt 1 · 31 turns · claude/claude-sonnet-5 · subscription CLI · 32 input, 834.1K cached, 18.4K output · $0.591 est · ok
- 2026-10-01 03:02Z · CI attempt 1 · nothing to test (empty candidate)
  - nothing_to_test: No candidate file changes relative to the base branch. CI did not pass or run; candidate preserved for inspection.
