---
id: task-0022
title: Simplify triage and screen email intake
status: Queue
type: improvement
priority: critical
labels: [triage, email, reliability]
dependencies: []
created_date: 2026-07-31
source: ui
assignee:
agent: claude
triaged: manual bypass
session_id: 0f699ca4-a225-486a-9a35-8928d1628d82
worktree:
verification: { attempts: 0, max_attempts: 3, last_verdict: }
needs_human_reason:
cost_usd: 2.2042
epic: true
children: [task-0023, task-0024, task-0025]
---

## Description

Replace the current deep-exploration triage behavior with a lightweight routing decision. Triage must decide only whether a card is actionable, needs a technical spike, needs splitting, or needs a human decision; it must not perform full architecture planning. Keep it on Sonnet at low effort with a short bounded run. Add a separate pre-triage email screen that classifies inbound email as plausible work, spam/marketing, or unrelated/ambiguous. Spam must not create a task; unrelated or ambiguous mail must be held for human review. This bootstrap card intentionally bypasses the current auto-triage because it changes that behavior.

## Acceptance Criteria

- [ ] Normal triage returns one of actionable, technical spike, split, or needs human, with concise evidence and risks.
- [ ] Triage does not perform deep repository exploration or full implementation planning.
- [ ] The configured triage run is bounded and reports a clear reason when it cannot classify a card.
- [ ] Email intake screens inbound messages before creating normal Review cards.
- [ ] Spam and marketing messages are safely skipped with an auditable record.
- [ ] Unrelated or ambiguous messages are held for human review rather than sent to agents.
- [ ] Focused unit, API, and browser tests cover triage routing and email screening.

## Implementation Plan

## Chunks

```yaml
- title: Bound triage to a routing decision
  type: improvement
  needs: []
  plan: |
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
  criteria:
    - The generated triage command asks for exactly one of Actionable, Technical spike needed, Split into smaller cards, or Needs human decision, each with a short rationale, risks, and next step.
    - The generated triage command forbids architecture planning, broad repository exploration and Bash, and caps inspection at three directly relevant files.
    - The generated config pins triage to the sonnet model, low effort, and a bounded max_turns, and runTriage uses those values.
    - A triage run that ends successfully but leaves no recognizable decision stamps a no_decision failure reason rather than a completion date.

- title: Screen inbound email before a card exists
  type: improvement
  needs: [Bound triage to a routing decision]
  plan: |
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
  criteria:
    - screenEmail classifies a parsed message as work, spam, or unclear from its headers and body alone, and reports a reason naming the signals it matched.
    - A message screened as spam creates no card and appends exactly one audit record to the intake audit log.
    - A message screened as unclear creates a card in the Needs Human column with a human-readable reason and does not trigger triage.
    - A plausible work message still creates a normal Review card and still triggers triage.
    - The intake audit log is capped so repeated screening cannot grow it without bound.

- title: Apply the screen to the push API and surface screened mail
  type: improvement
  needs: [Screen inbound email before a card exists]
  plan: |
    1. Find the email push route in `src/server.js` (the one creating cards from
       `emailToCardFields` / with `source: email`) and run the same `screenEmail`
       verdict through it, so a pushed message gets the same three outcomes as a
       polled one. Return the verdict in the response body, with no card id for spam.
    2. Add `GET /api/projects/:name/intake-audit` following the existing route and
       auth shape in `src/server.js`, returning the most recent audit records newest
       first, with a bounded count.
    3. In `public/index.html` and `public/app.js`, add a compact Screened email list to
       the existing intake settings panel — time, sender, subject, verdict, reason,
       plus an empty state. Escape all of it; the content is untrusted.
    4. API tests in `test/server-routes.test.js` — pushing a marketing email returns
       the spam verdict and creates no card; pushing an ambiguous one creates a Needs
       Human card; the audit endpoint returns seeded records newest first.
    5. Browser test in `test/browser.js` — the screened-email list renders seeded
       records with their verdict and reason, and a held email card appears in the
       Needs Human column.

    Risks: the push route may already have its own card-creation path that bypasses
    `emailToCardFields`; if so, screen at the shared point rather than duplicating the
    logic. Browser tests skip when no browser starts, so the API test must carry the
    real assertion.
  criteria:
    - The email push API applies the same screen as mailbox polling and reports the verdict in its response.
    - A message pushed to the API and screened as spam creates no card.
    - The intake audit endpoint returns recent screened-out messages, newest first.
    - The UI lists screened email with verdict and reason, covered by a browser test.
```

## Run Log
- 2026-07-31 20:37Z · Plan · 21 turns · $1.336 · failed: agent
- 2026-07-31 20:50Z · Plan · 12 turns · $0.868 · ok
- 2026-07-31 20:50Z · Plan · split into 3 chunks (DAG): task-0023 → task-0024 → task-0025
