import fs from 'node:fs';
import path from 'node:path';

const CONFIG_YML = `columns: [Review, Plan, Planned, Assigned, Build, Verify, Needs Human, Done]
# mode: launcher — the todomd server spawns headless agent runs (instant,
#   bills the included headless credit pool).
# mode: budget — the server only manages the board; you run a dispatcher
#   inside an interactive session (\`/loop 2m /todomd-dispatch\`), so work
#   bills the interactive subscription pool instead.
mode: launcher
verify_command: npm test
max_attempts: 3
concurrency: 1
merge: merge            # merge | pr (pr lands in a later phase)
worktree_dir: .todomd/worktrees
# gitignored runtime deps symlinked into each build worktree so the verify
# command can run (add .env, .env.local, etc. if your tests need them)
worktree_link: [node_modules]
branch_prefix: todomd/
default_agent: claude

# Multi-developer coordination: maintain a committed .todomd/ACTIVE.md listing
# in-flight work (which card/files each worker is building), so several people
# on this repo don't overlap. Off by default.
coordination:
  enabled: false
  block: false      # true = refuse a card whose files overlap another worker's active work
  sync: false       # true = git fetch others' claims + git push your own (needs a remote)
  worker: ""        # optional name; defaults to <user>@<host>

# Auto-triage: when a card arrives in Review (UI, API, or email push), an
# agent annotates it with codebase insight + a proposed plan of action.
# The card stays in Review — the human still decides. Set enabled: false
# to turn off, or model: haiku to cut the per-card cost ~5x.
triage:
  enabled: true
  model: sonnet
  max_turns: 15

# Each pipeline stage maps a column to the command it invokes, the model it
# runs on, and its tool allowlist. Cards can override agent/model in their
# own frontmatter. Add custom columns + commands for your own stages.
stages:
  Plan:
    command: todomd-plan
    model: sonnet
    max_turns: 20
    allowed_tools: [Read, Glob, Grep, Edit]
  Build:
    command: todomd-build
    model: sonnet
    max_turns: 40
    allowed_tools:
      - Read
      - Glob
      - Grep
      - Edit
      - Write
      - "Bash(npm test:*)"
      - "Bash(node:*)"
      - "Bash(git add:*)"
      - "Bash(git commit:*)"
      - "Bash(git status:*)"
      - "Bash(git diff:*)"
  Verify:
    command: todomd-verify
    model: haiku
    max_turns: 15
    allowed_tools: [Read, Glob, Grep, "Bash(npm test:*)"]
`;

const CMD_PLAN = `---
description: Produce an implementation plan for a todomd task card
---

You are the todomd PLAN agent. The task id is: $ARGUMENTS

1. Locate the task file \`.todomd/tasks/<task-id>-*.md\` and read it: Description and Acceptance Criteria define the goal.
2. Explore the codebase (read-only) to understand exactly what must change to satisfy every acceptance criterion.
3. Edit the task file — **the only file you may modify** — replacing the empty \`## Implementation Plan\` section with:
   - Numbered, concrete steps (files to change, what to add where, tests to write)
   - A \`Risks:\` line if anything could break existing behavior
4. Do NOT modify the YAML frontmatter, any source file, or any other task file. Do NOT implement anything. Status changes are not your job.

Finish with a one-line summary of the plan.
`;

const CMD_BUILD = `---
description: Implement a todomd task card inside its dedicated worktree
---

You are the todomd BUILD agent. The task id is: $ARGUMENTS

You are running inside a dedicated git worktree branch for this task. Rules:

1. Read the task file \`.todomd/tasks/<task-id>-*.md\` for the Description, Acceptance Criteria, and Implementation Plan. Follow the plan.
2. **Never modify anything under \`.todomd/\`** — this worktree's copy of the board is read-only context; the board is owned elsewhere.
3. Implement the plan: edit/create source and test files so that every acceptance criterion is met.
4. Run the project's verify command and iterate until it passes.
5. Commit your changes on the current branch. **Follow the repository's commit conventions** — if commitlint/husky enforce Conventional Commits, use an appropriate type (\`feat:\`/\`fix:\`/\`test:\`…); include the task id in the message. Do not push, do not switch branches, do not merge.

Finish with a one-line summary of what you changed.
`;

