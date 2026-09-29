---
id: task-0049
title: Shell-first Build agents cannot run under the current permission model
status: Build
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
ci_evidence: {  }
ci_remote: {  }
build_profile: standard
build_limits: { max_slices: 3, budget_minutes: 60 }
verification: { attempts: 2, max_attempts: 3, last_verdict: fail }
session_id: 73d4ff5e-f123-483b-ba6c-b885b671a939
cost_usd: 1.1558
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
