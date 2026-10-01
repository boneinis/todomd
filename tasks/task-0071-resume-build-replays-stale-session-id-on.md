---
id: task-0071
title: Resume Build replays stale session_id on a changed agent — cross-vendor resume fails agent_error
status: Review
type: bug
priority: high
labels: [pipeline, build, routing]
dependencies: []
created_date: 2026-10-01
source: agent
assignee:
agent:
build_profile: standard
session_id:
worktree:
verification: { attempts: 0, max_attempts: 3, last_verdict: }
---

## Description

task-0062 ran Build under claude (session 94f7064a), parked agent_error on a session-limit. While it was parked the board's Build routing changed to devin/swe-2-high. Resume Build re-admitted it and passed the preserved session_id to the NEW agent: `devin` exited 1 with "No session found matching '94f7064a-…'" and the card re-parked agent_error — a second human touch caused purely by routing drift.

Root cause: the Build session_id is vendor-scoped state, but resumeBuildClaimed (src/pipeline.js ~2028, recoveryBuilds sessionId) hands card.data.session_id to whatever agent the current stage routing resolves, with no check that the session belongs to that agent. Claude/codex/gemini/devin session ids are not interchangeable.

Operator workaround used: clear session_id in the card frontmatter, then POST /api/cards/<id>/resume-build — a fresh devin session continues in the preserved worktree.

## Acceptance Criteria

- [ ] A Build resume does not pass a session_id to an agent different from the one that created it — either by recording the session's agent and pinning the resume to it, or by dropping the session and starting a fresh continuation in the preserved worktree
- [ ] The chosen behavior is deterministic and logged in the run log (e.g. 'session dropped: agent changed claude -> devin')
- [ ] A card that built under agent A and is resumed after routing moves to agent B re-parks zero times for session mismatch
- [ ] Regression coverage: argv-capture or fake-runner test proving a foreign-vendor session_id is not forwarded on resume

## Implementation Plan

## Run Log
