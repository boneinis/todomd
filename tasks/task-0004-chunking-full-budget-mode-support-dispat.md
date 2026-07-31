---
id: task-0004
title: Chunking full budget-mode support (dispatcher fan-out + cascade)
status: Done
type: module
priority: high
labels: []
dependencies: []
created_date: 2026-06-11
source: ui
assignee:
agent: claude
session_id: ed7d6a92-8e07-4b87-ab87-a17c7f2b345e
worktree:
verification: { attempts: 0, max_attempts: 3, last_verdict: }
triaged: 2026-06-11
cost_usd: 0.7873
needs_human_reason:
epic: true
children: [task-0007, task-0008]
---

## Description

Today budget mode is safe but inert — the dispatcher cannot fan out or cascade chunks (fan-out + the cascade hook are server-side and launcher-only). Make it work via CLI helpers the dispatcher shells out to (robust, reuses tested JS):

1. Extract shared core: materializeChunks(repo, epicId) and advanceEpicChildren(repo, epicId, {build}) into a new src/chunks.js; pipeline.js fanOutChunks/advanceChildren become thin wrappers.
2. New CLI subcommands in bin/todomd.js: `todomd fanout <id>` and `todomd advance <id>` (same if (cmd===...) pattern).
3. CMD_DISPATCH edits (templates.js): after Plan, if the card has `## Chunks` run `todomd fanout`; skip epic:true cards in build selection; after a chunk Done run `todomd advance`.
4. humanMove: in budget mode the epic-approval branch moves chunk 1 to Queue (no enqueueBuild) so the dispatcher picks it up.

This reverses the current documented limitation.

## Acceptance Criteria

- [ ] In budget mode, a splitting plan materializes sequential child cards via the dispatcher
- [ ] Approving the epic builds the chunks in order through the dispatcher; the epic auto-completes
- [ ] The dispatcher never tries to build an epic tracker card
- [ ] Launcher mode behavior is unchanged; budget tests cover the new path

## Triage

**Insight:** The chunk fan-out and cascade are already fully implemented in `pipeline.js` as private functions `fanOutChunks` (line 487) and `advanceChildren` (line 531), but they're only reachable through the launcher's in-process call chain. In budget mode, two `if ((config.mode || 'launcher') !== 'budget')` guards at `humanMove` lines 309 and 332 skip both `advanceChildren` and `enqueueBuild`, intentionally leaving the dispatcher inert — the task is to route through CLI subcommands instead. `CMD_DISPATCH` in `templates.js` (line ~236) also explicitly tells the plan agent *not* to split into chunks, and has no fan-out, epic-skip, or cascade logic at all. A critical complication: `CMD_DISPATCH` is a constant that's written to `.claude/commands/todomd-dispatch.md` only at `todomd init` time — existing boards already have the old file on disk and won't receive the updated instructions unless an upgrade/overwrite mechanism is added.

**Proposed plan of action:**
1. Extract `fanOutChunks` and `advanceChildren` from `pipeline.js` into a new `src/chunks.js` exporting `materializeChunks(repoPath, epicId, chunks)` and `advanceEpicChildren(repoPath, epicId, {build})`, where `build` is a boolean (true = launcher calls `enqueueBuild`, false = budget mode leaves Queue for the dispatcher). Thin-wrap the originals in `pipeline.js` to call these.
2. Add `todomd fanout <id>` and `todomd advance <id>` subcommands to `bin/todomd.js` that import `src/chunks.js` and call `materializeChunks`/`advanceEpicChildren` directly (no `enqueueBuild`), using `process.cwd()` as the repo path.
3. Update `CMD_DISPATCH` in `templates.js`: remove the "no chunks" restriction in the Plan step; add a post-Plan block that checks for `## Chunks` and shells out `todomd fanout <id>`; add an `epic: true` skip guard in the build-selection step; after a chunk verifies as Done, shell out `todomd advance <id>`.
4. Update `humanMove` in `pipeline.js` (the epic-approval branch, line ~309): remove the `!== 'budget'` guard so the epic moves to Queue in both modes, but only call `advanceChildren` in launcher mode (budget mode relies on the dispatcher reading Queue).
5. Add a `todomd upgrade-commands` CLI subcommand (or an overwrite path in `init`) that rewrites the `.claude/commands/todomd-*.md` files so existing boards pick up the new `CMD_DISPATCH` without requiring a full re-init.
6. Write budget-mode tests covering: Plan→chunk fan-out via `todomd fanout`, dispatcher skipping epic trackers, sequential chunk cascade via `todomd advance`, and epic auto-completion.

