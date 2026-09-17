# Production readiness: independent review and local release

Date: 2026-09-12. Branch: `codex/delivery-workflow-completion`.
Reviewed baseline: `e99d60b..58ac7b3` plus all tracked modifications and untracked
source, tests, and fix-plan documentation. This review also corrected release
blockers found independently; the implementation agent's checklist was not used
as proof of a passed gate.

## Review results

The four requested findings are addressed:

- Explicit epic decomposition takes precedence over delegation. Chunk epics are
  approved as trackers and queue admission returns `epic_tracker`; unified epics
  with unfinished children return `epic_active_children`. Approval itself remains
  successful for chunk trackers so it can release their children.
- Build pins its target before creating the candidate. Card-scoped configuration
  reads across CI, Verify, recovery, escalation, and triage use the recorded base.
  Invalid Build targets park with `invalid_base_branch`; missing committed target
  configuration uses defaults instead of peer-branch executable configuration.
- Canonical and legacy unified Plan modes produce milestone plans without
  fan-out. Provider teamwork instructions keep Plan/Verify read-only. Claude
  diagnostics retain final messages, structured output, and teamwork metadata.
- Ordinary routing saves omit epic mode, API creation/set reject that metadata
  for non-epics, and inconsistent existing cards are reported for repair.

Additional corrections made during this review:

1. Removed the workflow-change handler that silently changed explicit chunks to
   unified mode. The drawer also honors legacy `epic_split` when reopening.
2. Replaced Plan's ad hoc mode checks with the shared resolver. Canonical teamwork
   now wins over legacy `epic_split: true`; ordinary teamwork planning no longer
   writes epic-only metadata. Type-based epics use the same approval/drawer path.
3. Conversion runs under repository admission, preflights every affected child,
   and rejects live/queued work, delivery ownership, nonboolean archive consent,
   and preserved candidates. It checks mutation results before claiming success.
4. A routing-save response can no longer reopen an old drawer over a newer
   pending selection; it checks the original card, project, and generation.
5. Replaced fake-agent timed exit with awaited stdout/stderr callbacks at every
   exit site, preventing output truncation and fallthrough while flushing.
6. Reproduced the cross-vendor retry failure: the fresh agent's `git add -A`
   collided with a background progress probe's index lock. A deterministic
   touched-but-unchanged-file test failed because `git diff` refreshed the index
   despite `--no-optional-locks`. Setting `diff.autoRefreshIndex=false` on progress
   diff fixes the mutation; 30 subsequent stress runs passed both retry variants
   (60 scenarios). The explicit environment cleanup alone was redundant with
   `clearFakeAgent()` and did not fix this race. Git documents the
   [diff index refresh setting](https://git-scm.com/docs/git-config#Documentation/git-config.txt-diffautoRefreshIndex).
7. Linux CI previously failed because fixtures assumed the user's default branch
   was `main` and unit tests invoked an installed, authenticated Gemini CLI.
   Fixture repositories now explicitly initialize `main`; adapter unit tests use
   the existing fake Gemini CLI. Real delegation is checked separately below.

## Validation evidence

Results for the final release are recorded in the local release manifest and raw
logs under `~/.local/state/todomd-releases/2026-09-12-production-readiness/`.
The command history includes the initial failed index-lock run and its regression
reproduction; those failures are retained rather than replaced by passing reruns.

- Focused readiness and build-mode tests: 13 passed.
- CI, voice, and runner suites: 93 passed before the additional review corrections;
  final complete-suite and packaging runs validate those corrections again.
- Index ownership regression suite: 5 passed; the new regression failed before
  the progress-probe fix.
- Retry stress test: 30 runs, 60 scenarios, zero failures after the fix.
- Final full unit suite: 1,044 passed, zero failed/skipped (145.27 s).
- Final full UI suite: 44 passed, zero failed/skipped (90.13 s), concurrency 1.
- Dependency audit: zero vulnerabilities.
- Packaging gate, two-installation rollback, and deployment checks: consult the
  release manifest for exact artifact identity and results.
- The full unit suite includes credential scope, evidence admission, release path
  traversal/symlink rejection, rollback-history, and active-owner protection tests.
- No typecheck was started. This repository has no typecheck script; another
  workspace's existing TypeScript process was left alone.

Real read-only Plan smoke runs used Claude Code 2.1.269, Codex CLI 0.153.4, and
agy 1.2.2 through `runStage`, in separate disposable repositories. All exited 0
and preserved the fixture files. Claude emitted `Agent` execution; the Codex
session recorded `spawn_agent` and `wait_agent`; Gemini emitted a completed
`invoke_subagent` with a child conversation. These are actual provider operations,
not fake CLI argument checks. They validate bounded delegation, not a full
production feature build. Private provider transcripts are retained locally.

## Local rollout and rollback

Production is launchd service `com.4upfit.todomd-board`, serving loopback port
7337. Its prior installation is
`~/.local/lib/cifleet-todomd/58ac7b302cebdf7c3adad20aef0e32fb88bd2717`.

The release procedure packs the committed branch, records its SHA-256, installs
into a new commit-named directory, and exercises old → candidate → old in an
isolated home/repository. That test preserves the card, configuration, registry,
and credentials across application versions.

Before rollout, check every registered project's active run state and execution
columns. Back up the launchd plist, record board/configuration and credential
hashes, unload only the TODOMD service, change only its program path, then reload
it. Confirm authenticated board responses and served assets match the candidate.
No board migration, main-worktree merge, provider-settings change, or co-hosted
project source change is part of this rollout.

Rollback unloads this same service, restores the saved plist pointing at the
retained prior installation, and reloads it. It does not restore stale board data
or erase events created after release. The exact artifact, commit, backup path,
checks, and rollout outcome belong to the local release manifest.
