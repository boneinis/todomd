---
id: task-0002
title: Chunking fold a single-chunk plan into the Implementation Plan
status: Done
type: fix
priority: medium
labels: []
dependencies: []
created_date: 2026-06-11
source: ui
assignee:
agent: claude
session_id: b79e3fe0-e5e0-404b-9354-d9db21edc59d
worktree:
verification: { attempts: 1, max_attempts: 3, last_verdict: pass }
triaged: 2026-06-11
cost_usd: 1.1704
needs_human_reason:
---

## Description

When the plan agent emits exactly ONE chunk, pipeline.js currently falls through to Planned with a Run Log note, leaving `## Implementation Plan` empty (the work sits in `## Chunks`), so the Build agent gets no plan. Fold the single chunk's `plan` into `## Implementation Plan` before moving to Planned.

Touch: src/pipeline.js (the `chunks.length === 1` branch in runTriggerStage). Add a board/pipeline test.

## Acceptance Criteria

- [ ] A plan with exactly one chunk lands in Planned with its plan written into `## Implementation Plan`
- [ ] A 2+ chunk plan still fans out into child cards (no regression)
- [ ] A normal single-plan card is unaffected

## Implementation Plan

1. **Verify imports in `src/pipeline.js`** — `fs`, `path`, `readCard`, `withRepoLock`, and `appendRunLog` are all already imported (line 1–4); no new imports needed.

2. **Edit `src/pipeline.js` lines 449–451** — replace the existing single-chunk branch:
   ```js
   // before
   if (chunks.length === 1) {
     await appendRunLog(project.path, id, '  - note: plan proposed a single chunk — kept as one card');
   }
   ```
   with a fold-then-log sequence:
   ```js
   if (chunks.length === 1) {
     await withRepoLock(project.path, async () => {
       const card = readCard(project.path, id);
       if (card) {
         const plan = (chunks[0].plan || '').trimEnd();
         const header = '## Implementation Plan\n';
         const idx = card.raw.indexOf(header);
         if (idx !== -1) {
           const afterHeader = idx + header.length;
           const nextSection = card.raw.indexOf('\n## ', afterHeader);
           const end = nextSection >= 0 ? nextSection + 1 : card.raw.length;
           const updated = card.raw.slice(0, afterHeader) + `\n${plan}\n\n` + card.raw.slice(end);
           fs.writeFileSync(path.join(project.path, '.todomd', 'tasks', card.file), updated);
         }
       }
     });
     await appendRunLog(project.path, id, '  - note: single-chunk plan folded into Implementation Plan');
   }
   ```
   The string-index approach (find header, find next `## `, splice) is used instead of a regex to avoid escaping edge cases and to follow the same pattern as `appendRunLog` in `board.js`.

3. **Add a test in `test/pipeline.test.js`** after the existing 2-chunk fan-out test (around line 281). Use `useFakeAgent({ chunks: 1 })`, drag the card to `Plan`, wait for status `Planned`, then assert:
   - `readCard(repo, 'task-0001').data.status === 'Planned'` (no epic flag set)
   - `readCard(repo, 'task-0001').body` matches `/## Implementation Plan\n\n1\. Implement part 1\./`
   - The card has no `children` field (it was NOT fanned out)
   - The run log contains `"single-chunk plan folded into Implementation Plan"`

4. **Confirm no regressions** — the two existing tests are sufficient:
   - `chunks: 2` fan-out test (line 250) exercises the `>= 2` path, unchanged.
   - Normal single-plan test (no `FAKE_CHUNKS`) exercises the plain-plan path where `chunks.length === 0`, unchanged.

Risks: The string-index splice assumes `## Implementation Plan\n` appears exactly once in the raw card. This is guaranteed by `createCard` in `board.js`; the only way it wouldn't be present is a hand-edited card, which is an accepted edge-case (the `if (idx !== -1)` guard makes it a no-op).

## Triage

**Insight:** The bug lives in `runTriggerStage` in `src/pipeline.js` at lines 448–453. When `parseChunks` returns exactly 1 chunk the code appends a run-log note and immediately calls `orchMove` to Planned, but never writes `chunks[0].plan` into the card's `## Implementation Plan` body section — so the Build agent sees an empty plan. By contrast, `fanOutChunks` (the 2+ path) writes the plan via `createCard`'s `plan:` field for each child. No board helper currently exists for replacing a body section in place; the fix can use the already-imported `withRepoLock` + direct `fs.writeFileSync` inside `pipeline.js`, or a small new helper modeled on `appendRunLog` in `board.js`. The fake-agent already supports `FAKE_CHUNKS=1` (line 77 of `test/fixtures/fake-agent.js`), so test infrastructure is ready.

**Proposed plan of action:**
1. In `src/pipeline.js`, in the `chunks.length === 1` branch of `runTriggerStage` (~line 449): after the run-log note, call `withRepoLock` to read the card and replace the empty `## Implementation Plan` section with `chunks[0].plan`, then write the file — keep it inline to avoid touching `board.js`.
2. Update the run-log message from `"note: plan proposed a single chunk — kept as one card"` to something like `"note: single-chunk plan folded into Implementation Plan"`.
3. Add a `pipeline.test.js` case: `useFakeAgent({ chunks: 1 })` → drag to Plan → assert status reaches Planned AND `readCard` body contains `## Implementation Plan\n\n1. Implement part 1.`.
4. Verify existing multi-chunk test (`FAKE_CHUNKS=2`, already at line 250) still passes — no regression.
5. Verify normal single-plan card (no Chunks section) test still reaches Planned with its plan intact — existing happy-path test covers this but double-check it's exercised.

**Estimate:** S — single-branch fix (~8 lines), one new test case; everything else is existing infrastructure.

**Flags:** none

## Run Log
- 2026-06-11 21:14Z · Triage · 9 turns · $0.469 · ok
- 2026-06-11 22:43Z · Plan · 13 turns · $0.314 · ok
- 2026-06-11 22:44Z · Build attempt 1 · 14 turns · $0.264 · ok
- 2026-06-11 22:45Z · Verify attempt 1 · 9 turns · $0.124 · verdict: pass
