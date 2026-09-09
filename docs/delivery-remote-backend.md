# Remote delivery execution protocol

The opt-in remote worker and client implement the coordinator's `start`, `close`,
and `inspect` contract over authenticated HTTP. Jobs run under the existing
POSIX supervisor and guardian on the worker host. The coordinator retains its
lease through connection failures and releases only after it commits an exact,
authoritative stopped-and-closed observation.

These are internal modules. The trusted role/job adapter now registers remote
profiles and recovers them through a host-supplied credential capability. The board
server mounts no worker route, and no CLI enables remote delivery launches. Deployment does not provision workers or credentials, migrate fleet
jobs, change board policy, or activate the delivery workflow.

## Worker provisioning and identity

A trusted host administrator calls `provisionRemoteDeliveryWorker(directory,
{ projectId, job })` once on an empty private directory. `projectId` is a shared,
64-character SHA-256 project identity supplied by trusted setup; different host
checkout paths must not silently become different project identities.

The job has an absolute executable, string-array arguments, an absolute working
directory, and `containment: 'local_process_group'`. Definitions are canonicalized
and copied. Extra fields and environment overrides are rejected. Arguments exactly
matching an execution-reference placeholder receive that value as one argument;
card text is never interpolated into a command.

Provisioning creates an immutable checksummed `authority.json` with a random
worker authority ID, project ID, job digest, and derived `remote-job-<SHA-256>`
namespace. It stores no executable text, arguments, or credentials. The returned
identity must reach the coordinator through trusted deployment configuration.
Provisioning an occupied directory fails. Handler startup never recreates a
missing authority. A replacement worker gets a different identity, which old
clients reject rather than interpreting an empty replacement as closed work.

Treat the authority and `executions/` history as one durable store. Preserve it
across restarts and configuration removal. Never delete execution records, copy
an authority onto an empty store, restore a partial snapshot, or reuse a retired
namespace: missing history cannot prove that accepted writers stopped. Trusted
host storage remains part of the authority boundary.

## Dedicated worker handler

`createRemoteDeliveryWorker(directory, { enabled, expectedAuthority, job,
authenticate, authorizeStart, localOptions })` returns a request handler for a
separately configured service. It does not open a port. `enabled` defaults off.
The administrator must pin the expected provisioned authority ID. A changed job
definition is refused. Omitting the job provides close/inspect-only recovery
within its original namespace.

`authenticate(credential)` is a synchronous host capability that must enforce
credential scope, expiry, and revocation. Use strong dedicated worker credentials;
board/viewer/delivery-owner tokens are not automatically worker credentials.
`authorizeStart(ref, credential)` must freshly establish source, assignment,
candidate, and writer-fencing policy for that exact reference and request-bound
credential. Do not keep a shared mutable current principal. Credentials permitted
to recover work must not inherit implementation-start permission. Missing policy denies starts.
The worker rechecks authentication and authority around asynchronous policy and
backend operations. An authentication function returning a Promise is rejected.

The only route is `POST /v1/delivery/execution`, with JSON content type and one
`x-todomd-worker-token` header. It requires TLS for non-loopback peers. Origin
headers, duplicate credentials, extra request fields, wrong project/authority,
and command/path/grant injection are rejected. Request bodies and read time are
bounded. Configure the dedicated listener's normal connection limits in deployment.

Requests contain protocol version 1, pinned authority/project IDs, action, and
the exact execution reference. Only the configured namespace is accepted. Replies
contain that same envelope and a bounded result; private local process identities,
commands, output, and backend receipts never leave the worker response.

## Coordinator client

`createRemoteDeliveryBackend(directory, { enabled, name, authorityId, projectId,
endpoint, credential, timeoutMs })` returns a coordinator backend. The endpoint
must use HTTPS, except literal loopback IPs for local operation/tests, and the
exact worker route without userinfo, query, or fragment. Redirects are rejected.
`credential(action, execution)` supplies the current transport credential at each operation;
credential distribution and renewal belong to trusted provider setup.

Enabled construction durably pins the exact endpoint, namespace, authority, and
project in the client's private directory. Conflicting configuration or corrupt
pins fail closed; no automatic rebinding occurs. Disabled construction sends no
requests and creates no state. The default request deadline is 15 seconds,
configurable from 50 milliseconds to 60 seconds, including response-body reads.

The client validates response shape, version, identity, action, and exact
reference. Only `stopped` with `closed: true` is terminal evidence. Network errors,
redirects, malformed/oversized replies, unavailable workers, and identity mismatch
return a generic uncertainty error. No raw responses or credentials are persisted.
The coordinator must recheck actor permissions when committing an observation.

## Closure and recovery

Worker closure publishes the durable local backend barrier before lookup and
waits for its process group to stop. A delayed start for that identity is then
permanently rejected, including when closure arrived before submission. Closing
again is safe. A lost close acknowledgement can be reconciled by inspection.
A lost start acknowledgement must not cause a new submission identity.

