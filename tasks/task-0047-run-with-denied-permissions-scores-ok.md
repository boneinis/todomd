---
id: task-0047
title: A build run with denied permissions and an empty response is scored ok
status: Planned
type: bug
priority: high
labels: [runner, ci]
dependencies: []
created_date: 2026-09-07
source: agent
assignee:
agent: claude
base_branch: main
---

## Description

A Build agent was auto-denied its shell permission in headless mode. It took **0
turns**, returned an **empty response**, and the run was recorded as status `ok`.
This happened twice in a row before a human noticed.

An `ok` verdict is supposed to mean the agent did the work. Here it meant the agent
was never able to start. The card then advanced to Verify, which spent real budget
reviewing an empty diff.

## Acceptance Criteria

- A run that ends with denied actions and no output is scored as a **failure**, not
  `ok`.
- A run that produced zero turns and an empty response can never be scored `ok`,
  whatever the agent reported.
- The recorded reason distinguishes "agent refused / was denied" from "agent ran and
  found nothing to do" — those need different follow-ups.
- Regression test covering a denied-permission run.

## Verification

Simulate a run whose agent is denied its permissions and returns nothing; assert the
recorded outcome is a failure with a reason naming the denial.
