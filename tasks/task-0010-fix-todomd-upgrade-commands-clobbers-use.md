---
id: task-0010
title: Fix todomd upgrade-commands clobbers user customizations in command files
status: Done
type: fix
priority: medium
labels: []
dependencies: []
created_date: 2026-06-11
source: ui
assignee: 
agent: claude
session_id: 6865ef4e-29c9-43d4-9c6d-1220bc2064a1
worktree:
verification: { attempts: 1, max_attempts: 3, last_verdict: pass }
triaged: 2026-06-11
cost_usd: 2.2211
needs_human_reason:
---

## Description

From code review of the agent-built budget support (commit bd31897).

`upgrade-commands` in `bin/todomd.js` overwrites each `.claude/commands/<name>.md` wholesale with the current template. But command files have a locked-core / editable-custom region split (CUSTOM_OPEN/CUSTOM_CLOSE markers in `src/board.js`, via `readCommandParts`/`writeCommandCustom`) so users can add project conventions. The wholesale overwrite wipes any user edits in that custom region.

Fix: upgrade only the locked core and preserve the user's custom region — read the existing custom region first (`readCommandParts`), write the fresh template, then re-apply the custom region (`writeCommandCustom`), so project-convention edits survive an upgrade.

## Acceptance Criteria

- [ ] upgrade-commands replaces the locked/core prompt with the current template
- [ ] Any user text in the editable custom region of each command file is preserved across the upgrade
- [ ] A test covers upgrade-commands preserving a custom region
- [ ] npm test passes

## Triage

**Insight:** The bug is in `bin/todomd.js` lines 139–143: the `upgrade-commands` loop calls `fs.writeFileSync(dest, content)` with raw template strings, unconditionally clobbering the entire file. The preserved-custom-region infrastructure already exists in `src/board.js` — `readCommandParts` extracts `{ custom, hasRegion }` and `writeCommandCustom` re-applies a custom region onto any file — so the fix is purely a matter of wiring them into the upgrade loop. One subtlety: `readCommandFile` returns `''` (not `null`) when a file is absent, so `readCommandParts` returns `hasRegion: false, custom: ''` for a first-time install; the fix must skip `writeCommandCustom` in that case to avoid injecting an empty custom-region block into brand-new installs. The loop already uses `await import(...)` (top-level await, ES module), so awaiting `writeCommandCustom` is straightforward.

