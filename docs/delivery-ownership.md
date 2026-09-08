# Durable delivery ownership core

This increment implements an internal private-state store for delivery
transitions, assignments, handoffs, blockers, and execution leases. It is disabled
by default and has no production mutation or dispatch adapter. The internal
[execution coordinator](delivery-execution.md) adds durable dispatch and backend
closure observations for explicitly reserved executions. A subsequent
[runtime compatibility guard](delivery-runtime.md) reads ownership to prevent
conflicting legacy actions. Existing boards continue to use their current
runtime. This is part of phase 3 of the
[update plan](delivery-workflow-update-plan.md), not pilot activation.

## Authority and storage

`createDeliveryStore(directory, { enabled, resolveContext, now })` in
`src/delivery-store.js` receives an explicit server-owned private directory.
Future adapters must partition it by canonical project identity and keep it
outside tracked task content. They must not accept the directory or trusted
context from a card, agent tool argument, or HTTP body.

`read(taskId)` returns the persisted record or null and creates no directories.
It remains available when writes are disabled. `execute(taskId, command)` rejects
writes unless `enabled` is exactly true. No shipped entry point enables it.

Each command has `action`, a unique `idempotency_key`, and an integer
`expected_revision`. An absent record has revision zero. The store resolves the
trusted context synchronously while holding project admission. Context
provides the authenticated `actor_id`, grants, current legacy/remote busy state,
and reconciled evidence. An asynchronous context resolver is not supported. This
callback must be read-only and must not launch child processes, remote work, or
deferred mutations.

Grants are `delivery:<action>`, except transition commands use
`delivery:<destination>`. Acquire additionally needs `delivery:in_progress`
when entering In progress from another state. Grants authorize responsibility;
stable owner IDs themselves are not credentials. Authority must be checked even
when returning a previously committed idempotent result.

One private JSON snapshot holds the current task metadata, source revision,
monotonic revision/fence, current lease, latest handoff, complete events, and
idempotency receipts. Events retain commands, acting identity/grant, handoff
evidence, and the relevant trusted execution/evidence facts. Historical evidence
survives reassignment, reopening, and later handoffs. Store only safe references
in adapter facts; do not pass full provider responses or credentials.

Snapshots use a unique temporary file, file sync, atomic rename, and directory
sync. Private directories and files use modes 0700 and 0600. A checksum detects
accidental corruption; it is not a signature against another process running as
the same OS user. Invalid state fails closed and is never replaced by defaults.
The store does not edit Markdown, commit Git history, change attempts, touch
candidates, run agents, or call external services.

## Operations

| Action | Command fields and behavior |
| --- | --- |
| initialize | Valid version 2 `task` in Backlog plus `source_revision` (SHA-256). Requires no active legacy/remote work. Imports delivery/ownership/blocker intent only. Advanced-state migration remains unavailable. |
| assign | `role`, stable `owner`, and `handoff`. Validates distinct implementation/review ownership; records the prior and next assignment. |
| transition | `to` and any required `reason`. Uses the shared evaluator for evidence and state gates. Entering In progress requires acquire instead. |
| acquire | New `run_id`, `ttl_ms`, and any required rework/resume `reason`. Atomically enters In progress and allocates a lease for the implementation owner, after eligibility checks. |
| renew | Current `lease_id`, `fence`, `run_id`, and `ttl_ms`. Only the current owner may extend an unexpired lease. |
| release | Current lease identity/fence/run and `handoff`. Requires trusted confirmation that this exact execution has stopped. |
| block | A validated `blocker` with category, responsible owner, timestamp, evidence, and next action. Existing blockers must be resolved before replacement. |
| resolve | A `handoff` explaining evidence and next action for the existing blocker. |

Every handoff requires nonempty `evidence` and `next_action`. Metadata actions
require no persisted lease and explicit `context.busy: false`. Renew/release and
the coordinator's dispatch/stop/observation actions instead require the exact
current lease. Dispatch also revalidates source and admission authority.
Initialization and all destinations still pass the version 2 schema. Unresolved
blockers prevent forward progress; withdrawal retains their history in events.

Transitions reuse exact candidate/policy, independent review, integration, and
release requirements from the [foundation contract](delivery-foundation.md).
Initialization cannot import authored Released metadata. A merge alone still
cannot establish a verified release.

## Execution leases and reconciliation

Each lease records a unique ID, monotonic fence, run identity, owner, acquisition
time, and expiry. TTL is between 1 ms and one hour. Run identities cannot be
recycled. Lease expiry rejects renewal but **does not release ownership**:
another writer, reassignment, or transition remains blocked after restart or
expiry until reconciliation confirms the prior execution has stopped.

For release, the trusted adapter supplies `context.stopped` with `lease_id`,
`fence`, `run_id`, `confirmed: true`, and an evidence `reference`. The tuple must
match the current lease. This must cover accepted remote jobs and surviving local
processes, not just elapsed time or an unavailable heartbeat. Releasing an old
fence after replacement is rejected. Admission preserves a durable reservation
before any future adapter could dispatch work.

For an acquisition with an execution journal, release instead requires its
committed backend observation in stopped phase with `closed: true`; the legacy
`context.stopped` shortcut cannot release that execution. See the coordinator
contract for dispatch closure and delayed-start fencing.

The store shares a [project admission gate](delivery-admission.md) with board
repository writes and scheduler starts. The compatibility guard also holds legacy
admission for managed cards, but the store does not itself fence
operating-system processes or a remote execution service.
Those adapters must participate in the same admission protocol and check the
current run/fence before candidate writes and completion. A precomputed
`busy: false` by itself does not provide that cross-system guarantee.

## Retries and transaction locks

State, event, and receipt commit together. Retrying the exact command under the
same actor/key returns the original result with `replayed: true`, even if the
record has since advanced. Reusing the key with different content or identity
fails. Revoked authorization cannot be bypassed through replay. A receipt proves
the private operation was accepted at its recorded revision; it does not prove
that an old lease is still current or authorize dispatch again.

On `commit_uncertain`, read the record or retry the identical key. Never submit a
new external job based on an uncertain acknowledgement. Rejected commands do not
advance revision or create accepted events.

A project-wide, numbered admission record serializes participating processes.
Competing callers receive `write_busy` and can retry after reading current state.
Ownership is never stolen by age. The supported local CLI can retire an exact,
dead metadata transaction on the same host and boot, retaining the committed
snapshot and all execution leases. See [admission and recovery](delivery-admission.md)
for the protocol and command. It cannot recover repository/launch owners, foreign
hosts/boots, or old per-task `.lock` remnants. Those cases still require quiesced
operator reconciliation; never delete ownership to make a card runnable.

## Verified boundary and next work

Tests exercise six independent processes racing admission, process death after
atomic rename, write failures before/after publication, restart and expiry with
an existing lease, stale release/renewal, idempotency under revoked grants,
corrupt snapshots, blockers, preserved handoff history, and unchanged task files.

Remaining integration work: server-owned role/grant resolution; complete
legacy/remote admission and stop confirmation; external orphan reconciliation;
revision-checked task projection/migration; bounded event retention;
and UI/API adapters. No active boards have been migrated or new agents admitted
through this store.
