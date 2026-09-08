# Local delivery execution backend

`createLocalDeliveryBackend` in `src/delivery-local-backend.js` implements the
coordinator's `start`, `close`, and `inspect` contract for contained local process
groups on macOS and Linux. It can run real commands through a detached supervisor
and recover control after the board/launcher process exits. A second controller
inside each new process group closes orphaned work if the supervisor dies. It
is disabled by default and is not yet wired into live board admission or migration.

## Trusted configuration

The factory receives an untracked, server-owned private directory and options:
`enabled`, backend `name` (default `local`), `authorizeStart(ref)`, and
`resolveJob(ref)`. Admission must return exactly true before the local start claim and
again after asynchronous job resolution. The production adapter must derive it
from current ownership, source revision, policy, and a shared admission fence.
The existing legacy preflight check is not that fence.

Job resolution returns an absolute executable `command`, string `args`, absolute
`cwd`, optional string-valued `env`, and
`containment: 'local_process_group'`. These are trusted configuration, never raw
card text or HTTP arguments. This containment declaration is a requirement on the
job, not an operating-system sandbox: commands must keep all writers in their
inherited local process group. Jobs that launch detached writers, remote fleet
work, or other execution outside that group need a different backend. This
adapter does not turn wrapper exit into proof that remote work stopped.

`graceMs` defaults to one second; `closeTimeoutMs` defaults to ten seconds. The
supervisor sends TERM to its own group, then escalates to KILL if necessary.
Stop timeouts leave ownership held. Windows is explicitly unsupported.

## Durable identity and closure

Each exact execution reference hashes to a private directory. Files and logs use
mode 0600, directories 0700. The reference includes task, backend, lease, run,
fence, and source revision. Immutable files publish through an exclusive hard
link after file sync, followed by directory sync. No time-based lock stealing is
used by this backend.

- `start.json` admits one launcher. Duplicate calls cannot spawn again, including
  calls from other processes or after acknowledgement loss. A failed or abandoned
  claim can be closed without deleting it or resetting attempts.
- `closed.json` permanently prevents future execution for the identity. Closure
  publishes this barrier before looking for a supervisor. A cancelled identity is
  never reused; retrying work requires a newly admitted lease/run/fence.
- `no-job.json` records closure that observed no registration after publishing
  the barrier. This receipt remains terminal even if a delayed supervisor later
  registers, observes the barrier, and exits without starting its command.
- `supervisor.json` binds the reference to the local host/boot, process group,
  private control socket, and random control nonce. It has a corruption checksum
  and is never overwritten. Commands and environment variables are not stored in
  the registration; they travel over parent/child IPC.
- `guardian.json` binds a second private control socket and live group member to
  the exact supervisor checksum, group, host/boot, and execution reference. It
  must publish and acknowledge readiness before a new command can start.
- `output.log` retains command output privately. `result.json`, when available,
  records the direct command's exit outcome. Neither is delivery acceptance,
  review, or release evidence by itself.

The supervisor binds its control socket and durably registers **before** checking
the closure barrier or spawning a command. Consequently, closure either sees an
already registered group or wins the barrier before a delayed supervisor can
start. A start claim with no registration can safely close; elapsed time is not
used to reach that conclusion.

The supervisor remains group leader after the direct command exits, until all
contained job descendants stop. It excludes the guardian from this drain check
and tells it to finish only after the remaining writers are gone. It also excludes
its own process and the inspection process when checking remaining group members. Zombies cannot write and do not
keep execution active. Natural completion closes the identity before supervisor
exit. Closure requests can still stop a descendant whose command leader has
already exited.

## Recovery and evidence

Recovery sends only status/stop requests over private Unix sockets. Both
controllers require their own recorded random nonce. The supervisor signals its
own current group. The guardian verifies its current process-group membership
before becoming ready and never leaves that group, so its continued presence
prevents that group ID from being reused while it sends TERM and then KILL.
The backend itself **never signals a persisted PID or group ID**.

If the supervisor dies, its IPC channel disconnects and the guardian closes the
dispatch identity and stops the group. If the guardian dies, the supervisor does
the same. A frozen/unreachable supervisor can also be stopped through the
guardian's authenticated socket. Losing either controller interrupts the job;
it never restarts it or releases its lease automatically. The coordinator must
still commit exact stopped/closed evidence before releasing durable ownership.

A guardian with a corrupt registration or a different supervisor, execution,
host, or boot cannot authorize control or closure. Old executions without a
guardian retain the original supervisor-only recovery behavior; the upgrade
does not inject a new process into work already running.

`inspect` returns the execution reference, a safe local receipt reference,
`state`, and `closed`. Only a published closure barrier plus a no-job receipt
(or a confirmed absent group on the recorded host/boot) produces
`state: 'stopped', closed: true`. A closed marker while writers remain is
insufficient. Corrupt registration, unsupported host/boot, failed process
inspection, and surviving descendants keep ownership held. A process group that
outlives both controllers (or an older execution without a guardian) remains
held until its writers actually stop. This adapter does not guess which saved
PID is safe to kill. Reboot/host changes also require reconciliation before
reusing the private store.

Socket cleanup occurs only after confirmed group absence and only for the socket
inode recorded by that controller. The read-only board projection continues to
expose execution phase only; it does not publish nonces, sockets, PIDs, commands,
environment, or output logs.

## Verified boundary and next work

Tests run the complete store/coordinator/backend sequence through reservation,
dispatch, observation, stop and release. They also cover concurrent independent
launchers, launcher exit, natural completion, delayed supervisor arrival after
closure, background descendants, loss of either or both controllers, a frozen
supervisor, failed guardian registration before job start, wrong control
credentials, corrupt/foreign registration, abandoned claims, and preserved
candidate files. All commands and private state are isolated test fixtures.

The [shared admission gate](delivery-admission.md) now coordinates board writers,
scheduler starts, and metadata transactions, with supported recovery of exact dead
metadata owners. Live activation still requires server-owned job/role resolution,
source fencing shared with all legacy/remote writers, recovery when every local
controller is lost, remote orphan reconciliation, revision-checked
projection/migration, and the pilot gates in the [update plan](delivery-workflow-update-plan.md). Remote fleet execution needs
its own authoritative closure adapter. Existing cards remain on the legacy path.