**Proposed plan of action:**
1. In `bin/todomd.js`, additionally import `readCommandParts` and `writeCommandCustom` from `../src/board.js` alongside the existing `templates.js` import.
2. Replace the synchronous `fs.writeFileSync(dest, content)` call with a three-step sequence: (a) call `readCommandParts(cwd, name)` to capture the existing custom text, (b) write the fresh template directly with `fs.writeFileSync`, (c) if the captured `custom` is non-empty or `hasRegion` was true, `await writeCommandCustom(cwd, name, custom)` to re-apply the custom region.
3. Keep the `fs.mkdirSync` guard in place (still needed when the file doesn't exist yet).
4. Add a test in `test/board.test.js` (or `test/templates.test.js`) that simulates the upgrade: write a command file with custom content, overwrite with fresh template, re-apply custom, assert custom text survives and fresh core is present.
5. Run `npm test` and verify all existing tests still pass.

**Estimate:** S — the fix is ~10 lines, all required helpers already exist, and the test follows the pattern already established in `test/board.test.js` for `writeCommandCustom`.

**Flags:** none

## Implementation Plan

1. **`bin/todomd.js` — extend the import in the `upgrade-commands` block.**
   At line 130, the block already does:
   ```js
   const { CMD_PLAN, CMD_BUILD, CMD_VERIFY, CMD_DISPATCH, CMD_TRIAGE } = await import('../src/templates.js');
   ```
   Add a second dynamic import immediately after it:
   ```js
   const { readCommandParts, writeCommandCustom } = await import('../src/board.js');
   ```

2. **`bin/todomd.js` — replace the single `writeFileSync` call (line 142) with a three-step sequence.**
   Current:
   ```js
   fs.writeFileSync(dest, content);
   ```
   Replace with:
   ```js
   const existing = readCommandParts(process.cwd(), name);
   fs.writeFileSync(dest, content);
   if (existing && (existing.hasRegion || existing.custom)) {
     await writeCommandCustom(process.cwd(), name, existing.custom);
   }
   ```
   - `readCommandParts` returns `{ name, locked, custom, hasRegion }` for any valid name. When the file doesn't exist yet `readCommandFile` returns `''`, so `readCommandParts` returns `{ ..., custom: '', hasRegion: false }` — the condition is false and we skip re-injection, so brand-new installs do not get an empty custom-region block.
   - `writeCommandCustom` reads the freshly-written template, appends the custom region, and re-writes the file (with a git commit via `withRepoLock`). The git repo guard already exists at the top of the `upgrade-commands` block.
   - The `fs.mkdirSync` guard at line 141 stays in place — it is still needed for first-time installs.

3. **`test/board.test.js` — add a test for the upgrade-preserves-custom-region sequence.**
   Append a new test after the existing `writeCommandCustom` test (~line 281):
   ```js
   test('upgrade-commands sequence: fresh template overwrites core but preserves custom region', async () => {
     const { readCommandParts, writeCommandCustom } = await import('../src/board.js');
     const repo = makeRepo();

     // Seed a custom region into the existing stub command file
     await writeCommandCustom(repo, 'todomd-build', 'always run lint before committing');

     // Capture the custom region (as upgrade-commands would)
     const existing = readCommandParts(repo, 'todomd-build');
     assert.equal(existing.custom, 'always run lint before committing');

     // Simulate upgrade: overwrite with a new template core
     const newCore = '---\n---\nnew-template $ARGUMENTS';
     const dest = path.join(repo, '.claude', 'commands', 'todomd-build.md');
     fs.writeFileSync(dest, newCore);

     // Re-apply custom region (as upgrade-commands would when hasRegion || custom)
     assert.ok(existing.hasRegion || existing.custom);
     await writeCommandCustom(repo, 'todomd-build', existing.custom);

     // Verify: new core is present, custom text survived
     const parts = readCommandParts(repo, 'todomd-build');
     assert.match(parts.locked, /new-template \$ARGUMENTS/, 'new template core is in place');
     assert.equal(parts.custom, 'always run lint before committing', 'custom region survived');
   });

   test('upgrade-commands sequence: no custom region on brand-new install → no empty block injected', async () => {
     const { readCommandParts } = await import('../src/board.js');
     const repo = makeRepo();

     // File exists (stub) but has no custom region
     const existing = readCommandParts(repo, 'todomd-build');
     assert.equal(existing.hasRegion, false);
     assert.equal(existing.custom, '');

     // The upgrade condition is false — no writeCommandCustom call
     assert.ok(!(existing.hasRegion || existing.custom), 'should skip re-injection for new installs');
   });
   ```
   The `path` import is already at the top of the file; add `fs` if not already imported (it is — line 3).

4. **Run `npm test`** and confirm all existing and new tests pass.

Risks: `writeCommandCustom` commits via `withRepoLock`/`commitPaths` as a side-effect of re-applying the custom region. This is a behavior change: previously `upgrade-commands` wrote files with no git commit; now files that had a custom region will be committed. This is acceptable given the git-repo guard at the top of the block, but the commit message will be `chore(todomd): edit <name> prompt` (from `writeCommandFile`), which is a bit generic for an upgrade. This is a pre-existing wording in the helper and out of scope for this fix.

## Run Log
- 2026-06-11 23:59Z · Triage · 12 turns · $0.280 · ok
- 2026-06-12 00:07Z · Plan · 12 turns · $0.283 · ok
- 2026-06-12 00:13Z · Build attempt 1 · 41 turns · $0.963 · failed: agent
- 2026-06-12 00:25Z · Build attempt 1 · 19 turns · $0.369 · ok
- 2026-06-12 00:27Z · Verify attempt 1 · 14 turns · $0.325 · verdict: pass
