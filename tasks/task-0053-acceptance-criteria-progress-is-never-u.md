---
id: task-0053
title: Acceptance-criteria progress is never updated, so the counter always reads zero
status: Queue
type: bug
priority: medium
labels: []
dependencies: []
created_date: 2026-09-08
source: ui
assignee:
agent:
build_profile: split_required
session_id:
worktree:
verification: { attempts: 0, max_attempts: 3, last_verdict: }
triaged: 2026-10-01
cost_usd: 0
needs_human_reason:
build_limits: {  }
complexity: medium
epic: true
epic_build_mode: chunks
children: [task-0060, task-0061]
---

## Description

The board parses the Acceptance Criteria section for checkbox items and reports
progress as completed against total. Nothing ever completes one.

The build agent is explicitly instructed never to modify anything under the board
directory, because its worktree copy is read-only context, and no code path in
the runtime marks a criterion complete either. So the counter is decorative: it
reads zero of N for the entire life of a card unless a person edits the file by
hand.

The consequence is that a card offers no way to follow a build in progress. What
the runtime does track is physical rather than semantic: each build checkpoint
snapshots the worktree head and changed paths, and several consecutive
checkpoints with no change trip a stall. That tells an operator the agent is
doing something, never which part of the plan it has finished.

Cards planned as a single unit are worst affected. A split epic at least gives
one completion signal per child card.

Decide the model rather than only fixing the symptom. Either criteria are
genuinely completable, in which case something trustworthy has to mark them and
the build agent's read-only rule needs a narrow, audited exception; or they are a
contract to be judged at review time, in which case the progress counter should
not present itself as live progress.

## Acceptance Criteria

- [ ] A decision is recorded on whether criteria are completable or are a review-time contract
- [ ] If completable, exactly one trusted actor marks them and the write is confined to the criteria block
- [ ] If not completable, the display no longer implies live progress
- [ ] A card planned as a single unit exposes some honest progress signal during a build
- [ ] The board's read-only rule for build agents remains enforced everywhere else
- [ ] Coverage proves a card's reported progress matches its real state at each stage

## Verification

Unit coverage of the progress computation and of whatever marks a criterion,
plus a board-level test following one card from build to done.

## Triage

- **Decision:** Needs human decision
- **Rationale:** The card requires an architectural choice between allowing a trusted actor to mark criteria during builds or treating them as a review-time contract. Implementation pathways are mutually exclusive until this model is chosen.
- **Risks or questions:** Should acceptance criteria be mutable during execution via audited agent writes, or remain an immutable review-time contract with alternative progress metrics?
- **Next step:** Ask the human.

## Run Log

- 2026-10-01 00:57Z · Triage · 1 turns · gemini/gemini-3.7-flash-high · gateway · usage unavailable · $0.000 est · ok
- 2026-10-01 01:05Z · Decision (human, via devin review) · Review-time contract — criteria stay immutable for the verifier; implement the card as: stop presenting the counter as live progress and replace it with an honest physical signal (commits/files touched). Keeps the build agent's read-only board rule intact.
- 2026-10-01 01:16Z · Plan · 1 turns · codex/gpt-6.1-sol · subscription CLI · 190.0K input, 146.7K cached, 2.9K output · $0.000 est · ok
- 2026-10-01 01:16Z · Plan · split into 2 sequential chunks: task-0060 → task-0061
