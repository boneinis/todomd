# Delivery credentials, job policy, and recovery transport

The local administrative CLI now provisions credentials for a stable owner in
one canonical project. `createDeliverySession` binds a credential to an individual
request and feeds fresh authentication and job-policy reads into the authority
adapter. The server exposes loopback recovery for already mapped tasks and
registered local executions. No HTTP route reserves or launches delivery work,
and existing boards are not migrated or activated.

## Local administration

These commands require the trusted host's filesystem authority. They are not
available through HTTP, the Board Agent, or card text. Use the absolute repository
path; aliases resolve to the same project. All responses are JSON.

```text
todomd delivery-access <repo> status
todomd delivery-access <repo> issue --revision N --owner agent-role:builder --ttl-ms 3600000
todomd delivery-access <repo> issue --revision N --owner human:operator --ttl-ms 3600000 --operator
todomd delivery-access <repo> revoke --revision N --credential-id ID
todomd delivery-access <repo> jobs --revision N --backend local-job-<SHA-256>
todomd delivery-access <repo> jobs --revision N
```

Read status to obtain the current revision before an administrative change.
Concurrent changes use exclusive revision publication; a stale revision fails
without overwriting another administrator's update. Duplicate or unknown flags
are rejected. The final example removes all job approvals. Listing status is
read-only and creates no private state on an ordinary project.

Issue returns a random 256-bit bearer credential exactly once. Deliver it through
the trusted provider/session setup, keep it out of card text, source files, URLs,
and logs, and do not grant one stable role's credential to a different role.
The private store retains only its hash and credential ID. Status lists IDs,
owners, expiry, and revocation without hashes or bearer values. A credential
lasts between one second and seven days. Reissue at expiry; old credentials are
never silently renewed. If an issue response is lost, inspect status and revoke
the newly issued ID before issuing a replacement.

`--operator` is accepted only for a human identity. It grants recovery authority,
not implementation dispatch or renewal. Other permissions still derive from the
task's durable owner assignments. The primary, mobile, viewer, and Board Agent
tokens are not delivery identities and cannot substitute for this credential.

## Durable policy and revocation

Private `access/<revision>.json` snapshots live in the canonical delivery store.
They retain credential hashes, expiry/revocation, exact approved backend IDs, and
administrative operation history. Snapshots are immutable, checksummed, chained,
and published with an exclusive hard link and fsync. Files are created with mode
0600 in a private directory. Corrupt, incomplete, or symlinked snapshots fail
closed. Authentication and policy are re-read on each check; existing sessions
do not cache grants. A backwards clock denies authentication and policy until
the host clock catches up with the latest administrative event.

Access writes use a separate revision history from execution admission. An
abandoned launch gate therefore cannot block revocation. Access changes neither
release a lease nor stop a process. Use the execution's recovery authority to
confirm closure. History retention is currently unbounded: do not delete,
truncate, or roll back access snapshots, which could undo revocation. Trusted
host storage and administrative file access remain the security boundary.

The job policy is an allowlist of exact registered job-definition identities,
not executable strings or profile labels from a request. The server still
supplies the job definitions. Admission requires both current private approval
and the trusted adapter's current job/writer/dependency evidence. Removing an
approval blocks reservation/dispatch even in an existing session. It leaves
authenticated stop, inspection, and release available in the original registered
backend namespace. Approval alone does not establish writer quiescence or enable
an HTTP launch route.

## HTTP recovery

Use the dedicated `x-todomd-delivery-token` header. Query-string credentials,
duplicate credential headers, foreign origins, and non-loopback connections are
rejected. Responses set `Cache-Control: no-store`. A delivery credential grants
no access to legacy APIs or WebSocket streams.

| Route | Behavior |
| --- | --- |
| `GET /api/delivery/executions/<task-id>?project=<name>` | Return the current revision and execution reference/phase to an assigned owner or human operator. |
| `POST /api/delivery/executions/<task-id>/stop?project=<name>` | Request exact backend closure. |
| `POST /api/delivery/executions/<task-id>/reconcile?project=<name>` | Commit an authoritative backend observation after rechecking current credentials. |
| `POST /api/delivery/executions/<task-id>/release?project=<name>` | Release ownership only after confirmed closure, with a preserved-work handoff. |

POST requests require JSON and the coordinator's exact execution reference,
`expected_revision`, and `idempotency_key`; release additionally requires
`handoff: { evidence, next_action }`. Re-read the revision after each successful
operation. Unknown fields, including caller grants, commands, or identities, are
rejected. The GET response omits private receipts, backend evidence, and handoffs.
Store/authority conflicts return 409 and retain ownership.

Credential checks repeat after reading request bodies and after asynchronous
observations. Concurrent requests each retain their own credential. Revocation
does not retroactively cancel an already accepted stop; it prevents later
authorized transactions. Missing or corrupt credentials never fall back to a
board-wide token.

## Remaining activation work

Provider session setup still needs to distribute these scoped credentials and
select approved job configurations. Shared admission for every shell/budget and
remote writer, recovery of abandoned launch owners and lost controllers,
revision-checked projection/migration, and pilot acceptance remain required.
No credential or policy is provisioned automatically during deployment.
