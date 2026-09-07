# Candidate preservation and cancellation: September 6, 2026

## Observed mechanism

This review used 4Upfit only as read-only incident evidence. The runtime fix is
based on `f0c0ff6`, on the board-agent-fleet-integration line.

The evidence supports **cancel → delete → automatic fresh Build**, not an
implicit rebase in ordinary CI-failure admission:

- `5ca8510d` at 23:36:55Z records CI → Build, attempt 3. The first repair
  transcript is `build-3-1788737815592.jsonl`, session
  `e2e98043-7cb6-4c37-9154-54cd7ddc6dc9`, socket identifying PID **68160**.
- `96ca296d` at 23:38:18Z records Build → Queue (cancelled).
- The task branch reflog then begins at 23:38:18Z with **branch: Created from
  HEAD**, at `96ca296d`. Its worktree HEAD reflog starts there too, followed by
  `reset: moving to HEAD`. This is a newly created branch/worktree.
- `build-3-1788737899703.jsonl` belongs to a **different** session,
  `420282f3-ca63-4348-84fd-6d25fe578afd`, socket identifying PID **69498**. This
  replacement agent discovers the missing implementation and attempts recovery.
- The coordinator's later 23:44:24Z reset restores `bbd3ebfe`.

The old Build cancel handler called `removeWorktree`, which runs `git worktree
remove --force`, `git branch -D`, then prune. That destroys the administrative
Git directory containing `fleet-runs`. It rolled back the attempt and returned
to Queue, then `enqueueBuild`/`buildChain` called `addWorktree` with `-b` and no
base argument. Git therefore forked current local HEAD, including bookkeeping
commits, instead of the reviewed candidate. The rolled-back counter explains
why both transcripts are called attempt 3. PID 69498 is evidence of a replacement
spawn, not proof that PID 68160 survived the first cancellation.

Independently, the old runner spawned agents without their own process group;
agent cancellation signalled only the leader and cleared escalation on its
close event. Descendant writers could survive. The new regression reproduces
that actual process-management defect with a TERM-resistant descendant, without
claiming it alone explains the incident's replacement PID.

## Behavior choice: A(ii)

Explicit Retry Verification carries a claim across CI/Verify. A CI exit 1 on
that path records `ci_failed` and parks at the same attempt, without a repair
Build. We do not infer infrastructure health from elapsed time or empty output:
the v1 contract deliberately uses exit 1 for both failed checks and invalid
identity. Exit 2 still parks as `ci_blocked`; it never retries or starts Build.
Normal automatic CI failure retains bounded repair, and an actual independent
Verify failure can still request repair. That new repair starts a new attempt
and clears the earlier explicit-retry policy.

Remote cancellation and repair-Build cancellation preserve the worktree,
branch, candidate bytes and opaque adapter journals; no automatic replacement
Build starts. Cancelled Build parks as `build_cancelled`. Both that reason and
Build `agent_error` offer Retry CI + Verification when the preserved worktree
is valid. Remote admission still requires a clean committed candidate and the
adapter still owns exact-source approval. This control grants no approval.

A missing or switched recorded candidate at Build admission now fails closed;
it is never silently recreated from main. Restart remains an explicit recovery
operation for a missing orphan, with its existing branch preservation guard.
This change adds no base-sync operation and no trust-source option.

All agent runners use owned local process groups. Cancellation sends TERM,
escalates to KILL, verifies that no live group member remains, and reaps the
leader before acknowledging success or recording cancellation. A zombie cannot
write; failed process inspection stays conservative. A failed stop confirmation
returns an error and cannot produce a successful cancellation log. The POSIX
process-group regression runs on macOS/Linux; Windows retains leader termination
and does not claim POSIX descendant verification.

## Verification

`test/candidate-recovery.test.js` exercises a silent one-second adapter exit 1,
Build agent_error recovery, candidate ancestry with diverged local main, a real
bounded repair followed by cancellation, TERM-resistant descendant writes,
preserved accepted/running journals with status polling and no resubmission,
and missing/switched candidate admission. Existing CI tests cover exit 2,
source mutation, durable interrupted acknowledgement, shutdown, timeout and
normal assertion failures. These are runtime fixtures, not fleet qualification.

## Coordinated installation plan — not executed

1. Complete exact-commit review and required PR checks on the integration line.
   Preserve the live checkout's unrelated `bin/todomd-mcp.js` edit when assembling
   the reviewed installation candidate; do not overwrite it or cherry-pick live.
2. Coordinate with the board and fleet owners. Pause new admissions through the
   supported controls and let every active stage on every registered board reach
   a safe boundary. PID 27907 on loopback 7337 is not a disposable test server.
   Do not interrupt the live P1 CI simply to install this change.
3. Record installed/candidate commits, active cards, candidate SHAs, journal
   hashes and accepted job identities. Confirm no new admission can race the
   window. Keep held cards and exact-source approvals unchanged.
4. In the agreed quiet window, gracefully stop the old serve, confirm it and its
   local children are gone, install the reviewed runtime, and start one serve
   on the same loopback endpoint. Do not delete worktrees, journals or reset DBs.
5. Verify registered boards, pause flags, recovery controls and preserved
   candidate/journal identities. Reconcile accepted fleet jobs through the
   adapter before any explicitly authorized CI retry. If runtime health fails,
   stop the replacement and restore the recorded prior runtime with boards
   still held. A config-only change needs no restart: configuration loads per
   operation, with execution policy taken from committed config.

Fleet-owned follow-up: diagnose and health-check desktop1-ci unit recipe startup.
No fleet recipe, database, source approval or live runtime was changed here.
