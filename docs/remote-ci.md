# Remote CI adapters

The committed board configuration may opt in with `ci.execution: remote`.
Only use this for a reviewed adapter that submits and polls remote jobs without
running heavyweight checks locally. The default is `local`. As with the CI
command itself, uncommitted configuration cannot opt into this policy.

A remote adapter returns 0 only after validating all applicable checks against
the exact source, including checking the source did not change during the run.
Exit 2 means an unmet prerequisite (approval, unavailable check, or recoverable
infrastructure interruption). The runtime clears CI evidence and moves the card
to Needs Human with `needs_human_reason: ci_blocked`. It does not trigger a repair
Build or retry automatically. Other failures retain normal failure handling.
The runtime does not inspect candidate-written sentinel files or grant source
approval. An operator must resolve the prerequisite and explicitly resume work.

Admission obeys concurrency limits, queue pause, and memory/disk resource checks.
Remote submissions may pass through CPU-only pressure. Critical pressure does
not kill an already-admitted remote adapter; local CI keeps its existing
critical-pressure cancellation behavior. The adapter must not forward its own
termination into remote cancellation. Human cancel, process shutdown or stage
timeout may end local waiting, so persist canonical remote run IDs and recover
results rather than duplicate submissions.

CI evidence records whether it came from local or remote execution. Evidence
from the previous execution mode cannot satisfy Verify after switching modes.
A remote adapter remains responsible for validating source, check and run
identities; a shell exit code alone cannot attest a remote result.

This is an opt-in runtime capability, not a migration of any existing board.
Before enabling it, qualify the adapter's success, failure, blocked, source
change, disconnect/recovery, and pressure behavior. Keep existing database
workloads isolated from all CI reset commands.

## Interrupted runs and explicit recovery

The runtime preserves the candidate worktree and its Git directory on remote-CI
cancel, shutdown, timeout, or boot recovery. It clears evidence and holds the
card as `ci_blocked`, with recovery stage `CI`. Use **retry verification** to
reconcile CI on the same candidate and attempt. This action still respects a
paused queue; resume only when the board owner has cleared the prerequisite.
Concurrent retry requests cannot launch two waiters for the same card.

The adapter owns durable submission identity. It must journal an idempotent
request before submission and reconcile an interrupted acknowledgement with the
controller before submitting again. Saving a run ID only after the submission
command exits leaves a duplicate-submission window. Runtime preservation alone
does not fix that protocol gap. Local process termination must never cancel the
accepted remote job. Lost or uncertain identity must block for reconciliation.

A remote candidate must be clean and committed before submission and unchanged
at completion. Verify and merge recheck candidate HEAD, cleanliness, command,
and execution mode. A policy change while CI admission is queued holds the
candidate for review. Source changes invalidate evidence and hold the candidate
as `ci_evidence_invalid`; this hold does not grant approval to the new source.
Missing or malformed committed configuration cannot enable remote handling.

## Runtime regression evidence and rollout boundary

`test/ci.test.js` uses a durable fake adapter and an independently running worker
to exercise interruption before acknowledgement, preserved journals, explicit
retry without resubmission, pause, resource pressure, mode changes, and stale
source rejection. These tests qualify the runtime contract only. They do not
qualify a real controller, repository adapter, worker recipe, or database reset.

Before installing into a shared service, review compatibility with other
pending runtime changes, pass the required gates, inspect active work on every
registered board, and obtain the coordinated restart window. Keep a record of
the installed commit and rollback path. Installation does not authorize enabling
remote mode, approving generated source, or resuming held cards.
