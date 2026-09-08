# Supervised budget repository transactions

`todomd budget-write` replaces the budget dispatcher's raw shell lock blocks with
one supervised local command. It acquires the legacy `.todomd/.lock` and shared
project admission in the same order as the board server, then retains both until
the entire command process group is confirmed closed. The helper creates private
admission history when needed, but never initializes delivery tasks or launches
the delivery workflow.

```text
todomd budget-write /absolute/repo -- /bin/sh /absolute/transaction.sh
todomd budget-write /absolute/repo --timeout-ms 60000 -- /absolute/executable arg1 arg2
```

This is a trusted local OS capability, not an HTTP endpoint or card-supplied job
profile. The executable must be absolute and executable; arguments are passed
directly without implicit shell interpolation. The command runs in the canonical
repository. The default deadline is 30 seconds, configurable from 50 milliseconds
to 60 seconds; process closure may take additional time. SIGINT/SIGTERM requests
stop and closure before returning. A hard kill leaves recovery evidence.

## Dispatcher use

Each **LOCK … UNLOCK** block is one script submitted to the helper. Prepare the
script outside the repository and begin it with `set -eu`. Select candidates
read-only beforehand, then re-read status, eligibility, leases, and coordination
inside the transaction before changing anything. Include the guarded edits and
their quick path-scoped Git commit in that same script. Do not write the shared
card before entering the helper or split a transaction across tool calls.

Do not nest `budget-write`, `fanout`, `advance`, or other todomd mutation commands
inside the transaction: they acquire the same locks in another process. Invoke
those helpers afterward. Commands must be bounded local work in their original
process group. Do not run agents, remote submissions, daemons, detached sessions,
or process-group escape operations inside a transaction.

Long interactive plan/build/verify work remains outside this helper. Referenced
agent commands should return proposed shared-card content, which the dispatcher
then applies through a transaction. Candidate worktree rules remain unchanged.
The generated dispatcher instructions use this protocol; existing installations
must update their dispatcher command through the normal command-upgrade flow.
Already-running sessions must stop and reload the updated instructions.

Before any command starts, the helper checks under admission for private delivery
task records/remnants, malformed cards, or cards declaring a non-legacy schema.
Such managed or mixed boards are refused as `delivery_managed`; a general shell
script cannot be constrained to one unmapped task. Use delivery owners and scoped
operations for those boards. Removing records to bypass the refusal is not recovery.

## Results and recovery

The CLI returns JSON with `ok`, a result code, the command's `exit_code` when known,
and a private `output_file`. Exit status is zero only for a confirmed successful
command. Output and partial repository changes are retained on command failure,
timeout, interruption, or uncertainty. Inspect them before retrying; the helper
does not roll back edits or infer that a commit/merge should be repeated.

Private `repository-writes/<execution-hash>/command.json` binds the execution
reference to the exact legacy-lock nonce. It stores no executable, arguments, or
environment. Backend output is private. The reference identifies this transaction;
its source field is an identity digest, not candidate or release evidence.

The admission owner records `local-repository-command-v1` and that binding. If
closure is uncertain, admission remains held even if the helper returns an error.
Inspect and recover using the existing local administrative procedure:

```text
todomd delivery-admission /absolute/repo --json
todomd delivery-admission /absolute/repo --recover --epoch N --nonce EXACT_NONCE --json
```

Recovery requires a dead owner on the same host/boot, a matching private command
receipt, and exact backend closure. It releases only the original legacy file-lock
nonce and the corresponding gate. A newer lock owner is never removed. Missing
receipts, corrupt state, or surviving writers without a usable controller hold
admission. Repeating completed recovery cannot retire a newer transaction.

## Remaining migration boundary

This fences updated, supervised shell transactions. It does not retroactively
fence old raw-lock scripts or long interactive budget sessions. Stop and reconcile
those sessions and all remote work before live migration. All writers must adopt
the protocol or be quiescent; delivery launch activation remains off until the
remaining provider, remote-writer, migration, and pilot gates pass.
