---
id: task-0008
title: Update CMD_DISPATCH + upgrade-commands subcommand + budget chunk tests
status: Done
type: module
priority: medium
labels: []
dependencies: [task-0007]
parent: task-0004
created_date: 2026-06-11
source: chunk
assignee:
agent: claude
triaged: n/a (chunk 2/2 of task-0004)
session_id: a71b3874-668f-4b17-ad8d-e91860ca1d43
worktree:
verification: { attempts: 1, max_attempts: 3, last_verdict: pass }
cost_usd: 1.7916
---

## Description

Update CMD_DISPATCH + upgrade-commands subcommand + budget chunk tests

## Acceptance Criteria

- [ ] In budget mode, a dispatcher that follows CMD_DISPATCH will call `todomd fanout` after a split plan and `todomd advance` after each chunk Done
- [ ] The dispatcher never selects a card with epic:true for building
- [ ] All 4 acceptance criteria from the task description are satisfied end-to-end
- [ ] Budget-chunk tests pass; launcher pipeline tests remain green

## Implementation Plan

1. In src/templates.js, edit the CMD_DISPATCH multiline string:
   a. Plan step: Remove the sentence instructing the agent NOT to split into chunks
      (the launcher-only restriction). Add: after the plan completes, if the card has
      a non-empty `## Chunks` section, shell out `npx todomd fanout <id>` and note
      that the epic card awaits human approval (status Review) before children build.
   b. Build-selection step: Add an explicit skip guard at the top — exclude any card
      whose frontmatter contains `epic: true`; these are epic tracker cards that
      complete automatically and must not be built directly.
   c. Post-verify Done step: After a chunk card passes verification and moves to
      Done, check whether the card has a `parent:` frontmatter field. If so, shell
      out `npx todomd advance <parent-id>` to cascade the next chunk to Queue and
      allow the epic to auto-complete when all children are Done.
2. Add `todomd upgrade-commands` to bin/todomd.js:
   a. New `if (cmd === 'upgrade-commands')` block.
   b. Import command template strings from templates.js.
   c. Write each template to its .claude/commands/todomd-<name>.md path,
      overwriting the existing file.
   d. Print a summary of files overwritten and exit 0.
   (This resolves the on-disk upgrade Flag from triage — existing boards call
   `todomd upgrade-commands` explicitly rather than re-running init.)
3. Write budget-chunk tests (add to test/budget.test.js or a new
   test/budget-chunks.test.js):
   a. 'budget: CMD_DISPATCH instructs fanout after split plan' — init a repo, read
      .claude/commands/todomd-dispatch.md, assert it contains 'todomd fanout'.
   b. 'budget: CMD_DISPATCH skips epic tracker cards' — assert the dispatch
      instructions include a guard on `epic: true`.
   c. 'budget: CMD_DISPATCH cascades via todomd advance' — assert the instructions
      include 'todomd advance' in the post-Done section.
   d. 'budget: humanMove epic approval moves chunk-1 to Queue' — use
      materializeChunks directly to set up an epic with 2 children in Planned state,
      then call humanMove to approve the epic in budget mode; assert chunk-1 is
      Queue and chunk-2 remains Planned.
   e. 'budget: advanceEpicChildren cascades to next chunk' — mark chunk-1 Done,
      call advanceEpicChildren, assert chunk-2 moves to Queue.
Risks: The CMD_DISPATCH rewrite changes natural-language instructions interpreted by
the dispatcher agent — ambiguous wording could cause mis-sequencing. Review the
updated instruction text carefully before merging. Existing boards must run
`todomd upgrade-commands` to receive the new instructions.

## Run Log
- 2026-06-11 23:24Z · Build attempt 1 · 40 turns · $1.458 · ok
- 2026-06-11 23:25Z · Verify attempt 1 · malformed verdict, re-running once
- 2026-06-11 23:27Z · Verify attempt 1 · 15 turns · $0.333 · verdict: pass
