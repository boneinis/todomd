---
id: task-0023
title: Bound triage to a routing decision
status: Done
type: improvement
priority: medium
labels: []
dependencies: []
parent: task-0022
created_date: 2026-07-31
source: chunk
assignee:
agent: claude
triaged: n/a (chunk 1/3 of task-0022)
session_id: 15e37297-b96e-4073-a52d-27a6dae2ff8b
worktree:
verification: { attempts: 1, max_attempts: 3, last_verdict:  }
base_branch:
cost_usd: 1.6819
needs_human_reason:
---

## Description

Bound triage to a routing decision

## Acceptance Criteria

- [ ] The generated triage command asks for exactly one of Actionable, Technical spike needed, Split into smaller cards, or Needs human decision, each with a short rationale, risks, and next step.
- [ ] The generated triage command forbids architecture planning, broad repository exploration and Bash, and caps inspection at three directly relevant files.
- [ ] The generated config pins triage to the sonnet model, low effort, and a bounded max_turns, and runTriage uses those values.
- [ ] A triage run that ends successfully but leaves no recognizable decision stamps a no_decision failure reason rather than a completion date.

## Implementation Plan

1. `src/templates.js` is the source of truth — `todomd init` writes `CMD_TRIAGE`
   out to `.claude/commands/todomd-triage.md`. Both already hold the lightweight
   four-decision prompt as uncommitted working-tree edits; reconcile them so they
   are byte-identical rather than rewriting either from scratch, and confirm the
   prompt still states: one decision only, no architecture planning, no broad
   exploration, no Bash, at most three directly relevant files, edit only the card.
2. In the `triage:` block of the config that `src/templates.js` generates, pin the
   bounded run — `model: sonnet`, `effort: low`, `max_turns: 8`. Today
   `runTriage()` falls back to `t.max_turns || 15` and `config.default_model`, so
   an unpinned board triages on whatever the account default is.
3. In `runTriage()` (`src/pipeline.js`, ~line 1294), a successful envelope is
   stamped `triaged: <date>` without checking the agent actually decided anything.
   After a successful run, re-read the card and parse its `## Triage` section for a
   Decision line naming one of the four decisions. On a missing or unrecognized
   decision, stamp `triaged: failed (no_decision)` and append the reason to the run
   log instead of the date, so an unclassifiable card reads as un-triaged.
4. Export the parse as a pure helper (e.g. `parseTriageDecision(body)`) so it is
   testable without spawning an agent.
5. Tests — `test/pipeline.test.js`: the parser accepts all four decisions
   (tolerating case and surrounding markdown) and rejects a missing section, an
   empty section, and an invented decision. `test/templates.test.js`: the generated
   config pins the bounded triage defaults, and the generated triage command
   contains the four decisions plus the no-deep-exploration and no-Bash rules.

Risks: the working tree already carries uncommitted edits to
`.claude/commands/todomd-triage.md`, `.claude/commands/todomd-plan.md`,
`src/templates.js` and `src/pipeline.js` from an earlier failed run — inspect and
reconcile before editing, or the same change gets applied twice. Tightening
max_turns to 8 could truncate triage on large cards; the no_decision reason from
step 3 is what makes that visible instead of silent.

## Run Log
- 2026-07-31 20:57Z · Build attempt 1 · 41 turns · $1.682 · failed: agent