const CMD_VERIFY = `---
description: Independently verify a todomd task card against its acceptance criteria
---

You are the todomd VERIFY agent — independent quality control with no knowledge of how the work was done. The task id is: $ARGUMENTS

You are running inside the task's git worktree containing the candidate implementation.

1. Read the task file \`.todomd/tasks/<task-id>-*.md\`: the Acceptance Criteria are your checklist.
2. Run the project's verify command and inspect the relevant code with fresh eyes.
3. Check EVERY acceptance criterion individually and skeptically — do not take the implementation's word for anything.
4. Modify nothing. You are read-only except for running tests.

Your final response must report: a boolean verdict (pass only if ALL criteria are met and tests pass), a per-criterion result, and — if failing — specific, actionable findings the build agent can fix.
`;

const WELCOME_CARD = `---
id: task-0001
title: Welcome to todomd — drag me across the board
status: Review
type: improvement
priority: low
labels: [meta]
dependencies: []
created_date: ${new Date().toISOString().slice(0, 10)}
source: ui
agent: claude
session_id:
worktree:
verification: { attempts: 0, max_attempts: 3, last_verdict: }
---

## Description

This card is a markdown file at \`.todomd/tasks/task-0001-welcome.md\`. Drag it between columns and watch the \`status:\` line change — every move is a path-scoped git commit, so your board history lives in \`git log\`.

## Acceptance Criteria

- [ ] Dragged this card to another column
- [ ] Saw the frontmatter change in the file
- [ ] Wrote a real task card of your own

## Implementation Plan

## Run Log
`;

const CMD_TRIAGE = `---
description: Triage an incoming todomd card — codebase insight + proposed plan of action
---

You are the todomd TRIAGE agent. A new card just arrived for human review. The task id is: $ARGUMENTS

1. Read the card \`.todomd/tasks/<task-id>-*.md\` (Description, Acceptance Criteria, source).
2. Investigate the codebase enough to give the human real insight: which files/modules are involved, how the relevant code works today, likely root cause (for fixes), risks and unknowns.
3. Edit the card file — **the only file you may modify** — adding a \`## Triage\` section (replace it if present) containing exactly:
   - **Insight:** 2-4 sentences on what the request actually touches and anything surprising you found.
   - **Proposed plan of action:** 3-6 numbered, concrete steps (advisory — the formal plan is written later in the Plan stage).
   - **Estimate:** S / M / L with a clause of rationale.
   - **Flags:** anything the human must decide or verify first (missing info, external dependencies, manual steps), or "none".
4. If the Description is too vague to investigate, say so in **Flags** with the specific questions to answer.
5. Never modify the YAML frontmatter, any other section, or any other file. Do not implement anything.

Finish with a one-line summary.
`;

