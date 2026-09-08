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

New launches through the trusted local authority also record
`launch_authority: registered-local-job-v1` and the exact task, lease, run, fence,
backend, and source reference. This server-owned binding means the entire launch
scope belongs to that one registered local job. It is not accepted from a recovery
request. Legacy scheduler launches and repository work have no such binding.

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
Execution leases and backend closure remain necessary for surviving work. The
[trusted role/job adapter](delivery-authority.md) additionally holds asynchronous
launch admission through local supervisor acknowledgement.

## Local operator commands

Inspect the current owner without making changes:

```sh
todomd delivery-admission /absolute/project/path --json
```

After inspecting its exact epoch and nonce, request recovery:

```sh
todomd delivery-admission /absolute/project/path --recover --epoch 7 --nonce EXACT_NONCE --json
```

Recovery requires the same host and boot and OS confirmation that the owner PID
no longer exists. A live or reused PID, permission error, foreign host/boot,
corrupted record, or mismatched nonce retains ownership. The
command requires local OS access to the private store; it is not a public HTTP
write endpoint. Board viewers continue to receive sanitized hold information.

- For a `metadata` owner, confirmed process absence permits completion of the
  synchronous transaction gate.
- For a bound local `launch` owner, the recovery adapter additionally verifies
  the original registered backend namespace and the matching dispatching journal.
  It closes that execution through the authenticated backend protocol, requires
  an exact stopped-and-permanently-closed observation, then rechecks the owner,
  process absence, registration, and task identity before publishing completion.
  Missing or corrupt authority, a different journal, or uncertain closure holds
  admission. No persisted PID is used to signal a job.

Local launch recovery may stop an orphaned job. Before-start crashes close the
dispatch identity against a late start even if no supervisor registered. Removing
a job profile or job-policy approval does not remove its registered recovery
authority. If the recovery process crashes before or after completion publication,
retry the same epoch/nonce; backend closure and gate completion are idempotent.

Successful recovery appends only the matching completion record. It preserves
task snapshots, leases (including expired leases), candidates, attempts, events,
and receipts. Inspect the committed task or retry the exact original command/key
to resolve an uncertain acknowledgement. Local launch recovery returns
`launch_gate_only`: the task lease and dispatch journal are still held. Use the
normal scoped [execution recovery](delivery-access.md) to stop/reconcile and
release that lease with its preserved-work handoff. Recovery never resubmits a job. Replaying
an old recovery cannot close a newer epoch, even with concurrent recovery callers.

## Remaining activation requirements

`repository` and unbound `launch` owners can leave child processes or accepted remote work
behind. PID absence is insufficient for them; the CLI returns
`external_reconciliation_required`. Their supported external reconciliation
adapter remains future work. The new binding does not retroactively make old
launch records recoverable. Loss of all local controllers with surviving writers
also remains held. Old per-card `.lock` remnants remain held for
quiesced operator reconciliation because they lack this ownership protocol.

The legacy shell/budget lock protocol does not yet participate in this gate.
Enabling a gate does not fence work that started beforehand, a direct shell writer,
or an accepted remote job. Initial activation/migration must establish quiescence
and integrate every writer and authoritative stop/source check. Production
provider credential/configuration integration, remote closure, projection/migration, and the pilot acceptance gates
remain required. Gate history retention is currently unbounded.

Tests cover independent recovery callers, stale recovery against a newer owner,
live ownership, shared scheduler/repository/metadata exclusion, revoked asynchronous
contexts, corruption, old lock remnants, and a real process crash immediately after
a lease snapshot was renamed. Local launch tests also cover a real authority
crash before backend start, a surviving supervised job after launcher death,
concurrent CLI recovery, unknown authority/observations, and recovery-process
crashes around completion publication. All write and recovery fixtures use isolated state.
