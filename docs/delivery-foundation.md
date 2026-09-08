# Delivery workflow foundation

This increment provides a versioned task schema, a pure transition evaluator,
and a read-only migration preview. It does not activate the delivery workflow.
Existing `status`, attempts, worktrees, journals, scheduler, and recovery rules
continue to control execution. Adding version 2 metadata does not enforce new
ownership or change the runtime's behavior.

## Preview a board

```sh
todomd delivery-preview /path/to/repo
todomd delivery-preview /path/to/repo --json
```

The repository defaults to the current directory. The CLI works offline without
initializing or registering the board, reading credentials, or starting a server.
Missing task directories return a nonzero exit code. There is no apply option.
Individual invalid cards remain visible in a successful report; consumers should
inspect each card's findings rather than treating exit code zero as approval.

An existing authenticated server also exposes
`GET /api/delivery/preview?project=<registered-project-name>` under its usual
board read permissions. Full and viewer access can read it; scoped Board Agent
credentials cannot use this raw endpoint. Other methods cannot apply a migration.
The existing board response remains unchanged.

The report includes per-file SHA-256 revisions, a combined scan revision,
schema findings, declared metadata, and proposed legacy mappings. It scans all
Markdown task files, including archived tasks needed to resolve dependencies.
Only YAML frontmatter in regular files is read; executable frontmatter engines
and task symlinks are rejected. No Git commands, writes, summaries, agent runs,
attempt resets, or network evidence lookups occur in the preview.

The scan is not atomic. Revisions describe the files observed during this scan;
any future migration must revalidate all source files under its mutation lock.

| Legacy status | Proposed delivery state |
| --- | --- |
| Review, Plan | Backlog |
| Planned, Queue | Ready, with readiness still unconfirmed |
| Build | In progress |
| CI, Verify | In review |
| Needs Human | Known publication holds map to In review; otherwise a known recovery stage supplies a hint, or the mapping stays unresolved |
| Done | Unresolved historical completion; deployment unknown |

All rows require review. Invalid schemas, ambiguous identities, missing or invalid
dependencies, and dependency cycles suppress the affected task's proposed state.
Suggestions are not admission decisions: dependent tasks still require dependency
satisfaction at execution time. Ownership and completion policy require explicit
mapping. Existing assignee/provider strings never grant authority. An authored
`released` state is reported only as a declaration; deployment remains unknown
until an authoritative integration can reconcile it.

## Version 2 task additions

Legacy files without `schema_version` are version 1 and remain unchanged.
Explicit version 1 is supported. Delivery fields require version 2; unknown
versions or unknown nested fields produce validation findings.

```yaml
schema_version: 2
delivery:
  state: in_review
  completion_policy: released
  target_environment: production
  cycle_id: cycle-0001
ownership:
  delivery_lead: agent-role:todomd-lead
  implementation: agent-role:todomd-maintainer
  reviewer: agent-role:todomd-reviewer
  release: human:project-owner
```

States are `backlog`, `ready`, `in_progress`, `in_review`, `ready_to_release`,
`released`, `completed`, and `cancelled`. Completion policy is `released` for
deployment-required work or `completed` for work requiring accepted results
without deployment. The latter cannot enter release states. Release-bound work
needs a target environment before Ready. Cycle membership is optional.

Owner IDs use `human:<id>` or `agent-role:<id>`, with a lowercase alphanumeric
first character followed by lowercase letters, digits, dots, underscores or
hyphens (at most 80 characters after the prefix). Ownership may be empty in
Backlog or Cancelled. Other states require a lead, implementation owner, and
distinct reviewer; release-bound work also requires a release owner. These are
identity references, not an implemented role registry or credential grant.

Optional `blocker` fields are `category`, `owner`, `since` (quoted ISO timestamp),
`evidence`, and `next_action`. Categories are dependency, environment, provider,
implementation, review, publication, and product_decision. A blocker retains
the delivery stage and prevents forward assessment. Terminal states cannot have
an unresolved blocker.

## Transition assessment contract

`src/delivery.js` exports `validateDeliveryTask`, `evaluateDeliveryTransition`,
and `deliveryActions`. The last two share one evaluator for action eligibility
and rejection explanations. They neither write state nor acquire a lock, lease,
or permission. The success result explicitly says `effect: assessment_only`.

| From | Possible destinations |
| --- | --- |
| Backlog | Ready, Cancelled |
| Ready | Backlog, In progress, Cancelled |
| In progress | In review, Backlog, Cancelled |
| In review | In progress, Ready to release, Completed, Backlog, Cancelled |
| Ready to release | Released, In progress, Cancelled |
| Released, Completed, Cancelled | Backlog |

Every assessment requires an expected revision matching the trusted context,
an authenticated actor with a `delivery:<destination>` grant, and explicit
confirmation that execution/admission does not currently own the task. Rework,
withdrawal, cancellation, and reopening require a reason. Withdrawal can resolve
a blocked state; the assessment never deletes the existing blocker or candidate.

Additional entry requirements:

- Ready: scope, criteria, validation plan, target, valid dependencies, and planning approval.
- In progress: authorized admission for the assigned implementation owner and satisfied dependencies.
- In review: a clean, preserved candidate commit.
- Ready to release: passing checks and independent assigned review bound to the current candidate and policy, plus confirmed integration into the intended branch.
- Completed: candidate checks and independent review plus acceptance under the non-deployment policy.
- Released: the same review/integration evidence and a verified deployment of the integrated commit to the required environment, with no rollback.

Trusted context carries the revision, actor/grants, busy state, and reconciled
facts. Evidence references must identify the current candidate/policy; review
must use a distinct owner and run. Integration explicitly relates candidate and
merged commits, allowing a reconciled squash merge. Merge alone cannot satisfy
Released. Tests in `test/delivery.test.js` provide complete context examples.

No HTTP or CLI endpoint accepts a user-supplied transition context. A future
mutation adapter must authenticate the actor, resolve real grants and evidence,
enforce atomic revision checks and idempotency, acquire durable ownership, and
record events before these assessments can authorize live changes.

## Remaining rollout work

The [update plan](delivery-workflow-update-plan.md) remains the rollout authority.
Durable mutations and ownership leases, role/cycle management, UI integration,
external evidence reconciliation, apply/rollback migration, and the two-cycle
pilot are not implemented in this increment. There is no activation flag yet;
`execution_enabled: false` describes the preview's fixed capability.
