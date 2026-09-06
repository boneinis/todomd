# Plan metadata and pipeline recovery hardening

This change follows `fcb861c` on `codex/card-tldr-agent-prompt`. It does not restart the installed CLI server or change any product repository.

| Request | Confirmed behavior and fix | Regression coverage |
| --- | --- | --- |
| Plan complexity | The schema requires the five ordinal values, but the structured-result guard did not validate them. The guard now checks the same enum before persisting. The existing label selector also matched `chip-cx` and overrode its colors; it now targets only the six label classes. Difficulty remains independent of `build_profile` size. | All five values, invalid string, empty string, number, null, and missing value; actual schema passed to Codex; structured frontmatter persistence and `loadBoard`; Gemini agent-written frontmatter through `parseCard`/`loadBoard`; UI with and without metadata, including the computed very-high difficulty color. |
| 1: cross-vendor repair | `recordRun` overwrote the durable Build session after independent stages. The uninterrupted Build → Verify → retry chain already carries its Build session in memory; recovered/retried Verify paths read the contaminated card value. Only Build now saves `session_id`. The one-time fresh-session fallback also covers verdict/CI retries, recognizes an empty zero-turn `error_during_execution` on resume, and carries verifier findings and human instructions into the same preserved worktree and attempt. | Claude Build + Codex Verify retains the Build session; Codex/Gemini Plan preserve an existing Build session; cross-vendor fail → resume unavailable (both explicit message and empty envelope) → fresh Build → pass/Done; existing orphaned-Build fallback. |
| 2: wrong model | The runner selected the first key in aggregate `modelUsage`, which can be an auxiliary model. Telemetry now prefers the main init model, then an explicit result model/configured model; a sole usage model is a last resort, and ambiguous usage never supplies a guessed model. Live run metadata starts with the configured model and updates on init. | Haiku-first usage map with Fable init reports Fable in the normalized result, card Run Log, usage ledger, and `runs.json`; configured/unknown fallbacks when init is absent. |
| 3: file-based Queue admission | The existing tasks/config watcher only refreshed the board, triaged Review cards, and scheduled metadata sync. Its debounced callback now invokes the same project-scoped `kickQueue` used by the API, preserving deduplication, pause/quota/budget gates, dependencies, and scheduler admission. Closed/removed watchers cannot admit work. | Real isolated server: edit Planned → Queue under `withRepoLock`, reach Done without kick API, exactly one attempt; another project's Planned card remains unchanged; paused Queue stays idle until resumed. Existing scheduler/queue tests cover admission gates. |
| 4: Build profile UI | The prior commit already added the drawer row. Added a neutral `build: <profile>` card chip alongside complexity. Existing Needs Human warning-chip precedence remains intact. | Browser assertions for `cx: very-high`, `build: long`, both drawer values, and absent metadata with neither chip. |

## Validation

- `npm test`: 624 core/integration tests and 35 browser tests passed, with zero failures or skips.
- After the final CSS-only correction, `npm run test:ui`: all 35 browser tests passed again, including the computed-color regression.
- Isolated `agent-browser` visual check: both chips and drawer values render, the card without metadata has neither chip, very-high difficulty is red, and no browser errors were reported. Preview servers used disposable boards and were stopped after verification.
- `git diff --check` passed. No TypeScript files or configuration changed; no typecheck was needed.
- The live production process and the 4Upfit repository were not changed. Runtime validation against real providers remains an operator check after the idle-window restart below.

## Operator verification after an idle-window restart

The installed global CLI loads source at startup. Leave the current production `todomd serve` process running until its operator chooses an idle window, then load this branch using the normal release/link procedure and restart that server once.

1. In a disposable board, route Build to Claude and Verify to Codex. Run a card that fails its first review. Its saved `session_id` should remain the Build session. If a resumed session is unavailable, the Run Log should show one fresh fallback, the repair prompt should include the findings, and the attempt should not increment again for that fallback.
2. Compare a Build JSONL init event's `model` with the Build Run Log and usage entry. They should match even when `modelUsage` contains an auxiliary Haiku entry first. Historical entries are not rewritten.
3. Edit a disposable Planned card's frontmatter to Queue while holding the documented board lock, then release it. With admission gates open, it should start after the approximately 1.5-second watcher debounce without `POST /api/queue/kick`. Confirm a paused board still holds Queue work.
4. Run Plan through Codex and Gemini. Confirm complexity survives refresh, and inspect its chip and the Build profile chip/drawer rows. A card without these fields should have neither chip.