const CMD_DISPATCH = `---
description: Budget-mode dispatcher — process pending todomd cards in this session
---

You are the todomd budget-mode dispatcher. Process the board in \`.todomd/\` of the current repo. All work happens in THIS session (or its subagents) so it bills to the interactive subscription pool. First read \`.todomd/config.yml\` (verify_command, max_attempts, worktree_dir, branch_prefix).

Skip any card whose frontmatter \`agent:\` is not claude — the launcher handles those vendors.

## Concurrency — one writer at a time

Another dispatcher (or the server's launcher) may run on this repo at the same time. An on-disk lock at \`.todomd/.lock\` serializes every \`.todomd\` write so they never corrupt the board, \`ACTIVE.md\`, or the git index. Use it like this:

- **LOCK** — run this and wait for it to return before any git commit that writes under \`.todomd/\` (and before *selecting* the build card in step 2):
  \`\`\`
  until mkdir .todomd/.lock 2>/dev/null; do o=$(cut -d' ' -f1 .todomd/.lock/owner 2>/dev/null); if [ -n "$o" ] && [ $(( $(date +%s) - o )) -gt 300 ]; then rm -rf .todomd/.lock; else sleep 1; fi; done; printf '%s %s\\n' "$(date +%s)" "$(whoami)@$(hostname -s)" > .todomd/.lock/owner
  \`\`\`
- **UNLOCK** — run immediately after that commit: \`rm -rf .todomd/.lock\`

Rules: hold the lock ONLY around quick commits — **never across an agent run** (plan/build/verify); UNLOCK before you start one and LOCK again for the next commit. Whenever you LOCK to act on a card, **re-read its status first and skip if another dispatcher already advanced it** (discard your work for that card). The lock is a plain directory on disk, so it persists across your tool calls until you UNLOCK. A crashed dispatcher's lock auto-expires after 5 minutes (LOCK steals it). \`.todomd/.lock/\` is gitignored — never commit it.

## 0. Triage (all pending)

Unless config \`triage.enabled\` is false: for each card with \`status: Review\` whose frontmatter \`triaged:\` is empty and that has no \`skill:\`, follow \`.claude/commands/todomd-triage.md\` for it. Then **LOCK**, re-read the card — if \`triaged:\` is still empty, set \`triaged: <today>\`, add a Run Log line, commit — **UNLOCK** (if another dispatcher already triaged it, discard your result).

## 1. Plan work (all pending)

For each card in \`.todomd/tasks/*.md\` with \`status: Plan\` (run the plan/skill UNLOCKED, then record the result under **LOCK** with a status re-check):
- If it has \`skill: <name>\`: invoke /<name> with the card id, save output worth keeping under \`## Findings\` in the card; then **LOCK**, if status is still \`Plan\` set \`status: Review\`, append a Run Log line, commit, **UNLOCK** (else discard).
- Otherwise follow \`.claude/commands/todomd-plan.md\` for it; then **LOCK**, if status is still \`Plan\` set \`status: Planned\`, Run Log line, commit, **UNLOCK** (else discard).

## 2. Build work (ONE card per tick)

**Select + claim under LOCK so two dispatchers never grab the same card.** **LOCK**, then re-read the board and take the oldest card with \`status: Assigned\` (none → **UNLOCK**, skip). Still holding the lock, do steps 1–3, then **UNLOCK** before building:
1. attempts = verification.attempts + 1. If attempts > max_attempts → \`status: Needs Human\`, \`needs_human_reason: attempts_exhausted\`, commit, **UNLOCK**, stop.
2. **Coordination** (only if config \`coordination.enabled\`): read \`.todomd/ACTIVE.md\` (see format below). Work out the files this card touches from its \`## Implementation Plan\`. If another worker's claim (a line whose \`worker\` differs from yours) lists any of the same files: append \`  - ⚠ file overlap: <who/which files>\` to the Run Log, and if config \`coordination.block\` is true set \`status: Needs Human\`, \`needs_human_reason: work_conflict\`, commit, **UNLOCK**, and stop. Otherwise add your claim to \`.todomd/ACTIVE.md\` (remove any existing line for this card first) and commit it, then continue.
3. Set \`status: Build\` and verification.attempts, commit. **UNLOCK.** Then create the worktree if missing: \`git worktree add <worktree_dir>/<id> -b <branch_prefix><id>\`.
4. Inside the worktree follow \`.claude/commands/todomd-build.md\` for the card (UNLOCKED — this is the long part). Never touch \`.todomd/\` inside the worktree.
5. **LOCK**, set \`status: Verify\`, commit, **UNLOCK**. Spawn a SUBAGENT (Agent/Task tool) — never verify your own work in-context — giving it the text of \`.claude/commands/todomd-verify.md\`, the card id, and the worktree path; require back: verdict pass|fail, per-criterion results, findings.
6. **pass** → **LOCK**, then: confirm \`git diff --name-only HEAD...<branch> -- .todomd\` is empty (not empty → Needs Human, reason board_tampering, commit, release claim step C, **UNLOCK**); \`git merge --no-ff <branch> -m "chore(todomd): merge <id> (verified)"\`; remove worktree, delete branch; set \`status: Done\` + verification.last_verdict, commit; **release your coordination claim (step C)**; **UNLOCK**.
   **fail** → if attempts < max_attempts: fix the findings in the worktree (UNLOCKED), re-run step 5. Else **LOCK**, Needs Human as in step 1 with the findings quoted in the Run Log, **release your coordination claim (step C)**, **UNLOCK**.

### Coordination manifest — \`.todomd/ACTIVE.md\` (only if \`coordination.enabled\`)

So multiple developers don't build the same files at once. A claim is exactly two lines (note the em-dashes \`—\` and backticks; match this format so the server's launcher mode can read it too):

\`\`\`
- **<id>** — <title> — \`branch: <branch_prefix><id>\` — worker \`<worker>\` — started <UTC, e.g. 2026-06-10T14:30Z>
  - files: <comma-separated paths from the plan>
\`\`\`

\`<worker>\` = config \`coordination.worker\` if set, else the output of \`echo "$(whoami)@$(hostname -s)"\`. **Add a claim** = remove any existing line for this card, append yours, commit \`.todomd/ACTIVE.md\`. **(step C) Release** = remove your card's two lines, commit. If the file becomes empty leave the \`# Active work\` header.

## 3. Self-heal

Cards left in \`Build\`/\`Verify\` by an interrupted earlier tick: treat as Assigned and re-enter step 2 (which LOCKs). Also: if \`coordination.enabled\`, under **LOCK** remove from \`.todomd/ACTIVE.md\` any claim whose card is no longer \`Assigned\`/\`Build\`/\`Verify\` (a stale claim), commit, **UNLOCK**. (A crashed dispatcher's \`.todomd/.lock\` itself auto-expires after 5 minutes.)

## Rules

- Frontmatter: you may change only \`status\`, \`verification\`, \`needs_human_reason\`, \`session_id\`, \`triaged\`.
- Run Log: one line per action — \`- <UTC time> · <stage> attempt N (budget) · <result>\`.
- Board commits are path-scoped to the card file: \`git commit -m "chore(todomd): <id> <from> -> <to> (<reason>)" -- .todomd/tasks/<file>\`. Code commits happen on the task branch per the build command.
- Nothing to do → reply "board idle" and finish.
`;

