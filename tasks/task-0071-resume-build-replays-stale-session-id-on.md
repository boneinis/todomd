---
id: task-0071
title: Resume Build replays stale session_id on a changed agent — cross-vendor resume fails agent_error
status: Planned
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
triaged: 2026-10-01
cost_usd: 0
needs_human_reason:
build_limits: {  }
complexity: medium
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

## Triage

- **Decision:** Actionable
- **Rationale:** The bug and root cause in `resumeBuildClaimed` are clearly identified with deterministic acceptance criteria. The fix is self-contained within the build resume pipeline logic.
- **Risks or questions:** none
- **Next step:** Plan

## Implementation Plan

1. In src/pipeline.js, persist a normalized session_agent alongside session_id whenever spawnTracked observes a Build session and recordRun saves its final session. Use the actual launched vendor, never current routing. Keep other stages from overwriting either field, and clear both together when restarting Build or discarding a session.
2. Carry the saved session owner through resumeBuildClaimed into recoveryBuilds. At Build launch, after resolving the actual vendor through existing routing, forward the saved session only when its normalized owner matches that vendor. Otherwise clear the saved session pair and use the existing fresh recovery prompt in the same worktree, branch, and attempt. Treat missing or invalid ownership on legacy cards as unknown and start fresh. Append a deterministic run-log explanation, such as 'session dropped: agent changed claude -> codex' or 'session dropped: owner unknown'. Check at launch so routing changes after admission are covered.
3. Extend test/pipeline.test.js using its existing fake-agent and fake-codex infrastructure. Capture the receiving runner's arguments and prove that a claude session is never forwarded after Build routing changes to codex. Assert that partial work survives, the attempt stays unchanged, the card completes without a session-mismatch stop, and the run log records the drop. Cover matching ownership, normalized aliases, unknown legacy ownership, and routing changes between admission and launch. Update saved-session fixtures to include ownership where tests intentionally exercise resume or expired-session fallback. Assert ownership is persisted during Build initialization and completion and survives unrelated stages.
4. Run node --test test/pipeline.test.js test/candidate-recovery.test.js, then npm run test:unit to check existing recovery and routing behavior.
Risks: Legacy sessions without recorded ownership lose conversation context; the existing recovery prompt must preserve worktree progress and the authoritative task instructions. Session ID and owner must be persisted together using the existing frontmatter patch mechanism, including initialization before interruption.
The existing card frontmatter was validated with js-yaml; no files were edited.
Summary: Single implementation plan; no split.

## Run Log
- 2026-10-01 17:41Z · Triage · 1 turns · gemini/gemini-3.7-flash-high · gateway · usage unavailable · $0.000 est · ok
- 2026-10-02 00:36Z · Plan · 1 turns · codex/gpt-6.1-sol · subscription CLI · 204.8K input, 164.9K cached, 2.9K output · $0.000 est · ok
