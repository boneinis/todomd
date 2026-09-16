# Production readiness fix plan

Date: 2026-09-12
Status: Implementation complete; independent review corrections and release validation are documented in [the release review](production-readiness-release-review.md).

## Scope and review baseline

Address the independent review of `e99d60b..58ac7b3` on
`codex/delivery-workflow-completion`. This document supplements
[the delivery workflow update plan](delivery-workflow-update-plan.md).

Implement in `/Users/irvinbowman/web dev/TODOMD-worktrees/delivery-workflow-completion`.
Do not modify or push the main worktree at
`/Users/irvinbowman/web dev/TODOMD-worktrees/main`. Leave the disabled intent bus
and co-hosted projects untouched. Use temporary repositories for regression tests.

## Findings to resolve

| Priority | Finding | Observed behavior | Status |
| --- | --- | --- | --- |
| P1 | Chunk-mode queue admission ignores explicit splitting | With `workflow: teamwork` and `epic_build_mode: chunks`, approving an epic and kicking the queue can put both the parent and a child in Build. | Resolved |
| P2 | Pinned configuration is used only in part of the pipeline | Build uses the pinned base configuration, but CI and Verify reload root HEAD configuration. A differing peer-branch CI command causes `ci_blocked`. | Resolved |
| P2 | Unified epic mode is not wired through planning and runners | `epic_build_mode: teamwork` alone can still generate child cards and run without teamwork flags or prompts. | Resolved |
| P2 | Hidden drawer state overrides workflow selection | Ordinary cards default the hidden epic-mode selector to `chunks`; saving a Teamwork workflow also submits that unintended split override. | Resolved |

## Implementation sequence

### 1. Resolve build mode consistently

- [x] Introduce a shared mode resolver used by planning, approval, queue admission,
  queue sweeps, boot recovery, and stage configuration (`src/build-mode.js`).
- [x] Define explicit `epic_build_mode` as authoritative; document and test legacy
  `epic_split`, `teamwork`, workflow, and stage-default precedence.
- [x] Keep decomposition (one epic versus child cards) distinct from provider
  delegation settings. A split epic must remain a tracker even if agents use teamwork.
- [x] Prevent unified parent execution while children are active. Define an explicit,
  reviewable conversion path for epics that already have materialized children (`pipeline.convertEpicMode`).
- [x] Ensure repeated approval, queue kicks, and restart recovery remain idempotent.

Primary areas: `src/pipeline.js`, `src/build-mode.js`, `src/chunks.js`, `src/board.js`.

### 2. Complete teamwork planning and runner integration

- [x] Make `epic_build_mode: teamwork` alone produce a unified implementation plan
  and enable the intended provider teamwork settings.
- [x] Update the planning template to recognize the canonical mode and legacy aliases.
- [x] Keep Plan and Verify orchestration instructions read-only and stage appropriate.
- [x] Cover Claude, Codex, and Gemini arguments, environment, and prompt construction.
- [x] Verify actual delegation separately from fake-CLI argument tests.

Primary areas: `src/pipeline.js`, `src/templates.js`, `src/runner.js`.

### 3. Preserve target-base policy through the execution lifecycle

- [x] Resolve and persist the target base before creating a new candidate worktree.
- [x] Audit every card-scoped `execConfig` call. Use the same target base for Build,
  CI admission, Verify, retry, continuation, escalation, and recovery where applicable.
- [x] Reject an invalid explicit target base rather than silently trusting peer HEAD.
- [x] Define safe behavior when the target exists but has no committed board config;
  do not import executable policy from an unrelated peer branch.
- [x] Continue detecting real policy changes on the intended base and invalidating
  stale CI evidence when appropriate.
- [x] Preserve candidate worktrees and the existing wrong-branch merge guard.

Primary areas: `src/git.js`, `src/pipeline.js`.

### 4. Correct routing persistence

- [x] Omit hidden epic-mode values when saving ordinary cards.
- [x] Ensure choosing Teamwork, saving, and reopening retains the intended settings.
- [x] Preserve deliberate sequential-chunk choices on epics.
- [x] Inspect existing inconsistent cards and report repair candidates. Do not infer
  that every stored `chunks` value was accidental or silently rewrite user choices.

Primary areas: `public/app.js`, `public/board-agent.js`, `src/server.js`, `src/board.js`.

### 5. Add regression tests and resolve intermittent failures

