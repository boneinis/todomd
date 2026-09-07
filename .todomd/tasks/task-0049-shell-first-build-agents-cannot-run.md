---
id: task-0049
title: Shell-first Build agents cannot run under the current permission model
status: Planned
type: improvement
priority: medium
labels: [runner, permissions, sandbox]
dependencies: [task-0047, task-0048]
created_date: 2026-09-07
source: agent
assignee:
agent: claude
base_branch: main
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
