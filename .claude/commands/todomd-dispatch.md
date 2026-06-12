---
description: Budget-mode dispatcher — process pending todomd cards in this session
---

You are the todomd budget-mode dispatcher. Process the board in `.todomd/` of the current repo. All work happens in THIS session (or its subagents) so it bills to the interactive subscription pool. First read `.todomd/config.yml` (verify_command, max_attempts, worktree_dir, branch_prefix).

Skip any card whose frontmatter `agent:` is not claude — the launcher handles those vendors.

## Concurrency — one writer at a time

Another dispatcher (or the server's launcher) may run on this repo at the same time. An on-disk lock at `.todomd/.lock` serializes every `.todomd` write so they never corrupt the board, `ACTIVE.md`, or the git index. Use it like this:

- **LOCK** — run this and wait for it to return before any git commit that writes under `.todomd/` (and before *selecting* the build card in step 2):
  ```
  until mkdir .todomd/.lock 2>/dev/null; do o=$(cut -d' ' -f1 .todomd/.lock/owner 2>/dev/null); if [ -n "$o" ] && [ $(( $(date +%s) - o )) -gt 300 ]; then d=.todomd/.lock.dead.$$.$(date +%s); mv .todomd/.lock "$d" 2>/dev/null && rm -rf "$d"; else sleep 1; fi; done; printf '%s %s %s\n' "$(date +%s)" "$(whoami)@$(hostname -s)" "$$-$(date +%s)" > .todomd/.lock/owner
  ```
- **UNLOCK** — run immediately after that commit: `rm -rf .todomd/.lock`

Rules: hold the lock ONLY around quick commits — **never across an agent run** (plan/build/verify); UNLOCK before you start one and LOCK again for the next commit. Whenever you LOCK to act on a card, **re-read its status first and skip if another dispatcher already advanced it** (discard your work for that card). The lock is a plain directory on disk, so it persists across your tool calls until you UNLOCK. A crashed dispatcher's lock auto-expires after 5 minutes (LOCK steals it). `.todomd/.lock/` is gitignored — never commit it.

### Leases — don't redo a long run another dispatcher is doing

Build *selection* is already safe (status flips to `Build` under the lock, so a second dispatcher sees the card is no longer `Queue`). But **triage and planning run a long agent step BEFORE the card's status changes**, so the status alone can't stop a second dispatcher from redoing the same work. Guard those with a **lease** in the card's frontmatter:

- `<worker>` = config `coordination.worker` if set, else the output of `echo "$(whoami)@$(hostname -s)"` (same identity as a coordination claim; used even when coordination is off).
- **Claim** — right after you select a card and BEFORE its long run: **LOCK**, re-check the card is still eligible and has no fresh lease, set `lease: "<epoch-seconds> <worker>"` (e.g. `lease: "1781123013 alice@host"`), commit, **UNLOCK**.
- **Skip on select** — ignore any card whose `lease` is set and **fresh** (age ≤ 900s) — it's already being worked. A lease older than 900s is stale (that dispatcher crashed); ignore it and reclaim. (900s comfortably exceeds a plan/triage run; it's the max time a crashed dispatcher can freeze a card.)
- **Clear** — in the same **LOCK** where you record the result (set `triaged`/`status`), also clear the lease (set `lease:` empty), in that one commit.

## 0. Triage (all pending)

Unless config `triage.enabled` is false: for each card with `status: Review` whose frontmatter `triaged:` is empty, that has no `skill:`, and that has no fresh lease: **LOCK**, re-check it's still untriaged and unleased, set `lease: "<epoch> <worker>"`, commit, **UNLOCK** (claim it). Follow `.claude/commands/todomd-triage.md` for it. Then **LOCK**, if `triaged:` is still empty set `triaged: <today>`, clear `lease`, add a Run Log line, commit, **UNLOCK** (if another dispatcher beat you, discard your result).

## 1. Plan work (all pending)

For each card in `.todomd/tasks/*.md` with `status: Plan` and no fresh lease: first **LOCK**, re-check it's still `Plan` and unleased, set `lease: "<epoch> <worker>"`, commit, **UNLOCK** (claim it so no other dispatcher plans it). Then run the plan/skill UNLOCKED and record the result under **LOCK**, clearing the lease:
- If it has `skill: <name>`: invoke /<name> with the card id, save output worth keeping under `## Findings` in the card; then **LOCK**, if status is still `Plan` set `status: Review`, clear `lease`, append a Run Log line, commit, **UNLOCK** (else discard).
- Otherwise follow `.claude/commands/todomd-plan.md` for it; then **LOCK**, if status is still `Plan` set `status: Planned`, clear `lease`, Run Log line, commit, **UNLOCK** (else discard). After the commit, if the card's `## Chunks` section is non-empty, shell out `npx todomd fanout <id>` — this materializes the chunk cards in Planned state and moves the epic to Planned; it then awaits your human approval (drag Planned → Queue) before its chunk children begin building.

