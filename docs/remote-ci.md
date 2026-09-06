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
