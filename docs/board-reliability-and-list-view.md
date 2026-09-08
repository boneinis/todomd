# Board reliability and list view

This change addresses TASK-0047, TASK-0048, TASK-0050, TASK-0051,
TASK-0054, and the combined TASK-0046/TASK-0052 list view.

## Run and CI outcomes

A provider reporting zero turns and no text or structured response is an
`empty_run`, even if it reports success. Permission denials retain their more
specific reason. Gemini's reported turn count is preserved; missing turn
metrics remain unknown rather than becoming zero. This does not complete the
separate token-usage accounting work in TASK-0055.

Before invoking a local or remote CI adapter, TODOMD resolves the candidate's
base revision and checks for a nonempty file diff. Empty candidates stop in
Needs Human with `nothing_to_test`, no CI evidence, and no automatic repair
loop. Documentation changes still reach the configured adapter normally.
Explicit Return to Build and Retry Verification remain available for recovery.
The external 4Upfit adapter is unchanged; the invariant is enforced at the
shared TODOMD admission boundary.

## Plan and Triage admission

Plan and Triage now use the same scheduler and resource governor as the other
stages. Each defaults to a machine-wide column cap of one. Set positive
integers in `scheduler.columns.Plan` and `scheduler.columns.Triage` to configure
caps; the strictest registered project's cap wins. Existing per-project
concurrency and global limits also apply. Queued work reports resource
deferral and can be cancelled immediately, including while pressure remains.
Budget-mode dispatch remains externally driven.

## Verification

The normal Verify prompt explicitly permits read-only file and diff inspection
through shell tools, while forbidding project execution and Git mutations.
The separate tool-less review mode continues to forbid local commands.
Review infrastructure errors preserve the candidate without requeuing Build;
a fail verdict with no findings, unmet criterion, or question is `bad_verdict`.
Provider CLI permissions remain configured independently of the prompt.

## Commit recovery

Progress snapshots use `git --no-optional-locks` for all inspection, so they
cannot refresh the index while an agent commits. A reported index-lock failure
triggers at most five commit attempts, spaced 250 milliseconds apart, against
only the existing staged changes. TODOMD does not stage additional paths,
remove index locks, or repeat non-lock commit failures.

If a commit cannot finish, the candidate and its staged path list are preserved
with `build_commit_pending`. Resume Build retries that commit without launching
another implementation agent, then runs ordinary CI and Verify. Cancellation
is checked between attempts. A real Git commit remains subject to repository
hooks and Git policy.

## List view

The toolbar switches between board and list, remembering the choice locally.
The list groups cards in this order: Needs attention, Queued, In progress,
Deferred, Done. Within a group, critical precedes high, medium, and low priority;
ID breaks ties. Review, Planned, and Needs Human require attention; Plan and
Queue are queued; Build, CI, and Verify are in progress. Dependency blocking or
archiving puts an unfinished card in Deferred; Done stays Done.

Epics start collapsed, show completed/total children, and expand children in
dependency order using the existing hierarchy helper. A child remains visible
when its parent is filtered out. Standalone and malformed cards remain
accessible. Row buttons open the existing drawer; expansion has keyboard focus
and state. List rows do not expose drag-and-drop moves.
