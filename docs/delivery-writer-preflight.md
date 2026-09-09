# Delivery writer preflight

`todomd delivery-writers [repo] [--json]` reports known legacy-writer blockers
without changing cards, private state, locks, processes, or configuration. It
performs local reads and a bounded read of committed Git configuration. It does
not contact providers, inspect credentials or execution output, or stop jobs.

The command exits 2 when blockers exist, 0 when no known blocker was found, and
1 for invalid command options. Exit 0 is **not** proof of quiescence. Every report
sets `writers_fenced: false` and `execution_enabled: false`. Its revision hashes
observed inputs; the scan is not an atomic snapshot or a reusable approval.

## Checked boundaries

| Observation | Result |
| --- | --- |
| Working or committed configuration selects budget mode | Interactive sessions require reconciliation outside the transaction helper. |
| Either configuration selects remote CI, or any card retains `ci_execution: remote` | A remote authority must reconcile accepted submissions and permanent closure. |
| A legacy task is queued or active | Reconcile existing work before delivery admission. |
| A task retains a dispatcher lease | Hold regardless of timestamp, archive status, or Done status. |
| Coordination claims or unrecognized manifest content remain | Inspect and reconcile the manifest. |
| A file lock or admission owner is present | Inspect the owner and use its supported recovery path. |
| The run mirror records an execution for the canonical project | Hold even if its recorded PID no longer exists. |
| A run's registry name is missing, duplicated, or points to an unavailable path | Hold because its project scope cannot be established. |
| Required data is malformed, unreadable, oversized, symlinked, or not a regular file | Hold instead of substituting an empty record. |

Registry names resolve to canonical paths. A uniquely identified run for another
repository does not block this one. Reports contain fixed explanations and
validated task IDs, never private run/session IDs, commands, PIDs, credentials,
or provider output. Task frontmatter is YAML data; executable language tags are
rejected. Archived tasks are included because archiving does not close a job.

## Admission and recovery

The trusted delivery authority reruns this check inside admission during
reservation and dispatch, including local backend start authorization. Positive
callback facts cannot override a known blocker. A clear scan still requires
trusted fencing, job approval, dependency, source, and role checks.
There is no callback option to disable the preflight.

Inside its own live admission scope, the check recognizes that gate and permits
modern board writers to wait with a file lock. They cannot write until admission
is released. Raw scripts outside the protocol still require independent fencing;
the file lock cannot establish that.

Stop, inspect, reconcile, release, and lease renewal retain their authorization
rules. Preflight never blocks recovery or clears an existing lease. A blocker
that appears after reservation prevents dispatch while preserving the execution
for normal stop/reconcile/release.

## Remaining migration boundary

The legacy run mirror is best effort. Missing or empty records cannot prove
that an old interactive session, another host, or a remote submission stopped.
Successful CI evidence cannot prove permanent rejection of delayed submissions.
Do not remove leases, change configuration, clear mirrors, or erase remote
markers merely to obtain an empty report.

Provider-specific submission identity, remote stop/closure authority, old-session
reconciliation, revision-checked migration, and the pilot remain required. This
increment makes known blockers enforceable and visible; it does not activate
execution or complete phase 3.
