---
id: task-0015
title: board.js sanitize plan injection and fence-aware parseChunks
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
triaged: n/a (chunk 1/5 of task-0014)
session_id: ed9069ce-10ef-4c9e-a8ee-f324edacbce9
worktree:
verification: { attempts: 1, max_attempts: 3, last_verdict: pass }
cost_usd: 1.2689
---

## Description

board.js: sanitize plan injection and fence-aware parseChunks

## Acceptance Criteria

- [ ] createCard sanitizes the injected chunk plan so it cannot create a duplicate top-level heading; a test covers it
- [ ] parseChunks ignores
- [ ] npm test passes

## Implementation Plan

1. In src/board.js createCard (around L441), before interpolating `plan`
   into the card body, sanitize it: replace line-leading heading markers
   so they cannot create new `##` sections. Apply
   `plan.replace(/^(#{1,6}) /gm, (_, h) => '\\' + h + ' ')` to the local
   `plan` variable (backslash-escapes leading `#` chars so they render as
   literals). Apply this BEFORE the template literal.
2. In src/board.js parseChunks (L153-154), replace
   `body.split(/^## /m)` with a fence-aware split: iterate lines,
   toggle a `fenced` boolean on lines whose first non-whitespace chars
   are ` ``` ` (same pattern as `appendRunLog`), and split only on
   `## `-prefixed lines when `!fenced`. The rest of parseChunks
   (finding the Chunks section, extracting yaml) remains unchanged.
3. In test/board.test.js, add:
   (a) A test calling createCard with a plan containing `## Foo\n\n## Bar`
       and asserting the resulting file body contains no unescaped `## Foo`
       or `## Bar` section headings.
   (b) A test calling parseChunks on a body where `## Chunks` and the yaml
       are inside a fenced code block and asserting it returns [].
4. Run `npm test` — all tests must pass.

## Run Log
- 2026-06-12 08:44Z · Build attempt 1 · 21 turns · $0.709 · ok
- 2026-06-12 08:47Z · Verify attempt 1 · 12 turns · $0.560 · verdict: pass