- [x] Reproduce parent/child double admission with explicit chunk mode and teamwork.
- [x] Cover queue kick, repeated approval, resume, and boot recovery.
- [x] Cover mode-only teamwork planning and provider invocation.
- [x] Cover pinned-base and peer configurations that differ in CI command and routing,
  including verification retries and preserved-candidate recovery.
- [x] Cover invalid bases, missing target config, and real target-policy changes.
- [x] Add browser coverage for ordinary-card workflow changes and epic-mode persistence.
- [x] Investigate the cross-vendor missing-session retry failure and Board Agent UI
  assertion failure observed in the full suites; passing reruns are not a root cause.

## Validation and release gates

Run focused regression tests first, then:

```sh
node --test test/*.test.js
node --test --test-concurrency=1 test/ui/*.test.js
```

- [x] Both complete suites pass with no unexplained failures or unexpected skips.
- [x] Delivery credential scope and evidence-gate checks pass.
- [x] Release path traversal and directory/file symlink rejection checks pass.
- [x] Rollback history preservation and active-owner protection checks pass.
- [x] Isolated installation and rollback preserve state across installations.
- [x] Disposable-repository smoke tests demonstrate actual delegation for each
  supported teamwork provider without weakening stage restrictions.
- [x] Main worktree integrity and co-hosted project isolation remain intact.
- [x] Prepare the exact release artifact, validation evidence, and rollback procedure
  for review before a production rollout.

Before any typecheck, check for an existing run and reuse or wait for it. The reviewed
JavaScript repository has no typecheck script; do not introduce an unrelated full
TypeScript check solely for this work.

## Audit evidence before fixes

| Check | Result | Duration |
| --- | --- | --- |
| Full unit suite | 1,023 passed; 1 failed | 128.98 s |
| Full UI suite | 42 passed; 1 failed | 76.07 s |
| Cross-vendor retry tests, isolated rerun | 2 passed | 2.43 s |
| Board Agent UI, isolated rerun | 1 passed | 4.19 s |

## Implementation-agent audit evidence after fixes

These are the implementation agent’s reported runs. Independent release results
are recorded separately in the release review.

| Check | Result | Duration | Notes |
| --- | --- | --- | --- |
| Full unit suite | 1,037 passed; 0 failed | 159.12 s | All 77 test suites passing |
| Full UI suite | 43 passed; 0 failed | 44.84 s | Concurrency 1; all UI tests passing |
| Production readiness regressions | 8 passed; 0 failed | 1.39 s | Covers findings 1–4 |
| Build mode unit tests | 5 passed; 0 failed | 0.06 s | Shared mode resolver tests |
| CI test suite (`test/ci.test.js`) | 29 passed; 0 failed | 34.40 s | Target-base committed config tests |
| Pipeline suite (`test/pipeline.test.js`) | 136 passed; 0 failed | 98.92 s | Chunks, teamwork, admissions |
| Voice suite (`test/voice.test.js`) | 35 passed; 0 failed | 15.72 s | Eligibility, actions, proposals |
| Runner suite (`test/runner.test.js`) | 29 passed; 0 failed | 0.91 s | Stage-appropriate read-only rules |

## Root cause analysis of intermittent baseline failures

1. **Cross-vendor retry cleanup**: the explicit `finally` deletion of
   `FAKE_CODEX_FAIL_ONCE` is retained. However, `clearFakeAgent()` already deletes
   every `FAKE_*` variable in that same `finally`; the claimed environment leak
   was not independently established as the cause of the original failure.
   Independent runs reproduced `git add -A` failing on the candidate's
   `index.lock`. A background progress `git diff` refreshes stat-only changes
   despite `--no-optional-locks`; a touched-but-unchanged file reproduces the
   unexpected index mutation deterministically. Progress diff now sets
   `diff.autoRefreshIndex=false`, leaving the agent's index alone.
2. **Board Agent refresh race**: refresh requests arriving during an in-flight
   request were discarded. The fix queues a refresh, retains the settings-refresh
   requirement, and rejects a response for a different scope.
3. **Fake-agent output truncation**: immediate `process.exit()` can truncate pipe
   output. Independent review replaced the initial 50 ms timeout/drain listener
   implementation with awaited stream-write callbacks at every exit site. This
   also prevents another fixture branch from executing while output is pending.
   This is an output-flushing fix, not evidence of a background-process leak.

## Completion criteria

All four findings are fixed, the regression cases pass, intermittent failures are
understood and addressed, and every release gate above has recorded evidence.