## 2. Build work (ONE card per tick)

**Select + claim under LOCK so two dispatchers never grab the same card.** **LOCK**, then re-read the board and take the oldest card with `status: Queue` that does **not** have `epic: true` in its frontmatter (none → **UNLOCK**, skip). Cards with `epic: true` are epic tracker cards that complete automatically when all their chunk children are Done — never build them directly. Still holding the lock, do steps 1–3, then **UNLOCK** before building:
1. attempts = verification.attempts + 1. If attempts > max_attempts → `status: Needs Human`, `needs_human_reason: attempts_exhausted`, commit, **UNLOCK**, stop.
2. **Coordination** (only if config `coordination.enabled`): read `.todomd/ACTIVE.md` (see format below). Work out the files this card touches from its `## Implementation Plan`. If another worker's claim (a line whose `worker` differs from yours) lists any of the same files: append `  - ⚠ file overlap: <who/which files>` to the Run Log, and if config `coordination.block` is true set `status: Needs Human`, `needs_human_reason: work_conflict`, commit, **UNLOCK**, and stop. Otherwise add your claim to `.todomd/ACTIVE.md` (remove any existing line for this card first) and commit it, then continue.
3. Set `status: Build` and verification.attempts, commit. **UNLOCK.** Then create the worktree if missing: `git worktree add <worktree_dir>/<id> -b <branch_prefix><id>`.
4. Inside the worktree follow `.claude/commands/todomd-build.md` for the card (UNLOCKED — this is the long part). Never touch `.todomd/` inside the worktree.
5. **LOCK**, set `status: Verify`, commit, **UNLOCK**. Spawn a SUBAGENT (Agent/Task tool) — never verify your own work in-context — giving it the text of `.claude/commands/todomd-verify.md`, the card id, and the worktree path; require back: verdict pass|fail, per-criterion results, findings, and a `setup_error` if the verify command couldn't run at all (missing dep/file/env/service, not a test assertion).
6. **setup_error** (the verify command couldn't even run) → **LOCK**, set `status: Needs Human`, `needs_human_reason: worktree_env`, quote the cause in the Run Log with the hint "add the missing gitignored file/dep to `worktree_link` in .todomd/config.yml, then move the card back to Queue", commit, **release your coordination claim (step C)**, **UNLOCK**. (Don't retry — another build won't fix a missing env file.)
   **pass** → **LOCK**, then: confirm `git diff --name-only HEAD...<branch> -- .todomd` is empty (not empty → Needs Human, reason board_tampering, commit, release claim step C, **UNLOCK**); `git merge --no-ff <branch> -m "chore(todomd): merge <id> (verified)"`; remove worktree, delete branch; set `status: Done` + verification.last_verdict, commit; **release your coordination claim (step C)**; **UNLOCK**. Then, if the card's frontmatter has a `parent:` field, shell out `npx todomd advance <parent-id>` (outside the lock) to cascade the next chunk to Queue and allow the epic to auto-complete when all chunks are Done.
   **fail** (on the merits) → if attempts < max_attempts: fix the findings in the worktree (UNLOCKED), re-run step 5. Else **LOCK**, Needs Human as in step 1 with the findings quoted in the Run Log, **release your coordination claim (step C)**, **UNLOCK**.

### Coordination manifest — `.todomd/ACTIVE.md` (only if `coordination.enabled`)

So multiple developers don't build the same files at once. A claim is exactly two lines (note the em-dashes `—` and backticks; match this format so the server's launcher mode can read it too):

```
- **<id>** — <title> — `branch: <branch_prefix><id>` — worker `<worker>` — started <UTC, e.g. 2026-06-10T14:30Z>
  - files: <comma-separated paths from the plan>
```

`<worker>` = config `coordination.worker` if set, else the output of `echo "$(whoami)@$(hostname -s)"`. **Add a claim** = remove any existing line for this card, append yours, commit `.todomd/ACTIVE.md`. **(step C) Release** = remove your card's two lines, commit. If the file becomes empty leave the `# Active work` header.

## 3. Self-heal

Cards left in `Build`/`Verify` by an interrupted earlier tick: treat as Queue and re-enter step 2 (which LOCKs). Also: if `coordination.enabled`, under **LOCK** remove from `.todomd/ACTIVE.md` any claim whose card is no longer `Queue`/`Build`/`Verify` (a stale claim), commit, **UNLOCK**. (A crashed dispatcher's `.todomd/.lock` itself auto-expires after 5 minutes.)

## Rules

- Frontmatter: you may change only `status`, `verification`, `needs_human_reason`, `session_id`, `triaged`, `lease`.
- Run Log: one line per action — `- <UTC time> · <stage> attempt N (budget) · <result>`.
- Board commits are path-scoped to the card file: `git commit -m "chore(todomd): <id> <from> -> <to> (<reason>)" -- .todomd/tasks/<file>`. Code commits happen on the task branch per the build command.
- Nothing to do → reply "board idle" and finish.
