---
id: task-0019
title: templates.js + test CMD_BUILD commit instruction and timing-stable cancel test
status: Done
type: fix
priority: medium
labels: []
dependencies: []
parent: task-0014
created_date: 2026-06-12
source: chunk
assignee:
agent: claude
triaged: n/a (chunk 5/5 of task-0014)
session_id: afd7bf83-3ea7-4340-bdaf-951e546fa780
worktree:
verification: { attempts: 1, max_attempts: 3, last_verdict: pass }
cost_usd: 0.5275
---

## Description

templates.js + test: CMD_BUILD commit instruction and timing-stable cancel test

## Acceptance Criteria

- [ ] CMD_BUILD instructs committing only changed source/test files (never git add -A or .todomd/)
- [ ] the cancel mid-build test is timing-independent and stable under load
- [ ] npm test passes

## Implementation Plan

1. In src/templates.js CMD_BUILD rule 5 (L117): replace the current text
   with: "Commit your changes on the current branch. Stage only the
   specific source/test files you modified (`git add <file1> <file2>
   ...`). **Never use `git add -A` or `git add .`**, and **never add or
   commit anything under `.todomd/`**. Follow the repository's commit
   conventions — if commitlint/husky enforce Conventional Commits, use an
   appropriate type (`feat:`/`fix:`/`test:`…); include the task id in the
   message. Do not push, do not switch branches, do not merge."
2. In test/pipeline.test.js cancel mid-build test (L137): change the
   `until()` condition from
     `status(repo, 'task-0001') === 'Build' && fs.existsSync(marker)`
   to just `fs.existsSync(marker)`. The hang marker is sufficient to
   prove the fake agent is running — no need for the Build status flip.
3. On L139 (`assert.ok(fs.existsSync(wt))`): wrap with
     `await until(() => fs.existsSync(wt), { timeout: 15000 })`
   before the assertion, since the worktree may appear slightly after
   the marker in the fake agent startup sequence.
4. If a CMD_BUILD template test exists (e.g. test/templates.test.js),
   update it to assert the new rule 5 text explicitly prohibits
   `git add -A` and `.todomd/`.
5. Run `npm test` — all tests must pass.

## Run Log
- 2026-06-12 09:07Z · Build attempt 1 · 14 turns · $0.246 · ok
- 2026-06-12 09:08Z · Verify attempt 1 · 11 turns · $0.282 · verdict: pass
