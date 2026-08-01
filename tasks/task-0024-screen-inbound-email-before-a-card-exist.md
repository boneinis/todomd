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
session_id: 019fbaf7-0a27-7cc0-81d8-c70ea8c200d8
worktree: todomd/task-0024
verification: { attempts: 3, max_attempts: 3, last_verdict: fail }
base_branch: main
cost_usd: 16.2375
needs_human_reason: attempts_exhausted
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
- 2026-07-31 23:53Z · Verify attempt 1 · 1 turns · $0.000 · verdict: fail (unmet: 1)
  - retrying with findings (attempt 2/3)
- 2026-07-31 23:53Z · Build attempt 2 · 0 turns · $0.000 · failed: agent
  - error: error: unexpected argument '--sandbox' found

  tip: to pass '--sandbox' as a value, use '-- --sandbox'

Usage: codex exec resume --json <SESSION_ID> [PROMPT]

For more information, try '--help'.
- 2026-08-01 00:01Z · Verify attempt 2 · 1 turns · $0.000 · verdict: fail (unmet: 1)
  - escalating after 2 failed reviews: Fable diagnosis → Opus repair → final Codex gate
- 2026-08-01 00:04Z · Escalate attempt 2 · 26 turns · $2.527 · diagnosis complete
- 2026-08-01 00:08Z · Build attempt 3 · 29 turns · $1.483 · ok (escalation repair)
- 2026-08-01 00:14Z · Verify attempt 3 · 1 turns · $0.000 · verdict: fail (unmet: 1)
  - attempts_exhausted: `npm test` passed: 211 unit/integration tests and 2 UI tests. However, a reachable parser-integration bug remains: pollSource calls mailparser with its defaults, which synthesizes `parsed.text` from an HTML-only message. Consequently, src/screen.js's `!text && html` condition is false and a realistic HTML-only email with no other signal is classified as work, placed in Review, and triaged. The tes
- 2026-08-01 00:28Z · Verify attempt 3 · 1 turns · $0.000 · verdict: fail
  - attempts_exhausted: `npm test` passed outside the restricted sandbox: 212 core tests and 2 UI tests. However, a reachable regression remains in src/intake.js:33-34 and 166-167. `skipHtmlToText: true` correctly exposes HTML-only messages for screening, but `emailToCardFields` then replaces their entire body with a placeholder. A reproduced HTML-only outage report previously produced readable text (`PRODUCTION IS DOWN 
- 2026-08-01 00:36Z · Verify attempt 3 · 1 turns · $0.000 · verdict: fail (unmet: 1)
  - attempts_exhausted: 1. Official `npm test` fails: 211/212 core tests passed, but `test/intake.test.js:18` still expects the HTML-only placeholder while `src/intake.js:185-187` now returns readable HTML text. Reconcile/update this regression test. Separate UI tests passed 2/2.
2. Exact-once auditing is broken for supported `markSeen:false` mailboxes. `src/intake.js:287-303` deduplicates only by an in-memory Message-ID
- 2026-08-01 00:44Z · Verify attempt 3 · 1 turns · $0.000 · verdict: fail (unmet: 3)
  - attempts_exhausted: The unsandboxed `npm test` passed all 214 core and 2 UI tests, but adversarial review found reachable defects:

1. `src/screen.js:19` does not recognize the common bare footer phrase “View in browser.” A plain-text marketing message containing that exact phrase, with a human-looking sender, was reproduced as `work` with no signals, so it enters Review and triggers triage. Expand `FOOTER_RE` and ad
- 2026-08-01 00:57Z · Verify attempt 3 · 1 turns · $0.000 · verdict: fail (unmet: 1)
  - attempts_exhausted: `npm test` passed all 216 core and 2 UI tests outside the restricted sandbox. Adversarial review found reachable defects:

1. Exact-once handling is racy (`src/intake.js:247-295`). The handled check occurs outside the repository lock and the key is recorded only after auditing/card creation. Two overlapping pollers can both pass the check. Reproduction with concurrent calls using the same spam key
- 2026-08-01 01:04Z · Verify attempt 3 · 1 turns · $0.000 · verdict: fail (unmet: 1)
  - attempts_exhausted: The configured `npm test` passed outside the restricted sandbox: 217 core tests and 2 UI tests. `git diff --check` also passed.

Exact-once processing remains racy across processes. `src/intake.js:269` checks the durable handled file before acquiring any cross-process claim, while the `inflightIntake` map at line 324 is process-local. Two processes can both pass the check and append before either 
- 2026-08-01 01:12Z · Verify attempt 3 · 1 turns · $0.000 · verdict: fail (unmet: 1)
  - attempts_exhausted: The configured `npm test` passed all 219 core tests and 2 UI tests outside the restricted sandbox; `git diff --check` also passed.

Reachable classification bug: `src/screen.js:97-123` misclassifies a realistic bounce as spam. A parsed message from `mailer-daemon@example.com` with subject `Delivery Status Notification (Failure)` and the standard `Auto-Submitted: auto-generated` header produced `ve
- 2026-08-01 01:20Z · Verify attempt 3 · 1 turns · $0.000 · verdict: fail (unmet: 1)
  - attempts_exhausted: `npm test` passed outside the restricted sandbox: 220 core tests and 2 UI tests. However, adversarial parser-level review found reachable classification defects:

1. `src/screen.js:106` uses `text || stripHtml(html)`, so it never examines HTML when a multipart message also has a text part. A reproduced multipart marketing email from `no-reply@shop.example.com`, with ordinary plain text and an HTML
- 2026-08-01 01:27Z · Verify attempt 3 · 1 turns · $0.000 · verdict: fail (unmet: 1)
  - attempts_exhausted: The official `npm test` passed (222 core tests plus UI tests), and the worktree remained clean. However, parser-level adversarial testing found classification defects in `src/screen.js`:

1. A common Outlook bounce with subject `Delivery has failed to these recipients or groups:` and `Auto-Submitted: auto-generated` is classified as spam because `BOUNCE_SUBJECT_RE` does not recognize that wording.
- 2026-08-01 01:34Z · Verify attempt 3 · 1 turns · $0.000 · verdict: fail (unmet: 1)
  - attempts_exhausted: The official `npm test` passed outside the restricted listener sandbox: 225 core tests and 2 UI tests. `git diff --check` also passed.

Classifier defects remain in `src/screen.js`:

1. Line 19 misses common view-in-browser footer variants such as “View email in browser,” “View message in browser,” and “View this email in a browser.” A parser-level reproduction combining `no-reply@shop.example.com
- 2026-08-01 01:43Z · Verify attempt 3 · 1 turns · $0.000 · verdict: fail (unmet: 2)
  - attempts_exhausted: `npm test` passed all 227 core and 2 UI tests outside the restricted sandbox; `git diff --check` also passed. However:

1. `src/screen.js:16` misses common vacation auto-replies. A parsed email with subject `Vacation response: Export failure` and body `I am currently on vacation and will return...` was reproduced as `work` with no signals, so it would enter Review and trigger triage. Expand the au