A client timeout or worker-service crash does not cancel accepted work. The
supervisor and guardian retain the job; restarting the handler against the same
store can inspect and close it. If the local backend cannot establish closure,
the remote response cannot establish it either. Controller loss, host/boot
mismatch, storage damage, or remote unavailability retain ownership until the
appropriate authority reconciles the execution.

This contract covers supervised POSIX work on the worker host. Jobs must not
escape the process group, daemonize, or submit independently surviving jobs to
another service. Existing fleet CI submit/wait wrappers require their controller's
own acceptance and closure protocol; wrapper exit is not remote-job closure.
Stopped-and-closed also does not establish successful CI, review, integration,
or deployment; those require their separate evidence policies.

## Trusted registration and credential lookup

`createDeliveryAuthority` and `createDeliverySession` accept `remoteJobs`, a map
of profile names to exactly these non-secret fields:

```js
{
  backend,        // provisioned remote-job-<SHA-256> namespace
  authority_id,   // provisioned worker UUID
  project_id,     // shared project SHA-256 identity
  job_digest,     // provisioned fixed job digest
  endpoint,       // exact HTTPS worker route; literal loopback HTTP for tests
  credential_key // trusted provider selector, never a credential value
}
```

Trusted setup maps the shared project identity to the canonical coordinator
repository. The backend must match the digest of the provisioned worker identity,
project, and job. Profile names cannot collide with local jobs or alias a worker
namespace. Enabled construction publishes an immutable checksummed registration
under `remote-authorities/<backend>.json`; transport pins remain under
`remote-pins/`. Registrations bind the canonical repository, profile, worker,
endpoint, and credential selector. Repointing an existing namespace, copying its
registration to another repository, or corrupting its receipt denies access.
Configuration is copied; later mutation does not change an existing adapter.

`remoteCredential(request)` is a synchronous trusted-host capability. It receives
an immutable object containing `repository`, the registered `profile` and six
fields above, the operation `action`, and the immutable exact `execution`.
It must return a fresh, appropriately scoped worker credential, or null. It can
select separate implementation and recovery credentials by action. Enforce the
full repository/worker/project/selector binding; do not resolve only a convenient
profile label or use a shared mutable current principal. Returning a Promise or
an unavailable credential fails closed. Tokens are never persisted in registration,
request bodies, task records, or recovery responses. Credential rotation changes
the provider's returned token, not the registered selector or worker identity.

Sessions require the private access allowlist to approve the exact
`remote-job-<SHA-256>` backend. The authority applies the same current owner,
lease, card-source, dependency and writer-preflight checks as local execution.
It holds project admission through the network acknowledgement, and rechecks
launch authority after credential lookup immediately before sending. The worker
must independently enforce fresh start policy at acceptance, including after
network delay. Coordinator permission alone cannot authorize the worker.

Removing a profile or revoking its launch approval prevents new dispatch through
that configuration. The original registration remains available for close and
inspect with a recovery credential. `startServer({ deliveryRemoteCredential })`
passes only this trusted capability to its existing owner-authenticated loopback
recovery routes. No request can supply a profile, endpoint, token selector, or
worker credential. The default CLI server supplies no provider capability and
therefore cannot contact remote workers. Private configuration and credential
distribution still require the deployment's provider setup.

## Abandoned remote launch admission

Remote launch owners record `registered-remote-job-v1` and the exact execution.
`recoverProjectAdmission(repo, { epoch, nonce }, { remoteCredential, remoteTimeoutMs })`
requires a verified dead launcher on the same host/boot, the matching dispatching
journal, and the original registered worker. It closes and inspects that exact
remote execution, then rechecks identity before completing only the launch gate.
The task lease, journal, card, and candidate remain intact for normal owner
reconciliation and handoff. A local-only recovery callback cannot retire a remote
gate. Missing credentials, worker unavailability, wrong registration, or uncertain
closure retain admission. The unconfigured administrative CLI has no remote
credential provider, so it retains remote gates; use the trusted host adapter.

## Remaining integration

Production credential distribution, provider and candidate policy, source fencing
on every participating host, existing fleet-controller integration, and
revision-checked migration remain required before activation. The preflight's
remote-work holds remain enforced. No public launch operation or automatic
migration is introduced by this integration.

Tests exercise actual HTTP calls, supervised processes, a killed and restarted
worker service, idempotent starts, closure before delayed start, lost start/close
acknowledgements, timeouts, revoked credentials, removed profiles, identity/root
replacement, malformed responses, and coordinator lease release after closure.
Registration tests cover scoped policy, source drift, rebinding rejection, owner
revocation during an observation, and launcher crashes before send and after
worker acceptance. The installed-package smoke checks registered remote recovery
and its delayed-start barrier.
