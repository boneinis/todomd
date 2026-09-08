# Durable delivery ownership core

This increment implements an internal private-state store for delivery
transitions, assignments, handoffs, blockers, and execution leases. It is disabled
by default and has no production HTTP, CLI, scheduler, or board adapter. Existing
boards continue to use their current runtime. This is part of phase 3 of the
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
trusted context synchronously while holding the task transaction lock. Context
provides the authenticated `actor_id`, grants, current legacy/remote busy state,
and reconciled evidence. An asynchronous context resolver is not supported.

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

Every handoff requires nonempty `evidence` and `next_action`. All actions except
renew/release require no persisted lease and explicit `context.busy: false`.
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

The store currently serializes its own writers only. It does not fence the
legacy scheduler, operating-system processes, or a remote execution service.
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

A per-task atomic directory lock serializes separate processes. Competing callers
receive `write_busy` and can retry after reading current state. Lock age never
permits theft. If the process dies mid-transaction, the last complete snapshot is
readable and the abandoned lock remains. Before removing that lock operationally,
an operator must stop all processes using that store and reconcile pending local
and remote execution. Inspect the lock's owner nonce/PID and committed record;
an empty/partial owner file is uncertain, not proof of a dead process. This
increment deliberately has no online lock-recovery endpoint. A safe supported
recovery adapter is required before pilot activation.

## Verified boundary and next work

Tests exercise six independent processes racing admission, process death after
atomic rename, write failures before/after publication, restart and expiry with
an existing lease, stale release/renewal, idempotency under revoked grants,
corrupt snapshots, blockers, preserved handoff history, and unchanged task files.

Remaining integration work: server-owned role/grant resolution; coordinated
legacy/remote admission and stop confirmation; supported transaction-lock
recovery; revision-checked task projection/migration; bounded event retention;
and UI/API adapters. No active boards have been migrated or new agents admitted
through this store.
