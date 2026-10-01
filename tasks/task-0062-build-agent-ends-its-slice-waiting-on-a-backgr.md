---
id: task-0062
title: Build agent ends its slice waiting on its own background npm test — every build parks uncommitted_build
status: Done
type: bug
priority: high
labels: [runner, pipeline]
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
base_branch:
worktree:
ci_evidence: { head: 9921a485cb1e82914851282bd31e6f17cecb64e1, command: npm test, execution: local, passed_at: '2026-10-01T19:21:04.076Z', clean: true }
ci_remote: {  }
verification: { attempts: 1, max_attempts: 3, last_verdict: pass }
session_id: grand-gouda
recovery_stage:
---

## Description

Three consecutive Builds (task-0058, task-0055, task-0060 — claude/sonnet) each made real, plan-conforming progress and then ended their turn with a message like "I'll pause here and wait for the background test run to finish" / "I'll end this turn here and resume once the background `npm test` run notifies completion". The slice exits with modified-but-uncommitted files, so the pipeline parks the card `Needs Human · uncommitted_build` and a human has to resume it. With `npm test` taking minutes, the agent is choosing to background it and yield rather than wait in-turn — on every card so far (3/3).

## Acceptance Criteria

- [ ] A Build that leaves work uncommitted because the agent yielded while its own background command was still running does not recur — either the build prompt forbids ending the turn with background work pending, or the runner detects the yielded-on-background pattern and resumes automatically instead of parking Needs Human
- [ ] A genuinely exhausted or no-progress build still reaches Needs Human

## Verification

- [ ] Next two consecutive Builds reach CI or Verify without a human resume for uncommitted_build

## Triage

- **Decision:** Actionable
- **Rationale:** Build agents are yielding early during long-running background test execution, causing unnecessary uncommitted_build stops. The issue is well-understood and can be resolved in the runner or build prompt instructions.
- **Risks or questions:** Ensure that legitimate failures or exhausted attempts still correctly park the card for human review.
- **Next step:** Plan

## Run Log
- 2026-10-01 03:02Z · Triage · 1 turns · gemini/gemini-3.7-flash-high · gateway · usage unavailable · $0.000 est · ok
- 2026-10-01 23:20Z · Root cause (devin) · The resume path at src/pipeline.js:3596 builds `buildOpts.prompt` as a bare "Continue the approved task…" template — it never calls stagePrompt(), so .todomd/local/<command>.md conventions and the command body never reach resumed builds. Reproduced 5×: task-0058 ×3, task-0055 ×2, task-0060 ×2. Orphan `node --test` children outlive dead sessions and inflate load.
- 2026-10-01 11:15Z · Plan · 1 turns · codex/gpt-6.1-sol · subscription CLI · 229.3K input, 167.0K cached, 2.8K output · $0.000 est · ok
- 2026-10-01 14:27Z · Build attempt 1 · 1 turns · claude/claude-sonnet-5 · subscription CLI · usage unavailable · $0.000 est · failed: agent
  - agent_error: You've hit your session limit · resets 11:30am (America/New_York)
- 2026-10-01 15:19Z · Resume Build · continuing attempt 1 after agent_error in preserved worktree todomd/task-0062
- 2026-10-01 15:53Z · Build attempt 1 · 0 turns · devin/swe-2-high · subscription CLI · usage unavailable · $0.000 est · failed: agent
  - agent_error: error
- 2026-10-01 16:34Z · Resume Build · continuing attempt 1 after agent_error in preserved worktree todomd/task-0062
- 2026-10-01 17:41Z · Build attempt 1 · 44 turns · devin/swe-2-high · subscription CLI · 3.21M input, 3.10M cached, 36.1K output · $0.000 est · ok
- 2026-10-01 18:16Z · CI attempt 1 · cancelled (critical resource pressure) — requeued
- 2026-10-01 18:48Z · CI attempt 1 · cancelled (critical resource pressure) — requeued
- 2026-10-01 19:21Z · CI attempt 1 · 230.0s · `npm test` passed
- 2026-10-01 19:22Z · Verify attempt 1 · 1 turns · codex/gpt-6.1-sol · subscription CLI · 26.5K input, 0 cached, 2.5K output · $0.000 est · verdict: pass
