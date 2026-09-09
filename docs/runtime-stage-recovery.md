# Stage recovery and candidate identity

Build admission refreshes an existing candidate from its recorded local base
branch before opening an attempt or starting an agent. Source changes are merged;
board-only bookkeeping does not churn candidate identity. This does not fetch or
publish remote branches. An operator remains responsible for updating the local
base from its upstream.

Conflicts stop at `base_sync_conflict`. A dirty candidate needing a source refresh
stops at `base_sync_dirty`. Existing edits and commits remain preserved; the
runtime does not stash, reset, resolve conflicts, or discard work. Resolve and
commit the pending work or merge, then explicitly Return to Build. Refreshing
before Build cannot prevent the base advancing again during a long Build; final
publication guards still apply.

Re-queueing a Needs Human card with `recovery_stage: CI` or `Verify` resumes the
preserved candidate through the same-candidate CI/verification path. Persisted
Queue cards follow the same rule after restart. CI prerequisite failures and
failed same-candidate retries do not automatically manufacture another Build.
The separate Return to Build action explicitly authorizes candidate repair and
records any one-attempt budget extension. Ordinary re-queue never extends it.

Build, CI, and Verify refuse admission outside the approved positive integer
attempt limit. Historical over-limit values remain visible rather than being
silently clamped. Status queries and prerequisite retries do not increment the
candidate attempt count. Build continuation slices retain their separate time
and progress budgets.

## Optional remote status protocol

The legacy remote adapter contract remains supported: exit zero attests a clean,
unchanged candidate; exit one is a gate failure; exit two is an unresolved
prerequisite or interruption. A legacy adapter must reconcile its durable journal
before submitting on any explicit retry. Human-readable logs cannot reliably
distinguish the reasons for exit two.

A reviewed, committed CI configuration can add a **non-submitting** status
command:

```yaml
ci:
  execution: remote
  quick: node scripts/ci-adapter.mjs
  status_command: node scripts/ci-status.mjs
  poll_seconds: 5
```

Both commands receive `TODOMD_CI_HEAD`, `TODOMD_CI_RUN_ID`, and
`TODOMD_CI_MODE` (`submit` or `status`). Status mode must only discover or observe
the existing job for that candidate; it must never create, approve, cancel, or
resubmit a job. Each status query has a 30-second client timeout. Poll intervals
are bounded to one through 60 seconds.

An adapter may emit one line beginning `TODOMD_CI_STATUS ` followed by a JSON
object with these fields:

| Field | Meaning |
| --- | --- |
| `head` | Exact candidate Git commit supplied by the runtime. |
| `state` | `running`, `passed`, `failed`, `blocked`, or `unknown`. |
| `run_id` | Adapter job identifier; required for running and terminal jobs. |
| `reason` | For blocked jobs: `approval_required`, `approval_stale`, `admission_contention`, or `remote_state_unknown`. |

Status queries must exit zero to deliver a valid observation. Missing, duplicate,
malformed, different-candidate, or different-job observations cannot attest a
pass. The adapter must verify its backend receipt, source digest, and approval
before reporting terminal status; the runtime does not infer those from text.

After a client disconnect or timeout, the runtime invokes the status command
before choosing recovery. A running observation keeps the card in CI with its
flow ownership held, polls the same job, and never invokes submission again.
An uncertain status parks the candidate for reconciliation. Retrying a recorded
running/unknown job with this protocol starts with a status query, including
after restart. Without a status command, automatic remote reconciliation is
unavailable; the card explicitly reports `remote_state_unknown` and requires the
legacy adapter or an operator to reconcile it. It does not claim that the remote
job stopped.

The card persists `ci_remote` containing the state, sub-reason, run identifier,
candidate head, and observation time. Recovery hints distinguish approval,
changed approval, capacity contention, and unknown remote state. These fields
are runtime observations, not approvals or substitutes for the adapter journal.

## Coordinator instructions

Each Build prompt includes the authoritative board card at admission, excluding
its historical Run Log, so a stale worktree card cannot silently hide a current
coordinator note. The dedicated saved Build instruction is also included for
fresh and resumed agents. A note added after an agent has started is **not** a
live message to that agent. Stop/preserve the run and issue a new handoff when a
correction must affect ongoing work; do not assume editing the base card changes
an already-running conversation.
