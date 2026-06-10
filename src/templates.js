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
branch_prefix: todomd/
default_agent: claude

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

const BUILD_SETTINGS = `{
  "hooks": {
    "Stop": [
      {
        "hooks": [
          {
            "type": "command",
            "command": "npm test >/dev/null 2>&1 || { echo 'Stop blocked by todomd quality gate: the verify command is failing. Fix it before finishing.' >&2; exit 2; }",
            "timeout": 120
          }
        ]
      }
    ]
  }
}
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

const CMD_DISPATCH = `---
description: Budget-mode dispatcher — process pending todomd cards in this session
---

You are the todomd budget-mode dispatcher. Process the board in \`.todomd/\` of the current repo. All work happens in THIS session (or its subagents) so it bills to the interactive subscription pool. First read \`.todomd/config.yml\` (verify_command, max_attempts, worktree_dir, branch_prefix).

Skip any card whose frontmatter \`agent:\` is not claude — the launcher handles those vendors.

## 1. Plan work (all pending)

For each card in \`.todomd/tasks/*.md\` with \`status: Plan\`:
- If it has \`skill: <name>\`: invoke /<name> with the card id, save output worth keeping under \`## Findings\` in the card, set \`status: Review\`, append a Run Log line, commit.
- Otherwise follow \`.claude/commands/todomd-plan.md\` for it, then set \`status: Planned\`, Run Log line, commit.

## 2. Build work (ONE card per tick)

Take the oldest card with \`status: Assigned\` (none → skip):
1. attempts = verification.attempts + 1. If attempts > max_attempts → \`status: Needs Human\`, \`needs_human_reason: attempts_exhausted\`, commit, stop.
2. Set \`status: Build\` and verification.attempts, commit. Create the worktree if missing: \`git worktree add <worktree_dir>/<id> -b <branch_prefix><id>\`.
3. Inside the worktree follow \`.claude/commands/todomd-build.md\` for the card. Never touch \`.todomd/\` inside the worktree.
4. Set \`status: Verify\`, commit. Spawn a SUBAGENT (Agent/Task tool) — never verify your own work in-context — giving it the text of \`.claude/commands/todomd-verify.md\`, the card id, and the worktree path; require back: verdict pass|fail, per-criterion results, findings.
5. **pass** → confirm \`git diff --name-only HEAD...<branch> -- .todomd\` is empty (not empty → Needs Human, reason board_tampering); \`git merge --no-ff <branch> -m "chore(todomd): merge <id> (verified)"\`; remove worktree, delete branch; set \`status: Done\` + verification.last_verdict, commit.
   **fail** → if attempts < max_attempts: fix the findings in the worktree, re-run step 4. Else Needs Human as in step 1, with the findings quoted in the Run Log.

## 3. Self-heal

Cards left in \`Build\`/\`Verify\` by an interrupted earlier tick: treat as Assigned and re-enter step 2.

## Rules

- Frontmatter: you may change only \`status\`, \`verification\`, \`needs_human_reason\`, \`session_id\`.
- Run Log: one line per action — \`- <UTC time> · <stage> attempt N (budget) · <result>\`.
- Board commits are path-scoped to the card file: \`git commit -m "chore(todomd): <id> <from> -> <to> (<reason>)" -- .todomd/tasks/<file>\`. Code commits happen on the task branch per the build command.
- Nothing to do → reply "board idle" and finish.
`;

export function initProject(repoPath) {
  const writes = [
    ['.todomd/config.yml', CONFIG_YML],
    ['.todomd/build-settings.json', BUILD_SETTINGS],
    ['.todomd/tasks/task-0001-welcome.md', WELCOME_CARD],
    ['.claude/commands/todomd-plan.md', CMD_PLAN],
    ['.claude/commands/todomd-build.md', CMD_BUILD],
    ['.claude/commands/todomd-verify.md', CMD_VERIFY],
    ['.claude/commands/todomd-dispatch.md', CMD_DISPATCH],
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
  for (const line of ['.todomd/worktrees/', '.todomd/runs/']) {
    if (!cur.includes(line)) {
      cur += (cur && !cur.endsWith('\n') ? '\n' : '') + line + '\n';
      created.push(`.gitignore (+${line})`);
    }
  }
  fs.writeFileSync(gi, cur);
  return created;
}
