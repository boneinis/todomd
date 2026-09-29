---
id: task-0049
title: Shell-first Build agents cannot run under the current permission model
status: Needs Human
type: improvement
priority: medium
labels: [runner, permissions, sandbox]
dependencies: [task-0047, task-0048]
sprint: sprint-1
created_date: 2026-09-07
source: agent
assignee:
agent: claude
base_branch: main
worktree: todomd/task-0049
ci_evidence: { head: 9abb73f113854f98402384459cee5ab103d24a90, command: npm test, execution: local, passed_at: '2026-09-29T08:05:27.955Z', clean: true }
ci_remote: {  }
build_profile: standard
build_limits: { max_slices: 3, budget_minutes: 60 }
verification: { attempts: 3, max_attempts: 3, last_verdict: fail }
session_id: 19056056-63c9-4a75-897f-aac21f8a66f0
cost_usd: 48.6665
needs_human_reason: attempts_exhausted
recovery_stage:
---

## Description

Two independent problems block Build agents that shell out for ordinary work, and
they interact.

**Permission model.** The safe allow-list is git-only (status/diff/add/commit/log/
rev-parse). That fits an agent which edits files directly through its own tools. An
agent that shells out for everything is denied on its first action — an observed run
died on `pwd` — and returns nothing. Widening to a blanket command allowance is
**not** an acceptable fix: that allow-list is the rail that stops Build agents running
test suites and database resets on the workstation.

**Sandbox vs worktree.** The runner always passes `--sandbox`. Inside it, an allowed
`git status` reported `fatal: not a git repository`, because a worktree's `.git` is a
**file** pointing outside the tree. Committing from the sandbox is therefore doubtful
even once permissions are sorted.

## Acceptance Criteria

- A permission model that lets a shell-first agent do ordinary read-only work
  (`pwd`, `ls`, `cat`, and similar) **without** granting the ability to run test
  suites or reset databases. Name the mechanism — an explicit safe-command list, a
  read-only shell, or a working-directory jail — and say why it holds.
- A sandbox configuration under which a worktree's git resolves and a commit
  succeeds, or an explicit decision that Builds run outside the sandbox with a
  different rail.
- Both proven with a real end-to-end Build on a throwaway card.

## Constraints

- Design first. Write the approach up and stop for review before implementing —
  this changes a security boundary, not just a config value.

## Verification

An end-to-end Build by a shell-first agent that produces a real diff and commits it,
plus evidence that a disallowed command (running a test suite) is still refused.

## Run Log

- 2026-09-29 07:11Z · Build attempt 1 · 46 turns · claude/claude-sonnet-5 · subscription CLI · 70 input, 2.57M cached, 31.2K output · $1.156 est · ok
- 2026-09-29 07:14Z · CI attempt 1 · 209.2s · `npm test` passed
- 2026-09-29 07:15Z · Verify attempt 1 · 1 turns · codex/gpt-5.6-sol · subscription CLI · 17.7K input, 0 cached, 1.4K output · $0.000 est · verdict: fail (unmet: 2)
  - retrying with findings (attempt 2/3)
- 2026-09-29 07:27Z · Build attempt 2 · 28 turns · claude/claude-sonnet-5 · subscription CLI · 46 input, 3.20M cached, 44.6K output · $2.470 est · ok
- 2026-09-29 07:30Z · CI attempt 2 · 171.7s · `npm test` passed
- 2026-09-29 07:32Z · Verify attempt 2 · 1 turns · codex/gpt-5.6-sol · subscription CLI · 199.5K input, 163.3K cached, 5.3K output · $0.000 est · verdict: fail (unmet: 2)
  - escalating after 2 failed reviews: Fable diagnosis → Fable repair → final Codex gate
- 2026-09-29 07:34Z · Escalate attempt 2 · 17 turns · claude/claude-fable-5 · subscription CLI · 30 input, 515.1K cached, 10.5K output · $2.104 est · diagnosis complete
- 2026-09-29 07:54Z · Build attempt 3 · 102 turns · claude/claude-fable-5 · subscription CLI · 174 input, 11.97M cached, 92.5K output · $20.634 est · incomplete: uncommitted candidate changes
  - uncommitted_build: Build finished but left uncommitted changes. Resume Build and commit or intentionally discard them before CI:
M bin/todo
…
c/runner.js
 M src/shell-safe-commands.js
 M test/models.test.js
 M test/server-routes.test.js
 M test/shell-safe-commands-e2e.test.js
 M test/shell-safe-commands.test.js
?? bin/safe-shell-path/
?? test/fixtures/fake-shell-first-agent.js
?? test/shell-first-build-e2e.test.js
- 2026-09-29 07:56Z · Resume Build · continuing attempt 3 after uncommitted_build in preserved worktree todomd/task-0049
- 2026-09-29 07:58Z · Build attempt 3 · 26 turns · claude/claude-sonnet-5 · subscription CLI · 50 input, 4.11M cached, 9.3K output · $22.303 est · ok
- 2026-09-29 08:05Z · CI attempt 3 · 151.9s · `npm test` passed
- 2026-09-29 08:08Z · Verify attempt 3 · 1 turns · codex/gpt-5.6-sol · subscription CLI · 362.0K input, 253.4K cached, 7.8K output · $0.000 est · verdict: fail (unmet: 2)
  - attempts_exhausted: 1. The command rail can execute forbidden programs transitively through allowed Git operations. The gate retains reposit
…
t rerun during this read-only review.
- unmet: A permission model permits ordinary read-only shell work without permitting test suites or database resets, with a mechanism whose safety holds.
- unmet: Both mechanisms are proven by a real end-to-end Build on a throwaway card.
