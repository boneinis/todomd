---
id: task-0050
title: Plan and Triage bypass the scheduler entirely so nothing throttles them
status: Review
type: bug
priority: high
labels: []
dependencies: []
created_date: 2026-09-08
source: ui
assignee:
agent:
build_profile: standard
session_id:
worktree:
verification: { attempts: 0, max_attempts: 3, last_verdict: }
triaged:
---

## Description

scheduler.schedule is called for Build, CI, Verify, Chat and Recovery, but never for Plan or Triage. Those two stages spawn immediately on every card handed to them. Neither the per-project concurrency cap, nor the machine-wide global and per-column caps, nor the cpu/memory/disk governor applies. Observed: fifteen cards moved to Plan at once produced eighteen concurrent agents and a one-minute load average of 17.5 on a ten-core machine, with no deferral and no banner, because the admission gate was never consulted. Card creation has the same shape, since each create fires triage. The config comments reasonably read as though the governor covers the board, so an operator cannot discover this from the configuration.

## Acceptance Criteria

- [ ] Plan admissions pass through the scheduler and honour the governor
- [ ] Triage admissions pass through the scheduler and honour the governor
- [ ] Both stages are capped by an explicit column setting, defaulting to a safe value rather than unlimited
- [ ] A deferred Plan or Triage reports its reason the way other columns do
- [ ] A test proves a burst of cards produces no more concurrent agents than the cap allows

## Implementation Plan

## Run Log
