---
id: task-0062
title: Build agent ends its slice waiting on its own background npm test — every build parks uncommitted_build
status: Plan
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
