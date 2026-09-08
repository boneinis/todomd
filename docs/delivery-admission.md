# Project admission and metadata recovery

The internal delivery store, board repository writes, and scheduler starts now
share a private project admission gate. Delivery activation remains off. Normal
projects without a gate retain existing behavior; inspection creates no state.

## Ownership protocol

The gate lives in `admission/` beneath the canonical project's private delivery
store. Each transaction exclusively publishes `<epoch>.owner.json`, containing
its kind (`metadata`, `repository`, or `launch`), task identity where applicable,
random nonce, PID, host, boot identity, and checksum. Completion exclusively
publishes `<epoch>.done.json`, bound to that exact owner's checksum. Publication
uses an exclusive hard link, file sync, and directory sync. Epoch numbers increase;
records are never replaced, removed, or reused. Corrupt or incomplete history holds
admission. Elapsed time never authorizes takeover.

Metadata transactions synchronously resolve trusted authority and commit the
snapshot, event, and retry receipt while holding admission. Their context resolver
must be read-only and synchronous: no child process, remote submission, or deferred
mutation may escape the transaction. Board writes hold admission across their
repository work. Synchronous metadata can borrow an enclosing repository owner.
Inherited asynchronous ownership is revoked when its scope ends.

Scheduler starts acquire admission and recheck delivery ownership immediately
before invoking the job. Busy projects stay queued without consuming capacity.
Local release triggers a rescan; releases by another process are picked up by the
normal scheduler tick. This gates a start, not the whole lifetime of an execution.
Execution leases and backend closure remain necessary for surviving work.

## Local operator commands

Inspect the current owner without making changes:

```sh
todomd delivery-admission /absolute/project/path --json
```

After inspecting its exact epoch and nonce, request recovery:

```sh
todomd delivery-admission /absolute/project/path --recover --epoch 7 --nonce EXACT_NONCE --json
```

Recovery succeeds only for a `metadata` owner on the same host and boot when the
OS confirms that its PID no longer exists. A live or reused PID, permission error,
foreign host/boot, corrupted record, or mismatched nonce retains ownership. The
command requires local OS access to the private store; it is not a public HTTP
write endpoint. Board viewers continue to receive sanitized hold information.

Successful recovery appends only the matching completion record. It preserves
task snapshots, leases (including expired leases), candidates, attempts, events,
and receipts. Inspect the committed task or retry the exact original command/key
to resolve an uncertain acknowledgement. Recovery never resubmits a job. Replaying
an old recovery cannot close a newer epoch, even with concurrent recovery callers.

## Remaining activation requirements

`repository` and `launch` owners can leave child processes or accepted remote work
behind. PID absence is insufficient for them; the CLI returns
`external_reconciliation_required`. Their supported external reconciliation
adapter remains future work. Old per-card `.lock` remnants also remain held for
quiesced operator reconciliation because they lack this ownership protocol.

The legacy shell/budget lock protocol does not yet participate in this gate.
Enabling a gate does not fence work that started beforehand, a direct shell writer,
or an accepted remote job. Initial activation/migration must establish quiescence
and integrate every writer and authoritative stop/source check. Production role/job
resolution, remote closure, projection/migration, and the pilot acceptance gates
remain required. Gate history retention is currently unbounded.

Tests cover independent recovery callers, stale recovery against a newer owner,
live ownership, shared scheduler/repository/metadata exclusion, revoked asynchronous
contexts, corruption, old lock remnants, and a real process crash immediately after
a lease snapshot was renamed. All write and recovery fixtures use isolated state.
