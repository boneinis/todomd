# Runtime recovery corrections

These corrections follow the September 8 report that reset and recovery disagree
about active work and that merge-stage holds offer no preserved recovery route.

## Active-cycle admission

Reset to Planned, recovery eligibility, and recovery execution share one activity
check: queued work, child processes, pipeline/CI runs, triage/trigger claims,
advisory/recovery-review claims, and recovery admission claims all count as busy.
A recovery review may inspect eligibility while holding only its own claim.
The existing trigger-finalization wait remains in place.

Recovery actions and the Planned reset claim the card synchronously before
asynchronous worktree checks or writes. Competing resets, recovery requests, and
card prompts are rejected until the transition has settled. The drawer disables
unavailable actions and labels Planned as discarding the candidate and resetting
attempts. This remains an explicit fresh start; it is not a counter-only reset.

## Preserved merge recovery

| Hold | Supported next step |
| --- | --- |
| `merge_conflict`, `merge_noop` | Return to Build with a durable merge-repair handoff, or repair manually and Retry Verification. |
| `base_branch_moved` | Check out the recorded target and Retry Verification. A retry cannot replace a known target. |
| `base_branch_unknown` | Check out the intended local target, enter its name in the drawer, and Retry Verification. The explicit choice is logged. |
| `publication_review_required` | Review and merge through the repository's publication workflow, then Retry Verification to recognize the landed candidate. Retrying before publication keeps the review hold. |

Verification retries preserve the candidate and attempt count. A Return to Build
admits one new repair attempt using the preserved worktree. Missing or switched
worktrees remain ineligible.

Publication policy is unchanged. The board recognizes externally published work
only through candidate ancestry on the intended target; it does not authorize a
merge on a board that requires publication review. Use a merge that retains the
candidate commits: squash/cherry-pick equivalence is not inferred. The candidate
worktree must remain available until recovery completes.

At the merge boundary, the target branch and required exact-candidate CI evidence
are checked again. A previously verified candidate already present in the target
can rerun CI despite its now-empty target diff; an ordinary empty Build remains
blocked. A later CI interruption can retry this same published candidate again.
Done still requires the candidate to be an ancestor of the target.

## Regression coverage

- Queue-only and prompt-only ownership reject reset/recovery without changing
  candidate files, HEAD, attempts, or card metadata.
- Concurrent recovery, reset, and advisory requests admit only one transition.
- Every merge hold has its expected preserved recovery path; unknown or changed
  targets reject invalid choices without modifying the candidate.
- Publication review blocks automatic merging, recognizes an external merge, and
  survives a subsequent remote CI interruption without losing its recovery path.
- Browser coverage checks repair buttons, publication guidance, target entry,
  invalid-target submission, and the destructive-reset label.
