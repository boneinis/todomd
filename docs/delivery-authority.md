# Trusted delivery roles and jobs

`createDeliveryAuthority` in `src/delivery-authority.js` connects authenticated
project identities, durable owner assignments, approved local and remote jobs, the admission
gate, and the execution coordinator. It is an internal adapter, disabled by
default. The [credential-bound recovery transport](delivery-access.md) enables
only inspection, stop, reconciliation, and release for existing executions.
No HTTP launch or migration entry point enables delivery work. Existing boards
continue to use the legacy runtime.

## Server configuration and authentication

The factory receives a canonical project path and server-owned options:

- `enabled`: explicit opt-in; disabled operations create no state.
- `authenticate()`: a synchronous, read-only transport capability returning
  `{ actor_id, project, operator? }`, or null. `project` must match the canonical
  project path. The transport must authenticate credentials, enforce expiry and
  revocation, and bind this callback to the individual request/session. Never
  populate it from request fields or a shared mutable current-user variable.
- `resolveAdmission(taskId, { backend, source_revision })`: synchronous,
  read-only authoritative evidence. It must return `job_approved: true`,
  `writers_fenced: true`, `busy: false`, and `dependencies_satisfied: true`.
  Missing, asynchronous, uncertain, or revoked evidence denies new execution.
- `jobs`: a server-approved map of named implementation-job definitions.
- `remoteJobs`, `remoteCredential`, and optional `remoteTimeoutMs`: the
  [registered remote worker and provider contract](delivery-remote-backend.md).
- Optional `now` clock and `localOptions` containing only stop deadlines.

Enabled construction durably registers approved job namespaces. It does not
initialize tasks, reserve leases, or launch jobs. A task must already have a
validated private delivery record; initialization/migration remains separate.

Authentication is checked again inside metadata transactions, on receipt replay,
after asynchronous observations, and before/after local job resolution. Grants
come from current private owner assignments, never card frontmatter or a caller's
`grants`, `actor_id`, executable, backend object, or job definition.

| Authenticated responsibility | Execution permissions |
| --- | --- |
| Implementation owner | Reserve, dispatch, renew, request stop, observe, release after confirmed closure. |
| Delivery lead | Request stop, observe, release after confirmed closure. |
| Assigned reviewer or release owner | Observe. |
| Explicit human operator capability | Request stop, observe, release after confirmed closure. |
| Unassigned or wrong-project identity | None. |

`operator: true` is an explicit capability from the server's authentication
layer. It applies only to human identities and does not grant dispatch or lease
renewal. This adapter does not authorize review, merge, deployment, reassignment,
or arbitrary metadata transitions.

## Approved jobs and durable recovery authority

A job has an absolute executable `command`, string-array `args`, absolute `cwd`,
and `containment: 'local_process_group'`. Paths are resolved at configuration
time; the executable must be executable and the working directory must exist.
Definitions are copied and frozen. Caller-provided environment overrides and
extra job fields are rejected. Provider credentials remain the responsibility of
the trusted host/provider adapter, not a task field.

An argument exactly equal to `{task_id}`, `{lease_id}`, `{run_id}`, `{fence}`,
`{backend}`, or `{source_revision}` receives that immutable execution-reference
value. Other arguments remain fixed. There is no interpolation of card text.
The registry is for approved implementation work; publication and independent
review jobs require their own policy and role adapters.

The canonical project, profile name, executable path, working directory, argument
template, and containment declaration determine a `local-job-<SHA-256>` backend
identity. This pins the job definition, not the bytes of an executable or the
candidate checkout. Changing the definition gives a different identity. Current
policy must still approve that exact identity through `job_approved` on each
admission check, so revocation also affects previously constructed adapters.

Immutable, checksummed `job-authorities/<backend>.json` registrations retain the
profile name, project binding, and local execution authority. Commands,
credentials, and environment values are not written to these records. Execution
state lives beneath `local-executions/<backend>/` in the same private project
store. These paths are derived by the adapter and never accepted from a request.

Removing a profile prevents its old reservation from dispatching through the
new configuration. Its registered namespace remains available for authenticated
stop, inspection, and release. Generic `local` and unregistered backend
identities are never guessed into this namespace. Corrupt registrations hold
recovery; they are not overwritten. Do not delete registrations during cleanup
or repoint their directories to another backend.

## Admission and commands

The adapter hashes the current raw card and checks it against the mapped
`source_revision` during reservation and dispatch, under the project admission
gate. A changed, malformed, mismatched, or archived card cannot launch. This is
the mapping's card digest, not Git candidate/release evidence. The trusted
admission callback must establish any further candidate and policy requirements.
The [writer preflight](delivery-writer-preflight.md) independently vetoes known
legacy/interactive/remote blockers during reservation and every dispatch/start
authorization. Callback facts cannot override it. A clear scan still needs
trusted writer fencing; recovery operations remain available when it blocks.

The launch gate remains held across asynchronous local authorization, job
resolution, and supervisor acknowledgement. Waiting writers cannot race that
start. Once acknowledged, the durable lease and backend closure protocol retain
ownership of the running execution. New local launch owners carry an exact
execution binding. The [local admission recovery adapter](delivery-admission.md)
can retire a dead owner's gate only after closing that registered execution;
metadata-only recovery cannot retire it. The task lease remains held afterward.

`reserve(taskId, command)` accepts `profile`, `run_id`, `ttl_ms`, optional `reason`,
`expected_revision`, and `idempotency_key`. The adapter derives backend and source
identity itself. `dispatch`, `stop`, `reconcile`, `release`, and `renew` accept the
exact committed execution reference and revision/key; release also requires a
handoff and renewal requires a TTL. Unexpected fields are rejected. Recovery
continues to require exact backend closure and a committed observation, even if
the card changed, the lease expired, or the job profile was removed.

## Remaining production integration

The [session adapter](delivery-access.md) now supplies project-scoped credentials
and current private job approval. Provider setup must distribute those credentials
and supply approved job definitions.
The admission callback must integrate every legacy, shell/budget, and remote
writer with authoritative source/stop checks; booleans copied from a request or
stale heartbeat do not meet this contract. Keep activation off until those
adapters, revision-checked projection/migration, recovery of unbound launch
owners, and the pilot gates pass. Registered supervised remote workers now have their own backend; existing fleet
controllers still require independent acceptance and closure integration.

Tests cover role/project isolation, command/permission injection rejection,
authentication and policy revocation, source drift, copied job definitions,
removed-profile recovery, unknown/corrupt authority, asynchronous observation
revocation, launch exclusion, expiry, and a real supervised job through fenced
release with unchanged task and candidate files. All writable fixtures are isolated.
