---
id: task-0007
title: Extract chunks.js + CLI subcommands + humanMove budget fix
status: Done
type: module
priority: medium
labels: []
dependencies: []
parent: task-0004
created_date: 2026-06-11
source: chunk
assignee:
agent: claude
triaged: n/a (chunk 1/2 of task-0004)
session_id: 05ffe4aa-eb26-4017-bc5c-ae6470c905bb
worktree:
verification: { attempts: 1, max_attempts: 3, last_verdict: pass }
cost_usd: 3.154
needs_human_reason:
---

## Description

Extract chunks.js + CLI subcommands + humanMove budget fix

## Acceptance Criteria

- [ ] Running `todomd fanout <epic-id>` on a card with a `## Chunks` section creates the correct number of sequential child card files in .todomd/tasks/ with proper dependency links and the epic card gains epic:true and children frontmatter
- [ ] Running `todomd advance <epic-id>` moves ready Planned children (dependencies all Done) to Queue status without starting any build process
- [ ] In budget mode, humanMove on an epic approval calls advanceEpicChildren so chunk-1 lands in Queue instead of silently skipping the advance step
- [ ] Launcher-mode chunk fan-out and cascade are unaffected; all existing pipeline tests pass

## Implementation Plan

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

## Run Log
- 2026-06-11 23:04Z · Build attempt 1 · 39 turns · $1.342 · ok
- 2026-06-11 23:05Z · Verify attempt 1 · malformed verdict, re-running once
- 2026-06-11 23:06Z · Verify attempt 1 · 16 turns · $0.142 · failed: bad_verdict
- 2026-06-11 23:15Z · Build attempt 1 · 31 turns · $1.059 · ok
- 2026-06-11 23:17Z · Verify attempt 1 · 18 turns · $0.611 · verdict: pass
