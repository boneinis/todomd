---
id: task-0058
title: runCodex never captures the agent message unless a jsonSchema is set — codex Builds report empty finalMessage
status: Build
type: bug
priority: high
labels: [runner, codex]
dependencies: []
created_date: 2026-09-30
source: ui
assignee:
agent:
build_profile: standard
session_id: d56adc6b-0151-4268-88cd-83fcfdf2f9df
worktree: todomd/task-0058
verification: { attempts: 1, max_attempts: 3, last_verdict:  }
triaged: 2026-09-30
cost_usd: 3.0321
needs_human_reason:
build_limits: { max_slices: 3, budget_minutes: 60 }
complexity: low
base_branch: main
ci_evidence: {  }
ci_remote: {  }
recovery_stage:
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

## Triage

- **Decision:** Actionable
- **Rationale:** The root cause in `src/runner.js` is clearly identified and the acceptance criteria provide a well-defined fix with regression testing.
- **Risks or questions:** none
- **Next step:** Plan

## Implementation Plan

1. In src/runner.js runCodex(), track the latest item.completed event whose item.type is agent_message and item.text is a string. Capture it before forwarding onEvent, preserving session tracking, turn counting, and trailing newline-less event handling.
2. In the close handler, use the captured text when the output-last-message file is absent or unreadable. Keep readable file content authoritative and preserve its existing structured-output parsing. Populate diagnostic.finalMessage and successful envelope.result with the selected message so src/pipeline.js's existing blocked_build guard recognizes response-only Builds. Keep failure events authoritative in envelope.result and leave error, refusal, resume, and spawn handling intact.
3. Extend test/fixtures/fake-codex.js with opt-in stream-message scenarios, including multiple messages, a trailing newline-less message, silent output, and a missing output file. In test/runner.test.js, cover schema-free Build and resumed-run capture, latest-message selection, file precedence, missing-file fallback, malformed/non-message events, and errors remaining failures despite captured text.
4. Add Codex regression cases in test/pipeline.test.js using unchanged clean worktrees: a response-only Build proceeds beyond the blocked_build guard, while a silent completed turn still produces blocked_build. Preserve existing permission-denial and resume behavior tests.
5. Update the blocked-runs contract in docs/providers.md to explain Codex stream fallback and the response-only versus silent distinction. Run node --test test/runner.test.js test/pipeline.test.js.
Risks: Changing successful envelope.result exposes Codex responses to existing pipeline consumers; protect structured-output precedence and error classification with regression tests. The review note's inherited read-only resume sandbox issue is separate and remains outside this fix. Triage has no unresolved flags or human decisions.
Existing card frontmatter validated successfully; no files edited. Single plan with a standard build profile.

## Run Log
- 2026-09-30 15:40Z · Triage · 1 turns · gemini/gemini-3.7-flash-high · gateway · usage unavailable · $0.000 est · ok
- 2026-10-01 01:05Z · Review note (devin) · Confirmed live today on task-0057: four consecutive codex resumes produced real agent_message replies that the runner recorded as finalMessage "" → repeated blocked_build. Also observed: the resumed codex session reported itself read-only and could not commit. Unblocks every codex Build; recommend prioritising.
- 2026-10-01 01:36Z · Plan · 1 turns · codex/gpt-6.1-sol · subscription CLI · 288.7K input, 232.2K cached, 2.5K output · $0.000 est · ok
- 2026-10-01 01:53Z · Build attempt 1 · 65 turns · claude/claude-sonnet-5 · subscription CLI · 124 input, 4.47M cached, 25.8K output · $1.465 est · incomplete: uncommitted candidate changes
  - uncommitted_build: Build finished but left uncommitted changes. Resume Build and commit or intentionally discard them before CI:
M docs/providers.md
 M src/runner.js
 M test/fixtures/fake-codex.js
 M test/pipeline.test.js
 M test/runner.test.js
- 2026-10-01 02:20Z · Resume Build · continuing attempt 1 after uncommitted_build in preserved worktree todomd/task-0058
- 2026-10-01 02:46Z · Build attempt 1 · 4 turns · claude/claude-sonnet-5 · subscription CLI · 8 input, 424.3K cached, 470 output · $1.568 est · incomplete: uncommitted candidate changes
  - uncommitted_build: Build finished but left uncommitted changes. Resume Build and commit or intentionally discard them before CI:
M docs/providers.md
 M src/runner.js
 M test/fixtures/fake-codex.js
 M test/pipeline.test.js
 M test/runner.test.js
- 2026-10-01 02:49Z · Resume Build · continuing attempt 1 after uncommitted_build in preserved worktree todomd/task-0058
