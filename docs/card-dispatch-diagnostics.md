# Card and Queue diagnostics

Follow-up to `f6a2dac` on `codex/card-tldr-agent-prompt`.

## Malformed frontmatter

An unquoted title such as `title: Dispatch: repair queue` produces a YAML parse error. Previously `loadBoard` discarded the reason and substituted a filename ID; a subsequent cached parse lost the original error location. Approval then checked the missing status and misleadingly asked the operator to approve a plan first.

Card parsing now bypasses gray-matter's failed-result cache. Both board and card responses preserve `parseError` and `parseErrorDetail` (`line`, `column`, `reason`). Standard `task-NNNN` IDs are recovered from filenames without trusting partially parsed YAML. Errors name the card, file, and one-based source line. Approval and other card mutations reject malformed YAML with `code: frontmatter_parse_error` before workflow checks. Card GET remains readable so the drawer can display the error and raw content; cancellation and deletion remain available.

The card face and drawer display the error. Plan/Triage prompts preserve existing titles and require valid, quoted YAML strings. Their finalizers re-read the resulting card and refuse successful finalization if it is malformed. Existing board-generated strings continue using the board's serialization/sanitization helpers. Invalid agent edits are preserved for correction, not guessed at or silently rewritten. The parse-error banner clears when the file is repaired or removed.

## Dependency references

Each board card and card GET response includes `dependencyIssues`:

- `missing`: IDs that do not name an existing card, such as `P1-01`.
- `waiting`: existing unfinished dependencies with their current status.
- `unparseable`: existing dependency files whose YAML cannot be read.

Resolution includes archived cards, so archived Done dependencies remain satisfied. The UI shows configuration errors separately from ordinary waits, including on cards without a parent epic. Approval returns distinct error codes: `unknown_dependencies`, `waiting_dependencies`, and `unparseable_dependencies`.

Queue kick, boot, and resume admission now apply these dependency checks too. First-Build scheduler admission revalidates the card while it waits for capacity, so an intervening file edit cannot bypass the dependency gate. The existing project file watcher rechecks Queue work when dependencies change.

## Queue admission results

`POST /api/queue/kick` retains `ok` and `enqueued` and adds a `cards` array. `enqueued` means submitted to the scheduler, not necessarily started. Each entry includes `id`, `file`, observed `status`, `enqueued`, `code`, and a readable `reason`; dependency/parse details and the current scheduler state are included when available.

Codes cover `enqueued`, `already_queued`, `running`, `paused`, `quota_paused`, `budget_mode`, `epic_tracker`, `split_required`, `frontmatter_parse_error`, and the dependency codes above. Scheduler resource deferrals remain visible in the entry's `scheduler` snapshot. Pause/quota/budget refusal retains the existing HTTP 400 contract and adds per-card diagnostics. Successfully inspecting a queue with blocked cards can return HTTP 200 and `enqueued: 0`, with concrete reasons for those cards.

Malformed files are included even though their status cannot be trusted. Active Build/CI/Verify cards are included to explain deduplication. Archived and unrelated valid cards are omitted. The Run Queue UI surfaces returned reasons instead of saying “queue already up to date” for a blocked queue.

## Validation and operator check

Regression tests cover repeated failed reads and exact line/column reporting, corrected YAML, approval/API diagnostics, malformed Plan/Triage output, unknown vs unfinished vs unparseable dependencies, archived Done references, pause, deduplication, capacity waits, and dependency edits before admission. Browser checks cover card and drawer error text. The final `npm test` run passed all 633 core/integration tests and 35 browser tests, with zero failures or skips. An earlier Chrome-control timeout passed on isolated retry and in the final full run. Isolated agent-browser visual checks confirmed readable card/drawer diagnostics, separate missing-reference and ordinary-wait messages, and no browser errors. `git diff --check` passed. No TypeScript changed, so no typecheck was needed.

No production restart or product-repository changes are part of this branch. After the operator's normal idle-window restart, use a disposable board to reproduce the three cases: an unquoted embedded colon, a nonexistent dependency ID, and a paused/blocked Queue kick. Confirm the card/drawer and API agree on the cause. Quote the title or correct the dependency ID, then verify the diagnostic clears and normal admission resumes.
