---
id: task-0024
title: Screen inbound email before a card exists
status: Needs Human
type: improvement
priority: medium
labels: []
dependencies: [task-0023]
parent: task-0022
created_date: 2026-07-31
source: chunk
assignee:
agent: codex
triaged: n/a (chunk 2/3 of task-0022)
session_id: 019fba8d-0e91-7dc0-8f8c-571c0fa7af27
worktree: todomd/task-0024
verification: { attempts: 1, max_attempts: 3, last_verdict:  }
base_branch: main
cost_usd: 12.2276
needs_human_reason: bad_verdict
recovery_stage:
model:
effort:
workflow:
skill:
---

## Description

Screen inbound email before a card exists

## Acceptance Criteria

- [ ] screenEmail classifies a parsed message as work, spam, or unclear from its headers and body alone, and reports a reason naming the signals it matched.
- [ ] A message screened as spam creates no card and appends exactly one audit record to the intake audit log.
- [ ] A message screened as unclear creates a card in the Needs Human column with a human-readable reason and does not trigger triage.
- [ ] A plausible work message still creates a normal Review card and still triggers triage.
- [ ] The intake audit log is capped so repeated screening cannot grow it without bound.

## Implementation Plan

1. New `src/screen.js` exporting a pure `screenEmail(parsed)` (input is the
   `mailparser` object already available in `pollSource`) returning
   `{ verdict, reason, signals }` where verdict is `work`, `spam`, or `unclear`.
   Deterministic header and body heuristics only — no LLM call, no network:
   - spam/marketing — a List-Unsubscribe header, a bulk/list/junk Precedence, an
     Auto-Submitted header other than `no`, campaign/ESP headers, a `no-reply`
     or `noreply` sender, unsubscribe or view-in-browser footer text, or an
     HTML-only body with no text part.
   - unclear — empty or very short body, no meaningful subject, an out-of-office
     or auto-reply, or a bounce (`mailer-daemon`, `postmaster`).
   - everything else — work.
   Return the matched signal names so the reason is auditable, and prefer
   `unclear` over `spam` whenever the signals are weak.
2. Add `appendIntakeAudit(projectPath, record)` writing one JSON line to
   `.todomd/intake-audit.jsonl` — timestamp, source label, from, subject,
   messageId, verdict, reason. Trim to the last 500 lines on write so it cannot
   grow without bound. Check how `src/board.js` treats `.todomd` files for git and
   either gitignore the audit file or commit it deliberately, consistently.
3. Wire it into `pollSource()` in `src/intake.js` (~line 214), after the project
   resolves and before `createCard`:
   - spam — append an audit record, log it, mark the message `\Seen`, create no
     card, continue.
   - unclear — create the card as today but with `status: 'Needs Human'`, a
     `needs_human_reason` taken from the screen reason, and
     `triaged: 'held (email screen)'`; do NOT call `onCard()` (that is what fires
     triage), and append an audit record too.
   - work — the existing path, unchanged.
4. Confirm `createCard` in `src/board.js` (~line 484) accepts and sanitizes both
   `status` and `needs_human_reason`; it normalizes status already, so add
   needs_human_reason to the frontmatter writer if it is not handled.
5. Tests in `test/intake.test.js` — a marketing message with List-Unsubscribe
   creates no card and appends exactly one audit line; an out-of-office or
   empty-body message creates a Needs Human card carrying a reason and never calls
   onCard; an ordinary bug report still creates a normal Review card and calls
   onCard; and the audit file stays capped after many writes.

Risks: heuristics can misclassify real work as spam — the audit record is the
recovery path, so it must be written before the message is marked seen. Holding a
card in Needs Human relies on the `status === 'Review'` guard in `maybeTriage()`
to keep agents off it; if any sweep later moves held cards, they would be picked
up. Attachments are currently only fetched on the created-card path, so screened
mail keeps its attachments only in the mailbox.

## Run Log
- 2026-07-31 21:03Z · Build attempt 1 · 41 turns · $1.928 · failed: agent
- 2026-07-31 21:33Z · Build attempt 1 · 31 turns · $2.599 · checkpoint 1: progress detected; continuing
- 2026-07-31 21:38Z · Build attempt 1 · 31 turns · $3.624 · checkpoint 2: progress detected; continuing
- 2026-07-31 21:42Z · Build attempt 1 · 5 turns · $1.700 · ok
- 2026-07-31 21:48Z · Verify attempt 1 · malformed verdict, re-running once
- 2026-07-31 21:56Z · Verify attempt 1 · 31 turns · $2.377 · failed: bad_verdict
  - bad_verdict: SessionEnd hook [node "${CLAUDE_PLUGIN_ROOT}/scripts/session-lifecycle-hook.mjs" SessionEnd] failed: Hook cancelled
- 2026-07-31 22:22Z · Verify attempt 1 · malformed verdict, re-running once
- 2026-07-31 22:22Z · Verify attempt 1 · 1 turns · $0.000 · failed: bad_verdict
- 2026-07-31 22:35Z · Verify attempt 1 · ? turns · $0.000 · failed: cli_missing
- 2026-07-31 22:39Z · Verify attempt 1 · malformed verdict, re-running once
- 2026-07-31 22:39Z · Verify attempt 1 · 1 turns · $0.000 · failed: bad_verdict
- 2026-07-31 22:47Z · Verify attempt 1 · malformed verdict, re-running once
- 2026-07-31 22:47Z · Verify attempt 1 · 1 turns · $0.000 · failed: bad_verdict
- 2026-07-31 23:26Z · Verify attempt 1 · malformed verdict, re-running once
- 2026-07-31 23:26Z · Verify attempt 1 · 1 turns · $0.000 · failed: bad_verdict
- 2026-07-31 23:40Z · Verify attempt 1 · 0 turns · $0.000 · infrastructure: Codex verification infrastructure: codex in /Users/irvinbowman/web dev/TODOMD/.todomd/worktrees/task-0024 exited 1; stderr: Reading additional input from stdin... 2026-07-31T23:40:29.360113Z WARN codex_core_skills::loader: ignoring interface.icon_small: icon path with '..' must resolve under plugin assets/ 2026-07-31T23:40:29.360232Z WARN cod; no final message or structured output; no valid verdict
- 2026-07-31 23:40Z · Verify attempt 1 · malformed verdict, re-running once
- 2026-07-31 23:40Z · Verify attempt 1 · 0 turns · $0.000 · infrastructure: Codex verification infrastructure: codex in /Users/irvinbowman/web dev/TODOMD/.todomd/worktrees/task-0024 exited 1; stderr: Reading additional input from stdin... 2026-07-31T23:40:34.349310Z WARN codex_core_skills::loader: ignoring interface.icon_small: icon path with '..' must resolve under plugin assets/ 2026-07-31T23:40:34.349329Z WARN cod; no final message or structured output; no valid verdict
  - bad_verdict: Codex verification infrastructure: codex in /Users/irvinbowman/web dev/TODOMD/.todomd/worktrees/task-0024 exited 1; stderr: Reading additional input from stdin... 2026-07-31T23:40:34.349310Z WARN codex_core_skills::loader: ignoring interface.icon_small: icon path with '..' must resolve under plugin assets/ 2026-07-31T23:40:34.349329Z WARN cod; no final message or structured output; no valid verdic
