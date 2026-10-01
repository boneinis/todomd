---
id: task-0064
title: Unavailable verifier parks cards in Needs Human — should auto-retry with backoff
status: CI
type: bug
priority: high
labels: [pipeline, verify]
dependencies: []
created_date: 2026-10-01
source: agent
assignee:
agent:
triaged: 2026-10-01
cost_usd: 1.5324
needs_human_reason:
build_profile: standard
build_limits: { max_slices: 3, budget_minutes: 60 }
complexity: high
base_branch: main
worktree: todomd/task-0064
ci_evidence: {  }
ci_remote: {  }
verification: { attempts: 3, max_attempts: 3, last_verdict: fail }
session_id: 85190555-31d8-4bb6-a498-ab1ef5643abe
---

## Description

When the Verify provider CLI is unavailable or errors transiently, cards park in Needs Human and wait for a human to retry. task-0044 accumulated 13 "Needs Human -> Verify (retrying unavailable verifier)" cycles plus 3 Build resumes — ~16 human touches for one card. The same recovery path already exists (retryVerification) but is only reachable by hand. Transient verifier unavailability (cli_missing, quota, auth blip) should self-heal the way triage failures already do: retry with backoff while the failure is transient, and only involve a human after a bounded number of retries or when the failure is substantive.

## Acceptance Criteria

- [ ] A Verify admission failure classified transient (cli_missing, quota, auth) is retried automatically with backoff, without consuming the card's approved verification attempt or parking Needs Human
- [ ] After a bounded number of transient retries (or a non-transient failure), the card parks in Needs Human as today
- [ ] A human can still cancel/override while an auto-retry is pending
- [ ] Regression coverage: a card whose verifier comes back within the window completes without human touch; one whose verifier stays down parks exactly once with a clear reason

## Verification

- [ ] Simulated cli_missing then recovery drives a card Verify → Done with zero human moves

## Triage

- **Decision:** Actionable
- **Rationale:** Transient verification failures currently require manual intervention instead of retrying automatically with backoff. The recovery mechanism is well-defined and can leverage existing retry logic with a bounded limit.
- **Risks or questions:** none
- **Next step:** Plan

## Run Log
- 2026-10-01 11:13Z · Triage · 1 turns · gemini/gemini-3.7-flash-high · gateway · usage unavailable · $0.000 est · ok
- 2026-10-01 14:41Z · Plan · 1 turns · codex/gpt-6.1-sol · subscription CLI · 348.5K input, 283.9K cached, 3.4K output · $0.000 est · ok
- 2026-10-01 17:04Z · Build attempt 1 · 44 turns · devin/swe-2-high · subscription CLI · 3.09M input, 3.02M cached, 20.5K output · $0.000 est · ok
- 2026-10-01 17:45Z · CI attempt 1 · 221.5s · `npm test` passed
- 2026-10-01 17:51Z · Verify attempt 1 · 1 turns · codex/gpt-6.1-sol · subscription CLI · 27.0K input, 0 cached, 1.3K output · $0.000 est · verdict: fail (unmet: 1)
  - retrying with findings (attempt 2/3)
- 2026-10-01 18:36Z · Build attempt 2 · 70 turns · devin/swe-2-high · subscription CLI · 5.36M input, 5.13M cached, 35.1K output · $0.000 est · ok
- 2026-10-01 19:05Z · CI attempt 2 · 249.1s · `npm test` passed
- 2026-10-01 19:08Z · Verify attempt 2 · 1 turns · codex/gpt-6.1-sol · subscription CLI · 28.1K input, 0 cached, 3.1K output · $0.000 est · preliminary review complete; 1 focused check queued
- 2026-10-01 19:45Z · Verify attempt 2 · 1 turns · codex/gpt-6.1-sol · subscription CLI · 180.7K input, 131.6K cached, 1.3K output · $0.000 est · verdict: fail
  - escalating after 2 failed reviews: Fable diagnosis → Fable repair → final Codex gate
- 2026-10-01 19:46Z · Escalate attempt 2 · 9 turns · claude/claude-opus-5-5 · subscription CLI · 14 input, 168.3K cached, 3.5K output · $0.389 est · diagnosis complete
- Base refreshed before Build admission.
- 2026-10-01 20:31Z · Build attempt 3 · 41 turns · claude/claude-opus-5-5 · subscription CLI · 64 input, 1.66M cached, 18.8K output · $1.144 est · ok (escalation repair)
