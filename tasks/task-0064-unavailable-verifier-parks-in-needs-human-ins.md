---
id: task-0064
title: Unavailable verifier parks cards in Needs Human — should auto-retry with backoff
status: Plan
type: bug
priority: high
labels: [pipeline, verify]
dependencies: []
created_date: 2026-10-01
source: agent
assignee:
agent:
triaged: 2026-10-01
cost_usd: 0
needs_human_reason:
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
