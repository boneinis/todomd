# Preparing delivery work in an authenticated session

The internal `createDeliverySession` now connects task preparation to the existing
local execution and recovery service. Callers no longer need to write the private
store directly to initialize a task, assign owners, establish Ready, or hand work
to a replacement. This is a phase 3 integration increment. Existing boards remain
on the legacy runtime; HTTP exposes recovery only and launch activation stays off.

## Session operations

Every mutation requires `expected_revision` and `idempotency_key`. Read the latest
revision after each operation. Only the fields below are accepted in addition to
those two common fields. Identities and grants come from the session credential.

| Method | Fields | Authority and behavior |
| --- | --- | --- |
| `initialize` | `task`, `source_revision` | An explicit human operator maps a valid version 2 Backlog task to the exact current Markdown SHA-256. No advanced-state migration. |
| `assign` | `role`, `owner`, `handoff` | The assigned delivery lead or human operator records a stable assignment and evidence/next action. Independent review remains required. |
| `block` | `blocker` | The lead/operator may name a responsible owner; other assigned roles may record their own blocker. |
| `resolve` | `handoff` | The blocker owner, delivery lead, or operator records the resolution and next action. |
| `transition` | `to`, optional `reason` | Lead/operator preparation and withdrawal; implementation owner may submit for review. Supported destinations: Backlog, Ready, In review, Cancelled. |
| `readTask` | Task ID only | Assigned owners, the current blocker owner, and operators can read delivery metadata, latest handoff, revision, source digest, and whether execution is held. No credentials or private execution journal. |

The existing `read` method still returns only execution identity and phase. Its
HTTP representation does not gain task handoffs or metadata. Preparation methods
have no HTTP, voice, or Board Agent routes in this increment.

Initialization imports only delivery/ownership/blocker intent. It does not edit
the tracked card, infer readiness from its legacy column, or claim that its
candidate was integrated or deployed. Scope drift holds subsequent preparation
and execution until a future revision-checked reconciliation adapter handles it.
Do not rewrite the private source digest to evade that hold.

## Trusted host configuration

Alongside `enabled`, the credential, and approved local jobs, the session accepts
a synchronous, read-only `resolveWorkflow(taskId, reference)` capability. The
reference identifies the action, requested destination, source revision, current
private revision, and authenticated actor. The resolver supplies:

- `writers_fenced: true` and `busy: false`, based on actual execution authority;
- `ready` facts required by the shared transition evaluator;
- a clean, preserved `candidate` commit for entry to In review.

The resolver runs under shared project admission. Its answers cannot be supplied
in request fields, card prose, or bearer credentials. Known legacy writers veto
its positive claims through writer preflight. Missing, asynchronous, uncertain,
or revoked authority denies preparation. A clear preflight alone never supplies
positive fencing. Authentication and the source digest are rechecked before the
transaction commits.

Execution still independently requires `resolveAdmission`, the implementation
owner's credential, an approved registered job, satisfied dependencies, and the
same source digest. Workflow permission does not grant dispatch. The local job
runs on its executing machine; normal repository CI remains its normal command.
No remote worker or separate CI service is required by this session integration.

## Local lifecycle and recovery

The supported internal sequence is initialization, owner assignment, Ready,
reservation, dispatch, exact execution reconciliation/closure, and release with
a handoff. In review requires preserved candidate evidence; process exit alone
cannot advance delivery state. Completion and release destinations remain
unavailable through preparation until their evidence adapters are integrated.

A lease, including an expired lease, blocks reassignment and metadata transitions.
After a fresh session reconciles and closes the exact run, release retains the
candidate and handoff. The lead can then assign a replacement. The former owner
loses dispatch authority, and the replacement receives a new run identity and a
higher fence. Task state and prior events survive the handoff.

Tests exercise that full sequence using actual supervised local processes and
fresh credential-bound sessions, without direct store initialization. They also
cover source changes, missing readiness, self-review, blocker ownership, stale
revisions, replay after revocation, and unchanged tracked card content. They do
not establish production provider configuration, external-writer quiescence,
or pilot readiness. Those remain explicit rollout gates in the
[delivery update plan](delivery-workflow-update-plan.md).