**Estimate:** L — touches four source files plus a new module, requires a natural-language instruction rewrite in `CMD_DISPATCH` (the highest-risk edit), CLI integration, and tests for a previously untested code path; the on-disk upgrade problem adds meaningful scope.

**Flags:**
- **On-disk CMD_DISPATCH**: Existing boards will not receive the updated `todomd-dispatch.md` unless a migration mechanism is added. The plan includes `todomd upgrade-commands` but the human must decide: should `todomd init` silently overwrite command files if they differ from the template? That would break intentional user customizations.
- **`build` parameter shape**: `advanceEpicChildren` needs to be callable from both pipeline.js (launcher, which calls `enqueueBuild`) and the CLI (budget mode, which does not). Confirm the interface: accept a `{build: fn|null}` option or a simple boolean; a function is cleaner but requires careful null-guarding in the CLI path.

## Implementation Plan

## Chunks

```yaml
- title: Extract chunks.js + CLI subcommands + humanMove budget fix
  type: module
  plan: |
    1. Read src/pipeline.js to locate the exact bodies of `fanOutChunks` (~lines 502-541)
       and `advanceChildren` (~lines 546-554). Note every internal dependency each uses
       (createCard, appendRunLog, config, board helpers, etc.).
    2. Create src/chunks.js as an ESM module:
       a. Export `async function materializeChunks(repoPath, epicId, chunks)` — port
          the body of fanOutChunks. Open the board via board.js using repoPath, create
          child card files, set sequential dependencies, mark the epic card with
          `epic: true` and `children: [ids]`, and append to the run log.
       b. Export `async function advanceEpicChildren(repoPath, epicId)` — port the body
          of advanceChildren. Open the board, find Planned children of epicId whose
          dependencies are all Done, move them to Queue, and return the array of moved
          card IDs. Does NOT call enqueueBuild.
    3. In src/pipeline.js:
       a. Import `materializeChunks` and `advanceEpicChildren` from './chunks.js'.
       b. Replace the body of `fanOutChunks` with a one-liner delegating to
          `materializeChunks(project.repoPath, epicId, chunks)`.
       c. Replace the body of `advanceChildren` with: call
          `advanceEpicChildren(project.repoPath, epicId)`, then call
          `enqueueBuild(project, id)` for each returned moved card ID (launcher-mode
          behaviour preserved).
       d. In humanMove, find the epic-approval guard (~line 309) that skips
          advanceChildren in budget mode. Change it so budget mode still calls
          `advanceEpicChildren(project.repoPath, epicId)` (moves chunk-1 to Queue)
          but does NOT call enqueueBuild — the dispatcher picks up Queue status.
       e. In humanMove, find the error block (~lines 318-320) that rejects chunk plans
          in budget mode ("chunk fan-out runs only under the launcher server"). Remove
          that guard entirely — chunk plans are now valid in budget mode.
    4. In bin/todomd.js, add two new `if (cmd === ...)` blocks before the final else:
       a. `todomd fanout <id>`: Validate the id argument; locate the epic card file
          (.todomd/tasks/<id>-*.md); extract and YAML-parse the fenced block under
          `## Chunks`; call `materializeChunks(process.cwd(), id, parsedChunks)`;
          print the count of child cards created; exit 0.
       b. `todomd advance <id>`: Validate the id argument; call
          `advanceEpicChildren(process.cwd(), id)`; print the moved card IDs; exit 0.
  criteria:
    - Running `todomd fanout <epic-id>` on a card with a `## Chunks` section creates
      the correct number of sequential child card files in .todomd/tasks/ with proper
      dependency links and the epic card gains epic:true and children frontmatter
    - Running `todomd advance <epic-id>` moves ready Planned children (dependencies all
      Done) to Queue status without starting any build process
    - In budget mode, humanMove on an epic approval calls advanceEpicChildren so chunk-1
      lands in Queue instead of silently skipping the advance step
    - Launcher-mode chunk fan-out and cascade are unaffected; all existing pipeline tests
      pass

- title: Update CMD_DISPATCH + upgrade-commands subcommand + budget chunk tests
  type: module
  plan: |
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
  criteria:
    - In budget mode, a dispatcher that follows CMD_DISPATCH will call `todomd fanout`
      after a split plan and `todomd advance` after each chunk Done
    - The dispatcher never selects a card with epic:true for building
    - All 4 acceptance criteria from the task description are satisfied end-to-end
    - Budget-chunk tests pass; launcher pipeline tests remain green
```

## Run Log
- 2026-06-11 21:13Z · Triage · 9 turns · $0.380 · ok
- 2026-06-11 22:55Z · Plan · 5 turns · $0.407 · ok
- 2026-06-11 22:55Z · Plan · split into 2 sequential chunks: task-0007 → task-0008
