# Delivery ownership in the legacy runtime

The runtime now reads durable delivery ownership before admitting legacy work,
offering recovery, or changing a card. This closes a compatibility gap in which
the scheduler could see no local process and treat a privately owned task as
idle. It does not activate delivery execution or migrate existing boards.

## One shared status

`deliveryRuntimeStatus(repoPath, taskId)` and `legacyMutationGuard(repoPath,
taskId)` in `src/delivery-runtime.js` provide the shared assessment. The private
store lives at `<TODOMD_HOME or home>/.todomd/delivery/<SHA-256 of real project
path>/`. Symlink aliases of a checkout share a store. Renaming/moving a checkout
or using a different worktree needs explicit identity migration; this increment
does not silently bind another path to existing records.

An absent record with no pending transaction keeps the legacy behavior. Reads
create no directories, records, or credentials. Authored version 2 frontmatter
alone does not establish private ownership.

| Private state | Legacy behavior |
| --- | --- |
| No record or transaction | Existing admission and recovery rules apply. |
| Valid record, no lease | Held for the delivery workflow; never silently returned to legacy control. |
| Current or expired lease | Held; elapsed time does not prove that execution stopped. |
| Transaction lock, including an unfinished initialization | Held pending transaction reconciliation. |
| Corrupt, unreadable, symlinked, or nonregular record | Held because ownership cannot be verified. |

The read-only status contains a reason, a next action for the project owner,
delivery state/revision, stable owners, blocker category, and whether an existing
lease has expired. It omits private paths, PIDs, run IDs, receipts, commands,
source revisions, and evidence references.

## Runtime and UI integration

- Every scheduler column checks ownership before admission. Held tasks remain
  deferred with an explanation and consume no running slot. Other tasks can run.
- Direct human moves, reset/repair/resume/retry, cancellation, card questions,
  handoffs, prompts, summaries, triage, and resource cleanup reject conflicting
  legacy actions. Recovery eligibility uses the same status.
- Low-level card move/patch/archive/delete/attachment/log/commit operations
  check ownership under the existing repository lock. Reordering checks every
  affected peer before writing. New cards cannot reuse an owned identity or
  create children beneath a delivery-owned parent.
- Boot reconciliation leaves managed cards, prior processes, coordination
  claims, candidates, and remote journals for the delivery reconciliation path.
  Project-wide worktree pruning is skipped when the loaded board has managed
  cards. Legacy chunk advancement does not advance a managed epic.
- Card detail and board responses include `delivery_runtime`. The drawer shows
  a visible hold, owners, and next action for both full-access and viewer users.
  Conflicting controls and card dragging are disabled; opening a normal card
  restores its normal controls. Opening a held card does not request an agent
  summary.

`GET /api/delivery/runtime?project=<registered-name>` returns the same sanitized
status for all cards, including archived cards. Existing full/viewer read
permissions apply. Scoped Board Agent credentials cannot use this raw endpoint.
Other methods are rejected. Legacy per-card HTTP mutations return 409 with the
same hold; viewer writes still return 403 before reaching the ownership guard.

## Activation and remaining guarantees

This is a compatibility guard, not a new execution adapter. It does not acquire
or release a lease, dispatch a delivery-owned task, reconcile an accepted remote
job, or remove a transaction lock. No public initialization, migration, activation,
or ownership-write endpoint is provided.

The next adapter must coordinate source revision checks and durable admission
with legacy and remote writers, resolve trusted roles/grants, verify exact stop
evidence, and offer supported transaction recovery. The present preflight checks
do not make concurrent live migration safe and do not fence arbitrary shell
writes, external budget dispatchers, or work already running before a private
record appears. Keep activation off until those adapters and the pilot acceptance
gates in the [update plan](delivery-workflow-update-plan.md) pass.

On an existing hold, keep candidate and history intact. The project owner must
reconcile the recorded execution and pending operation under the quiesced
procedure in the [ownership contract](delivery-ownership.md). Do not delete a
record or reset attempts to make the legacy controls available again.

Tests cover expired ownership, absent/corrupt/nonregular records, path aliases,
scheduler capacity, direct recovery and low-level writes, reader permissions,
all legacy per-card write routes, restart with a preserved remote journal, and
full/viewer drawer behavior. All fixtures use isolated homes and fake agents.
