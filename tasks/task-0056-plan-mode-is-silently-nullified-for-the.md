---
id: task-0056
title: Plan mode is silently nullified for the gemini provider
status: Review
type: bug
priority: medium
labels: []
dependencies: []
created_date: 2026-09-08
source: ui
assignee:
agent:
build_profile: standard
session_id:
worktree:
verification: { attempts: 0, max_attempts: 3, last_verdict: }
triaged:
---

## Description

The runner picks the provider's execution mode by stage: edit-accepting for
Build, plan mode for every read-only stage. It also disables slash-command
expansion on every invocation. Those two flags conflict, and the CLI says so:

```
warning: --mode plan has no effect while slash command expansion is disabled.
```

So a review or planning run on this provider does not get plan mode. It runs in
the default mode instead. The warning goes to stderr and nothing surfaces it, so
the board records a normal run and an operator has no way to know the confinement
they configured was not applied.

Edit-accepting mode is unaffected, confirmed by invoking the CLI both ways, so
Build is not impacted. The exposure is any read-only stage routed to this
provider, where plan mode is precisely the thing keeping it read-only.

Decide which flag matters more per stage rather than passing both and letting the
CLI drop one. If slash-command expansion must stay off, plan mode has to be
achieved another way and the stage's read-only guarantee re-established. Either
way the warning must not be swallowed.

## Acceptance Criteria

- [ ] A read-only stage on this provider actually runs in the mode the stage configured
- [ ] The two flags are never passed together in a combination the CLI rejects or ignores
- [ ] A provider warning on stderr is surfaced in the run log rather than discarded
- [ ] The stage's read-only guarantee is demonstrated, not assumed from the flag
- [ ] Coverage asserts the invocation for each stage kind

## Verification

Unit coverage of the argument construction per stage, plus an assertion that the
CLI emits no mode warning for any combination the runner produces.
