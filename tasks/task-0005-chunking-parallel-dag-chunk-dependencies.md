---
id: task-0005
title: Chunking parallel / DAG chunk dependencies
status: Done
type: improvement
priority: low
labels: []
dependencies: []
created_date: 2026-06-11
source: ui
assignee:
agent:
session_id: 0ef7e2cd-5abd-45a0-8f90-91dca6f93172
worktree:
verification: { attempts: 1, max_attempts: 3, last_verdict: pass }
triaged: 2026-06-11
cost_usd: 1.1071
needs_human_reason:
---

## Description

Chunks are currently strictly linear (chunk N depends only on N-1). Allow a DAG: add an optional `needs: [..]` field to the `## Chunks` format and wire `dependencies` from it in fan-out instead of `[prev]`. The cascade already supports arbitrary deps (advanceChildren checks ALL deps Done), and at concurrency>1 independent chunks parallelize for free — so this is mostly prompt format + fan-out wiring.

Touch: src/templates.js (CMD_PLAN format), the fan-out core, tests.

## Acceptance Criteria

- [ ] A chunk can declare `needs: [..]`; fan-out wires those as its dependencies
- [ ] Chunks with no unmet deps are released together (parallel build at concurrency>1)
- [ ] Omitting `needs` keeps today's sequential default

## Triage

**Insight:** The current `parseChunks` in `src/board.js:153` extracts `title`, `plan`, `criteria`, and `type` but silently ignores any other YAML fields — a `needs:` key added today would be dropped. The fan-out in `src/pipeline.js:fanOutChunks` (line 494) always sets `dependencies: prev ? [prev] : []`, hardcoding the sequential chain; swapping this to use a resolved `needs` list is the entire behavioral change. `advanceChildren` (line 531) already iterates all `dependencies` and waits for each to be `Done`, so it naturally handles DAG shapes without any modification. The `CMD_PLAN` string in `src/templates.js:94` currently says "Do NOT list dependencies — they are implicit by order," which will need to be updated to describe the optional `needs:` field.

