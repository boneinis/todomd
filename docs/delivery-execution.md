# Coordinated delivery execution

The internal coordinator in `src/delivery-execution.js` connects durable leases
to trusted execution backends. It records dispatch before calling a backend,
reconciles uncertain acknowledgements without resubmitting, and releases only
after a committed observation confirms the exact execution is permanently
closed. It is disabled by default. A concrete [local process backend](delivery-local-backend.md)
now implements this contract on macOS/Linux. No server, CLI, or migration command
enables this path yet. Existing boards retain their runtime.

This completes the journal/coordinator portion of phase 3, not its production
integration or pilot acceptance gates. Tests now exercise the coordinator with
the real local backend, including an actual process-group stop. The existing
legacy and fleet runners do not yet participate in this protocol.

## Admission and authority

`createDeliveryExecutionCoordinator(directory, { enabled, resolveContext,
backends, now })` receives the canonical private project store, trusted authority
resolver, and a server-owned backend registry. The caller supplies revisioned
commands, never authority, process IDs, executable commands, or backend objects.

`reserve(taskId, command)` uses the store's `acquire` transaction. In addition to
the existing eligibility, grant, owner, run, and TTL rules, it requires
`execution: { backend, source_revision }`. The store atomically records the lease
and an execution journal in `reserved` phase. The source SHA-256 must match the
mapped task's stored source revision and the trusted `execution_admission`
context. The latter must name the same backend/source and set `fenced: true`.

The adapter must derive that context under an actual admission fence shared by
legacy/remote writers and source changes. The boolean is an attestation from the
trusted adapter, not a lock implemented by this module. The trusted authority
adapter now holds the shared local admission gate through launch. Production
credential and policy bindings, including proof that remote writers participate
in the fence, remain required before initialization or execution on live boards.

Every dispatch/recovery command includes `expected_revision`,
`idempotency_key`, and the execution reference: `task_id`, `lease_id`, `run_id`,
`fence`, `backend`, and `source_revision`. References come from the committed
record. Store grants are `delivery:dispatch`, `delivery:request_stop`,
`delivery:observe_execution`, and `delivery:release`. Reservation retains
`delivery:acquire` and the applicable transition grants. Authority is checked
again inside the transaction, including receipt replay and observations that
return after an asynchronous lookup.

## Dispatch and recovery

| Operation | Durable behavior |
| --- | --- |
| `reserve` | Lease and `reserved` execution intent publish atomically; no backend call. |
| `dispatch` | Rechecks source, assigned owner, authorization, dependencies, and unexpired lease, commits `dispatching`, then calls `start` once. Replayed receipts, stale revisions, and uncertain commits never start another job. |
| `stop` | Commits `stop_requested` before calling idempotent backend `close`. A lost close acknowledgement can retry the same request. This alone does not release the lease. |
| `reconcile` | Queries backend `inspect`, then commits a matching observation under the current revision and lease. Running, unknown, or unavailable results retain ownership. |
| `release` | Uses the committed closed observation and required candidate handoff. It ignores caller-provided stop claims for journaled executions. |

An execution moves from reserved to dispatching, optionally running, then
stopped. A stop request can interrupt any nonterminal phase. Unknown observations
preserve the current phase; running observations never erase a stop request.
Stopped is terminal for that execution identity. A later acquisition gets a new
run, lease, and monotonic fence, while historical observations and handoffs remain
in the event log. Delivery state remains In progress until an evidence-backed
delivery transition is separately accepted.

When dispatch acknowledgement is lost, call reconcile, not dispatch with a new
key. A crash after the dispatch claim but before `start` deliberately leaves
uncertainty. Even a backend lookup finding no job is insufficient for release:
the original caller could still submit a delayed request. Close that identity,
observe its closed terminal state, and preserve the handoff before acquiring a
new execution.

## Required backend contract

The configured backend implements `start(ref)`, `close(ref)`, and `inspect(ref)`.
It derives the bounded job from trusted configuration and the immutable execution
reference. All operations are scoped to that exact identity.

- `start` accepts at most one job for an identity and rejects one already closed.
  It must fence candidate writes and completion against the execution identity.
- `close` durably prevents any future start for the identity, including requests
  still in flight, and requests termination of all accepted local/remote work.
  Repeated closure is safe, including when no job was ever accepted.
- `inspect` returns the reference plus `state` (`running`, `unknown`, or
  `stopped`), a safe evidence `reference`, and `closed`. Only `stopped` with
  `closed: true` permits release. That assertion means all accepted execution has
  stopped and the backend will permanently reject delayed starts for the identity.

A missing job, wrapper exit, PID absence, heartbeat loss, timeout, or lease expiry
cannot substitute for this assertion. Local process-group confirmation can use
`stopChild`; restart also needs persistent process identity and dispatch closure.
A remote backend must reconcile accepted jobs at the remote authority. Never
adapt a raw shell spawn or an unverified remote acknowledgement to `closed: true`.
Backend errors return generic holds; raw responses and credentials are not saved.

The read-only runtime projection exposes only `execution.phase`, alongside the
existing safe ownership fields. It does not expose backend names, execution
references, source revisions, or observations. Legacy actions remain held after
release because the task is still delivery-managed.

## Remaining integration

The local backend, its guardian for orphaned local writers, and the
[shared admission gate](delivery-admission.md) are implemented, including exact
dead-metadata-transaction recovery. The [trusted role/job adapter](delivery-authority.md)
now implements project-scoped role grants and registered local-job selection.
Remote backends, production credential/policy bindings, source fencing shared
with every writer, recovery after loss of all local controllers, remote orphan
reconciliation, and revision-checked task projection/migration remain required. Repository and
launch ownership still require external reconciliation. No active card, candidate,
or attempt history is migrated, reset, or rewritten by the coordinator.
