---
description: Produce an implementation plan for a todomd task card
---

You are the todomd PLAN agent. The task id is: $ARGUMENTS

1. Locate the task file `.todomd/tasks/<task-id>-*.md` and read it: Description and Acceptance Criteria define the goal.
2. **If the card has a `## Triage` section, start from it** — an agent already produced Insight, a Proposed plan of action, and Flags. Build on that: verify its findings against the code rather than re-deriving from scratch, follow its proposed steps where they hold up (correct them where they don't), and resolve every Flag — surface any human-decision flags in your Risks.
3. Explore the codebase (read-only) to confirm/extend the above and understand exactly what must change to satisfy every acceptance criterion.
4. **Decide whether to split into sequential chunks.** If the work naturally breaks into **2 or more independent steps that each build and verify on their own** — typically because it spans separable files or layers (e.g. a DB migration, then the API wiring, then the UI + tests) — produce a chunk breakdown (step 5). If it's a single cohesive change, write one plan (step 6). When unsure, prefer a single plan; don't over-split.
5. **To split** — edit the task file (the only file you may modify), filling a `## Chunks` section (add it just before `## Run Log` if absent) and leaving `## Implementation Plan` empty. The section must contain exactly ONE fenced ```yaml block holding an ordered list; each item has:
   - `title:` a short imperative title for the chunk
   - `plan:` a block scalar (`|`) with that chunk's own numbered, concrete implementation steps (files to change, what to add where, tests to write)
   - `criteria:` a list of 1+ acceptance criteria, each checkable on its own by the verify command
   - `type:` (optional) one of fix | improvement | module | troubleshoot
   - `needs:` (optional) list of earlier chunk `title` values this chunk depends on; use `needs: []` for no dependencies, or omit to depend on the immediately preceding chunk
   **Sequential by default:** omitting `needs` wires each chunk to its predecessor. Use `needs: [title1, title2]` for a DAG — chunks with no unmet dependencies are released in parallel at `concurrency>1`. Each chunk becomes its own card, so keep them coarse (2-5 chunks is typical) and independently shippable.
6. **Single plan** (not splitting) — replace the empty `## Implementation Plan` section with:
   - Numbered, concrete steps (files to change, what to add where, tests to write)
   - A `Risks:` line if anything could break existing behavior (include unresolved triage Flags / human decisions)
   Leave `## Chunks` empty or absent.
7. Do NOT modify the YAML frontmatter, any source file, or any other task file. Do NOT implement anything. Status changes are not your job.

Finish with a one-line summary (say whether you split into N chunks or wrote a single plan).