export function initProject(repoPath) {
  const writes = [
    ['.todomd/config.yml', CONFIG_YML],
    ['.todomd/tasks/task-0001-welcome.md', WELCOME_CARD],
    ['.claude/commands/todomd-plan.md', CMD_PLAN],
    ['.claude/commands/todomd-build.md', CMD_BUILD],
    ['.claude/commands/todomd-verify.md', CMD_VERIFY],
    ['.claude/commands/todomd-dispatch.md', CMD_DISPATCH],
    ['.claude/commands/todomd-triage.md', CMD_TRIAGE],
  ];
  const created = [];
  for (const [rel, content] of writes) {
    const abs = path.join(repoPath, rel);
    if (fs.existsSync(abs)) continue; // never clobber an existing board
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, content);
    created.push(rel);
  }
  const gi = path.join(repoPath, '.gitignore');
  let cur = fs.existsSync(gi) ? fs.readFileSync(gi, 'utf8') : '';
  for (const line of ['.todomd/worktrees/', '.todomd/runs/', '.todomd/.lock/']) {
    if (!cur.includes(line)) {
      cur += (cur && !cur.endsWith('\n') ? '\n' : '') + line + '\n';
      created.push(`.gitignore (+${line})`);
    }
  }
  fs.writeFileSync(gi, cur);
  return created;
}
