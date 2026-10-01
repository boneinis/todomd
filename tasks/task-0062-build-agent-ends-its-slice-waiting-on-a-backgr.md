---
id: task-0062
title: Build agent ends its slice waiting on its own background npm test — every build parks uncommitted_build
status: Review
type: bug
priority: high
labels: [runner, pipeline]
dependencies: []
created_date: 2026-10-01
source: agent
assignee:
agent:
---

## Description

Three consecutive Builds (task-0058, task-0055, task-0060 — claude/sonnet) each made real, plan-conforming progress and then ended their turn with a message like "I'll pause here and wait for the background test run to finish" / "I'll end this turn here and resume once the background `npm test` run notifies completion". The slice exits with modified-but-uncommitted files, so the pipeline parks the card `Needs Human · uncommitted_build` and a human has to resume it. With `npm test` taking minutes, the agent is choosing to background it and yield rather than wait in-turn — on every card so far (3/3).

## Acceptance Criteria

- [ ] A Build that leaves work uncommitted because the agent yielded while its own background command was still running does not recur — either the build prompt forbids ending the turn with background work pending, or the runner detects the yielded-on-background pattern and resumes automatically instead of parking Needs Human
- [ ] A genuinely exhausted or no-progress build still reaches Needs Human

## Verification

- [ ] Next two consecutive Builds reach CI or Verify without a human resume for uncommitted_build

## Triage

## Run Log
