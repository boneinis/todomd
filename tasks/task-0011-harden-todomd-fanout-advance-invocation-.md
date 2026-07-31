---
id: task-0011
title: Harden todomd fanout/advance invocation from the budget dispatcher
status: Done
type: improvement
priority: low
labels: []
dependencies: []
created_date: 2026-06-11
source: ui
assignee:
agent: claude
session_id: 46c55509-de75-469d-bb13-94d4f3cebd6b
worktree:
verification: { attempts: 1, max_attempts: 3, last_verdict: pass }
triaged: 2026-06-12
cost_usd: 1.7708
needs_human_reason:
---

## Description

From code review of the agent-built budget support (commit bd31897).

CMD_DISPATCH (`src/templates.js`) instructs the dispatcher to shell out `npx todomd fanout <id>` and `npx todomd advance <parent>`. In an arbitrary consumer repo `npx todomd` may not resolve to the right bin and can trigger a network fetch (slow/surprising), or fail when todomd is not installed as a dependency.

Fix: invoke via a reliable absolute path instead of npx resolution. `bin/todomd.js` already knows its own location (`TODOMD_BIN`); expose/derive that so the dispatcher can call `node <abs-bin> fanout <id>` (or equivalent) without depending on npx or the network.

## Acceptance Criteria

- [ ] The dispatcher invokes fanout/advance via a reliable path that does not depend on npx resolution or a network fetch
- [ ] Works in a consumer repo that has not installed todomd globally
- [ ] The approach is documented and shown to be feasible (test or note)

## Triage

**Insight:** `CMD_DISPATCH` in `src/templates.js` is a static string template that gets written verbatim to `.claude/commands/todomd-dispatch.md` at `init`/`upgrade-commands` time — there is no per-project substitution. The two `npx todomd` calls (lines 236 and 247 of `templates.js`) are instructions to the LLM dispatcher agent to run a Bash command; if `todomd` is not in local `node_modules/.bin`, `npx` silently falls back to a network resolution from the npm registry, which is slow or fails in air-gapped environments. The launcher scripts already solve an identical problem: `src/launcher.js` hardcodes both `nodeBin` (`process.execPath`) and `todomdBin` (`TODOMD_BIN = fileURLToPath(import.meta.url)`) into generated shell scripts for exactly this reason — the same pair is available in `bin/todomd.js` and should be substituted into `CMD_DISPATCH` at write time. The `upgrade-commands` path always overwrites (unlike `initProject` which skips existing files), so any fix will reach existing users automatically.

**Proposed plan of action:**
1. Convert `CMD_DISPATCH` from a static string export to a function `cmdDispatch(nodeBin, todomdBin)` in `src/templates.js` that returns the string with `npx todomd` replaced by `"${nodeBin}" "${todomdBin}"` (matching the launcher pattern exactly).
2. Update `initProject(repoPath)` to accept an optional second argument `{ nodeBin, todomdBin }` and call `cmdDispatch(nodeBin, todomdBin)` instead of using the raw string; fall back to `cmdDispatch('node', 'todomd')` (or a `npx todomd` sentinel) when the caller doesn't supply paths, to keep the function usable in tests.
3. In `bin/todomd.js`, pass `{ nodeBin: process.execPath, todomdBin: TODOMD_BIN }` to `initProject()` in the `init` case.
4. In the `upgrade-commands` case in `bin/todomd.js`, replace the `CMD_DISPATCH` import with a call to `cmdDispatch(process.execPath, TODOMD_BIN)`.
5. Add a test that verifies the generated command file does not contain `npx todomd` and does contain an absolute path to the bin (similar in spirit to the existing `runner.test.js` env-override tests).

**Estimate:** S — the change is confined to `src/templates.js` (one export shape change) and `bin/todomd.js` (two call sites), following an established pattern from the launcher. No new dependencies or protocol changes.

**Flags:** The burned-in absolute path makes `.claude/commands/todomd-dispatch.md` non-portable across machines (valid only where `init`/`upgrade-commands` was run), the same trade-off the launcher scripts already accept. Decide whether this is acceptable or whether a `TODOMD_BIN` env-var fallback is preferred (e.g. `"${TODOMD_BIN:-npx todomd}"`); the card's suggested approach (absolute path) implies the trade-off is fine, but worth confirming.

## Implementation Plan

1. **`src/templates.js` — convert `CMD_DISPATCH` to a function**
   - Rename the `export const CMD_DISPATCH = \`...\`` declaration to a non-exported `const CMD_DISPATCH_TMPL = \`...\`` (the raw template is unchanged).
   - Add and export: `export function cmdDispatch(nodeBin, todomdBin) { return CMD_DISPATCH_TMPL.replaceAll('npx todomd', \`"${nodeBin}" "${todomdBin}"\`); }`
   - Keep a backward-compat shim for any caller that hasn't switched: `export const CMD_DISPATCH = cmdDispatch('npx', 'todomd');`

2. **`src/templates.js` — update `initProject` to accept bin paths**
   - Change signature from `export function initProject(repoPath)` to `export function initProject(repoPath, { nodeBin, todomdBin } = {})`.
   - In the `writes` array replace `CMD_DISPATCH` with `cmdDispatch(nodeBin ?? 'npx', todomdBin ?? 'todomd')`.

3. **`bin/todomd.js` — `init` case (line 54)**
   - Change `initProject(process.cwd())` → `initProject(process.cwd(), { nodeBin: process.execPath, todomdBin: TODOMD_BIN })`.

4. **`bin/todomd.js` — `upgrade-commands` case (line 130)**
   - Change the destructured import from `{ CMD_PLAN, CMD_BUILD, CMD_VERIFY, CMD_DISPATCH, CMD_TRIAGE }` to `{ CMD_PLAN, CMD_BUILD, CMD_VERIFY, cmdDispatch, CMD_TRIAGE }`.
   - In the `commands` array replace the `CMD_DISPATCH` entry with `['todomd-dispatch', cmdDispatch(process.execPath, TODOMD_BIN)]`.

5. **`test/dispatch-cmd.test.js` — new test file**
   - Import `cmdDispatch` from `../src/templates.js`.
   - Test 1: `cmdDispatch('/abs/node', '/abs/bin/todomd.js')` — assert the result does NOT contain `npx todomd`, and does contain `/abs/node` and `/abs/bin/todomd.js`.
   - Test 2 (regression): `cmdDispatch('npx', 'todomd')` — assert the result still contains `fanout` and `advance` (structural integrity of the command).

Risks: The absolute bin path baked into `.claude/commands/todomd-dispatch.md` is machine-specific — valid only where `init`/`upgrade-commands` was run. This matches the accepted trade-off of the launcher scripts (documented in `src/launcher.js`). Users who share `.claude/commands/` across machines must re-run `upgrade-commands` on each machine after upgrading.

## Run Log
- 2026-06-12 00:00Z · Triage · 14 turns · $0.340 · ok
- 2026-06-12 00:32Z · Plan · 16 turns · $0.384 · ok
- 2026-06-12 00:36Z · Build attempt 1 · 32 turns · $0.683 · ok
- 2026-06-12 00:37Z · Verify attempt 1 · 10 turns · $0.364 · verdict: pass
