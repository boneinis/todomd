---
id: task-0058
title: runCodex never captures the agent message unless a jsonSchema is set — codex Builds report empty finalMessage
status: Review
type: bug
priority: high
labels: [runner, codex]
dependencies: []
created_date: 2026-09-30
source: ui
assignee:
agent:
build_profile: standard
session_id:
worktree:
verification: { attempts: 0, max_attempts: 3, last_verdict: }
---

## Description

In src/runner.js runCodex(), lastMessage is populated only by reading outFile, which is only created when --output-last-message is passed — and that flag is only added inside the `if (jsonSchema)` branch. Plan/Verify run with schemas so they work; Build (and Chat) have no schema, so a codex Build that exits 0 with a real final agent_message reports finalMessage "". Combined with a no-worktree-change run, the pipeline misclassifies it as blocked_build ("no response and no worktree change") even though the agent responded and the work was already committed. Observed live on task-0057 twice: codex replied "Worktree is clean; fix commit 217a8d0 present" via item.completed agent_message events, and the runner recorded finalMessage "" both times.

The codex stream emits agent_message items as {"type":"item.completed","item":{"type":"agent_message","text":"..."}} — handleLine() parses events but never captures item.text into a last-message fallback.

## Acceptance Criteria

- [ ] runCodex captures the last item.completed agent_message text from the event stream and uses it as finalMessage when no --output-last-message file exists
- [ ] A codex Build that produces only a final response (no worktree change) is not misclassified as blocked_build; conversely a truly silent run still is
- [ ] Resume/agent messages, refusal/error events still take precedence where they already do
- [ ] Regression test covers: codex Build turn ending with an agent_message and no schema produces a non-empty result
- [ ] Documented behavior change if docs cover the runner contract

## Implementation Plan

## Run Log