**Proposed plan of action:**
1. **`src/board.js` — `parseChunks`**: Parse an optional `needs` field as a `string[]` (chunk titles). Validate that each entry is a non-empty string; drop malformed ones. Include `needs` in the returned chunk object only when present (keep the object shape clean for callers that don't care).
2. **`src/pipeline.js` — `fanOutChunks`**: After creating all chunk cards, use a `Map<title, id>` built during the loop. For each chunk, resolve `chunk.needs` titles to card IDs (warn in Run Log and skip unknown titles). Pass the resolved IDs as `dependencies`; fall back to `[prev]` when `needs` is absent (preserving sequential default).
3. **`src/templates.js` — `CMD_PLAN`**: In step 5, add documentation of the `needs: [title1, title2]` field and change the "Do NOT list dependencies" sentence to explain the optional DAG opt-in.
4. **`test/board.test.js`**: Add a `parseChunks` test case with a `needs:` list and one without (verifying the sequential-default fallback still works).
5. **`test/pipeline.test.js`**: Add a pipeline integration test: two independent chunks both released when the epic is approved (parallel at `concurrency>1`), plus a third chunk that depends on both.

**Estimate:** S — the behavioral delta is small (one line in fan-out changes from `[prev]` to resolved IDs). The template update and tests add breadth but not complexity. Total touch-points are 3 source files + 2 test files, all well-understood.

**Flags:** The `needs:` values are title strings (natural for agents to write). If index-based references (`needs: [0, 1]`) are preferred for robustness against title edits, the parse and resolution logic differs slightly — decide before the Plan stage. The template change affects new `initProject` installs only; existing `.claude/commands/todomd-plan.md` files are not updated automatically.

## Implementation Plan

**Flag resolved:** `needs:` values are title strings (not indices). Titles are natural for LLM plan agents to write, and resolution happens at fan-out time when all titles are known. Unknown titles (typos or forward refs) get a Run Log warning and are skipped; the chunk loses that dependency rather than failing hard.

1. **`src/board.js` — `parseChunks` (lines 162–174):** After building the `chunk` object (title, plan, criteria, type), parse an optional `needs` field:
   ```js
   if (Array.isArray(item.needs)) {
     const needs = item.needs.map((n) => String(n).trim()).filter(Boolean);
     if (needs.length) chunk.needs = needs;
   }
   ```
   Only set `needs` on the returned object when present and non-empty to keep callers that don't use it unaffected.

2. **`src/chunks.js` — `materializeChunks` (lines 14–36):** Replace the simple `prev` tracking with a `titleToId` map built incrementally during the loop. For each chunk:
   - If `chunk.needs` is present, resolve each title via `titleToId.get(title)`; collect resolved IDs as `dependencies`. Warn to the epic's Run Log (via `appendRunLog`) for any title not yet in the map (unknown or forward reference), then skip it.
   - If `chunk.needs` is absent, fall back to `prev ? [prev] : []` (unchanged sequential default).
   - After creating the card, add `titleToId.set(c.title, res.id)` and update `prev = res.id` as before.
   - Update the Run Log append at line 44 to show the split structure. When any chunk used `needs`, annotate with "(DAG)" to distinguish from a plain sequential split.

3. **`src/templates.js` — `CMD_PLAN` (line 89–94):** In step 5, add `needs:` to the documented fields and update the dependency note:
   - Add bullet: `` - `needs:` (optional) list of earlier chunk `title` values this chunk depends on; omit to depend on the immediately preceding chunk ``
   - Change the bold note from "**Order matters: each chunk may assume every earlier chunk is already built and merged to the main branch.** Do NOT list dependencies — they are implicit by order." to: "**Sequential by default:** omitting `needs` wires each chunk to its predecessor. Use `needs: [title1, title2]` for a DAG — chunks with no unmet dependencies are released in parallel at `concurrency>1`."

4. **`test/board.test.js`:** Add two test cases after the existing `parseChunks` tests (after line 379):
   - `parseChunks: needs field is parsed as string array and present only when non-empty` — a CHUNKS body where one item has `needs: [DB migration]` should yield a chunk with `needs: ['DB migration']`; an item with no `needs` field should not have a `needs` property on the returned object.
   - `parseChunks: malformed needs (non-array) is ignored` — an item with `needs: "bad"` (a string, not array) should not produce a `needs` property.

5. **`test/budget-chunks.test.js`:** Add a DAG integration test after the existing tests:
   - Create an epic with 3 chunks in YAML: chunk-A (no `needs`), chunk-B (no `needs`), chunk-C (`needs: [chunk-A, chunk-B]`).
   - Call `materializeChunks` and assert 3 child IDs were created.
   - Assert chunk-A and chunk-B each have empty `dependencies` (or `[]`); chunk-C has `dependencies: [idA, idB]`.
   - Call `advanceEpicChildren` directly: assert both chunk-A and chunk-B are moved to Queue (parallel release), chunk-C remains Planned.
   - Mark chunk-A Done; call `advanceEpicChildren` again: assert chunk-C is still Planned (chunk-B not Done).
   - Mark chunk-B Done; call `advanceEpicChildren` again: assert chunk-C is now Queue.

Risks: `patchFrontmatter` is not involved — `dependencies` is set at `createCard` time, which already accepts a `dependencies` array in its options (confirmed at `chunks.js:22`). The `titleToId` map only resolves backward references; forward refs warn and produce no dependency, which is safer than silently including a wrong dep. The template change affects new `initProject` installs only — existing `.claude/commands/todomd-plan.md` files in user repos are not auto-updated.

## Run Log
- 2026-06-11 21:13Z · Triage · 10 turns · $0.386 · ok
- 2026-06-12 01:42Z · Plan · 0 turns · $0.000 · failed: agent
  - error: file:///Users/irvinbowman/.npm-global/lib/node_modules/@openai/codex/bin/codex.js:102
  throw new Error(
        ^

Error: Missing optional dependency @openai/codex-darwin-x64. Reinstall Codex: npm install -g @openai/codex@latest
    at findCodexExecutable (file:///Users/irvinbowman/.npm-global/lib/node_modules/@openai/codex/bin/codex.js:102:9)
    at file:///Users/irvinbowman/.npm-global/lib/node
- 2026-06-12 01:46Z · Plan · 13 turns · $0.338 · ok
- 2026-06-12 01:55Z · Build attempt 1 · 1 turns · $0.000 · ok
- 2026-06-12 01:55Z · Verify attempt 1 · malformed verdict, re-running once
- 2026-06-12 01:55Z · Verify attempt 1 · 0 turns · $0.000 · failed: bad_verdict
  - bad_verdict: Reading additional input from stdin...
2026-06-12T01:55:41.310576Z ERROR rmcp::transport::worker: worker quit with fatal: Transport channel closed, when Auth(AuthorizationRequired)
- 2026-06-12 02:03Z · Build attempt 1 · 1 turns · $0.000 · ok
- 2026-06-12 02:06Z · Verify attempt 1 · 14 turns · $0.383 · verdict: pass
