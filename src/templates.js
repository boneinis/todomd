import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

const CONFIG_YML = `columns: [Review, Plan, Planned, Queue, Build, Verify, Needs Human, Done]
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
# Board-wide defaults — the bottom of the card → column → board override chain.
# A card's own agent/model wins; else the stage column's (stages.<col>.agent|
# model); else these. default_model is the fallback where a stage sets no model.
default_agent: claude
# default_model: sonnet

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
# runs on, and its tool allowlist. A stage may also pin its own agent
# (claude | codex) — the per-column tier of the override chain. A card's own
# agent/model still wins; an unset agent/model falls back to the board default.
# Edit these per-column from the board (the gear on each stage column).
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

export const CMD_PLAN = `---
description: Produce an implementation plan for a todomd task card
---

You are the todomd PLAN agent. The task id is: $ARGUMENTS

1. Locate the task file \`.todomd/tasks/<task-id>-*.md\` and read it: Description and Acceptance Criteria define the goal.
2. **If the card has a \`## Triage\` section, start from it** — an agent already produced Insight, a Proposed plan of action, and Flags. Build on that: verify its findings against the code rather than re-deriving from scratch, follow its proposed steps where they hold up (correct them where they don't), and resolve every Flag — surface any human-decision flags in your Risks.
3. Explore the codebase (read-only) to confirm/extend the above and understand exactly what must change to satisfy every acceptance criterion.
4. **Decide whether to split into sequential chunks.** If the work naturally breaks into **2 or more independent steps that each build and verify on their own** — typically because it spans separable files or layers (e.g. a DB migration, then the API wiring, then the UI + tests) — produce a chunk breakdown (step 5). If it's a single cohesive change, write one plan (step 6). When unsure, prefer a single plan; don't over-split.
5. **To split** — edit the task file (the only file you may modify), filling a \`## Chunks\` section (add it just before \`## Run Log\` if absent) and leaving \`## Implementation Plan\` empty. The section must contain exactly ONE fenced \`\`\`yaml block holding an ordered list; each item has:
   - \`title:\` a short imperative title for the chunk
   - \`plan:\` a block scalar (\`|\`) with that chunk's own numbered, concrete implementation steps (files to change, what to add where, tests to write)
   - \`criteria:\` a list of 1+ acceptance criteria, each checkable on its own by the verify command
   - \`type:\` (optional) one of fix | improvement | module | troubleshoot
   **Order matters: each chunk may assume every earlier chunk is already built and merged to the main branch.** Do NOT list dependencies — they are implicit by order. Each chunk becomes its own card that an agent builds and verifies in sequence, so keep them coarse (2-5 chunks is typical) and independently shippable.
6. **Single plan** (not splitting) — replace the empty \`## Implementation Plan\` section with:
   - Numbered, concrete steps (files to change, what to add where, tests to write)
   - A \`Risks:\` line if anything could break existing behavior (include unresolved triage Flags / human decisions)
   Leave \`## Chunks\` empty or absent.
7. Do NOT modify the YAML frontmatter, any source file, or any other task file. Do NOT implement anything. Status changes are not your job.

Finish with a one-line summary (say whether you split into N chunks or wrote a single plan).
`;

export const CMD_BUILD = `---
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

export const CMD_VERIFY = `---
description: Independently verify a todomd task card against its acceptance criteria
---

You are the todomd VERIFY agent — independent quality control with no knowledge of how the work was done. The task id is: $ARGUMENTS

You are running inside the task's git worktree containing the candidate implementation.

1. Read the task file \`.todomd/tasks/<task-id>-*.md\`: the Acceptance Criteria are your checklist.
2. Run the project's verify command and inspect the relevant code with fresh eyes.
3. Check EVERY acceptance criterion individually and skeptically — do not take the implementation's word for anything.
4. **Adversarially review the candidate's diff for bugs the acceptance criteria don't cover.** Run \`git diff main...HEAD\` to see exactly what changed, then scan it from three angles: (a) **line-by-line** — wrong/inverted conditions, off-by-one, null/undefined deref, missing \`await\`, falsy-zero treated as missing, swapped or copy-pasted variables, errors swallowed in a catch, unescaped regex metacharacters; (b) **removed-behavior** — for each deleted or replaced line, name the invariant it enforced and confirm the new code re-establishes it; (c) **cross-file** — for each changed function, check its callers and callees for a broken precondition, a changed return shape, or a new race/ordering dependency. A real, reachable bug found here is a **fail** even if every acceptance criterion is met and the tests pass — describe it in \`findings\` so the build agent can fix it.
5. Modify nothing. You are read-only except for running tests and reading git history.
6. If the verify command **cannot run at all** — a missing dependency or module, command-not-found, or a required env var / service that isn't present (as opposed to a test *assertion* failing) — report verdict=fail and set a short \`setup_error\` naming the cause. That signals the worktree is missing a gitignored file the build needs, not that the code is wrong, so it can be fixed by configuration rather than another build attempt.
7. If you genuinely **cannot decide** because a human decision is required — the spec is ambiguous or a product choice is missing (NOT a code defect you can phrase as a finding) — report verdict=fail and set a short \`question\` stating the specific decision needed. A human will answer and the build will re-run with their answer; do not guess.

Your final response must report: a boolean verdict (pass only if ALL criteria are met, the tests pass, AND no real bug surfaced in the adversarial review), a per-criterion result, a \`setup_error\` if the command couldn't run, a \`question\` if a human decision is required, and — if failing on the merits — specific, actionable findings the build agent can fix.
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
triaged: n/a (guide card)
session_id:
worktree:
verification: { attempts: 0, max_attempts: 3, last_verdict: }
---

## Description

👋 Welcome. This card is a plain markdown file at \`.todomd/tasks/task-0001-welcome.md\` — the whole board is files under \`.todomd/\`, and every move is a path-scoped git commit, so your history lives in \`git log\`. (Click the **todomd** wordmark up top for the Getting Started guide, or the **?** on any column.)

**Try the real flow with a small task** — this card is only a guide, so don't send *it* down the pipeline (it has nothing to build):

1. Click **+ card** and describe one small change you actually want in this repo.
2. It lands in **Review**, where an agent auto-annotates it with insight + a proposed plan (read the \`## Triage\` section it adds).
3. Drag it to **Plan** → an agent writes a full implementation plan. Review it in **Planned**.
4. Drag **Planned → Queue** to *approve* → an agent builds it in an isolated worktree, an independent agent verifies it, and it merges to **Done** (or stops at **Needs Human** if it needs a decision).

Those two drags — **Review→Plan** and **Planned→Queue** — are the only steps you do by hand.

## Acceptance Criteria

- [ ] Opened the Getting Started guide (click the **todomd** wordmark)
- [ ] Created a real task card with **+ card**
- [ ] Took that card all the way to **Done** (or answered it in **Needs Human**)

## Implementation Plan

## Run Log
`;

export const CMD_TRIAGE = `---
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

const CMD_DISPATCH_TMPL = `---
description: Budget-mode dispatcher — process pending todomd cards in this session
---

You are the todomd budget-mode dispatcher. Process the board in \`.todomd/\` of the current repo. All work happens in THIS session (or its subagents) so it bills to the interactive subscription pool. First read \`.todomd/config.yml\` (verify_command, max_attempts, worktree_dir, branch_prefix).

Skip any card whose frontmatter \`agent:\` is not claude — the launcher handles those vendors.

## Concurrency — one writer at a time

Another dispatcher (or the server's launcher) may run on this repo at the same time. An on-disk lock at \`.todomd/.lock\` serializes every \`.todomd\` write so they never corrupt the board, \`ACTIVE.md\`, or the git index. Use it like this:

- **LOCK** — run this and wait for it to return before any git commit that writes under \`.todomd/\` (and before *selecting* the build card in step 2):
  \`\`\`
  until mkdir .todomd/.lock 2>/dev/null; do o=$(cut -d' ' -f1 .todomd/.lock/owner 2>/dev/null); if [ -n "$o" ] && [ $(( $(date +%s) - o )) -gt 300 ]; then d=.todomd/.lock.dead.$$.$(date +%s); mv .todomd/.lock "$d" 2>/dev/null && rm -rf "$d"; else sleep 1; fi; done; printf '%s %s %s\\n' "$(date +%s)" "$(whoami)@$(hostname -s)" "$$-$(date +%s)" > .todomd/.lock/owner
  \`\`\`
- **UNLOCK** — run immediately after that commit: \`rm -rf .todomd/.lock\`

Rules: hold the lock ONLY around quick commits — **never across an agent run** (plan/build/verify); UNLOCK before you start one and LOCK again for the next commit. Whenever you LOCK to act on a card, **re-read its status first and skip if another dispatcher already advanced it** (discard your work for that card). The lock is a plain directory on disk, so it persists across your tool calls until you UNLOCK. A crashed dispatcher's lock auto-expires after 5 minutes (LOCK steals it). \`.todomd/.lock/\` is gitignored — never commit it.

### Leases — don't redo a long run another dispatcher is doing

Build *selection* is already safe (status flips to \`Build\` under the lock, so a second dispatcher sees the card is no longer \`Queue\`). But **triage and planning run a long agent step BEFORE the card's status changes**, so the status alone can't stop a second dispatcher from redoing the same work. Guard those with a **lease** in the card's frontmatter:

- \`<worker>\` = config \`coordination.worker\` if set, else the output of \`echo "$(whoami)@$(hostname -s)"\` (same identity as a coordination claim; used even when coordination is off).
- **Claim** — right after you select a card and BEFORE its long run: **LOCK**, re-check the card is still eligible and has no fresh lease, set \`lease: "<epoch-seconds> <worker>"\` (e.g. \`lease: "1781123013 alice@host"\`), commit, **UNLOCK**.
- **Skip on select** — ignore any card whose \`lease\` is set and **fresh** (age ≤ 900s) — it's already being worked. A lease older than 900s is stale (that dispatcher crashed); ignore it and reclaim. (900s comfortably exceeds a plan/triage run; it's the max time a crashed dispatcher can freeze a card.)
- **Clear** — in the same **LOCK** where you record the result (set \`triaged\`/\`status\`), also clear the lease (set \`lease:\` empty), in that one commit.

## 0. Triage (all pending)

Unless config \`triage.enabled\` is false: for each card with \`status: Review\` whose frontmatter \`triaged:\` is empty, that has no \`skill:\`, and that has no fresh lease: **LOCK**, re-check it's still untriaged and unleased, set \`lease: "<epoch> <worker>"\`, commit, **UNLOCK** (claim it). Follow \`.claude/commands/todomd-triage.md\` for it. Then **LOCK**, if \`triaged:\` is still empty set \`triaged: <today>\`, clear \`lease\`, add a Run Log line, commit, **UNLOCK** (if another dispatcher beat you, discard your result).

## 1. Plan work (all pending)

For each card in \`.todomd/tasks/*.md\` with \`status: Plan\` and no fresh lease: first **LOCK**, re-check it's still \`Plan\` and unleased, set \`lease: "<epoch> <worker>"\`, commit, **UNLOCK** (claim it so no other dispatcher plans it). Then run the plan/skill UNLOCKED and record the result under **LOCK**, clearing the lease:
- If it has \`skill: <name>\`: invoke /<name> with the card id, save output worth keeping under \`## Findings\` in the card; then **LOCK**, if status is still \`Plan\` set \`status: Review\`, clear \`lease\`, append a Run Log line, commit, **UNLOCK** (else discard).
- Otherwise follow \`.claude/commands/todomd-plan.md\` for it; then **LOCK**, if status is still \`Plan\` set \`status: Planned\`, clear \`lease\`, Run Log line, commit, **UNLOCK** (else discard). After the commit, if the card's \`## Chunks\` section is non-empty, shell out \`npx todomd fanout <id>\` — this materializes the chunk cards in Planned state and moves the epic to Planned; it then awaits your human approval (drag Planned → Queue) before its chunk children begin building.

## 2. Build work (ONE card per tick)

**Select + claim under LOCK so two dispatchers never grab the same card.** **LOCK**, then re-read the board and take the oldest card with \`status: Queue\` that does **not** have \`epic: true\` in its frontmatter (none → **UNLOCK**, skip). Cards with \`epic: true\` are epic tracker cards that complete automatically when all their chunk children are Done — never build them directly. Still holding the lock, do steps 1–3, then **UNLOCK** before building:
1. attempts = verification.attempts + 1. If attempts > max_attempts → \`status: Needs Human\`, \`needs_human_reason: attempts_exhausted\`, commit, **UNLOCK**, stop.
2. **Coordination** (only if config \`coordination.enabled\`): read \`.todomd/ACTIVE.md\` (see format below). Work out the files this card touches from its \`## Implementation Plan\`. If another worker's claim (a line whose \`worker\` differs from yours) lists any of the same files: append \`  - ⚠ file overlap: <who/which files>\` to the Run Log, and if config \`coordination.block\` is true set \`status: Needs Human\`, \`needs_human_reason: work_conflict\`, commit, **UNLOCK**, and stop. Otherwise add your claim to \`.todomd/ACTIVE.md\` (remove any existing line for this card first) and commit it, then continue.
3. Set \`status: Build\` and verification.attempts, commit. **UNLOCK.** Then create the worktree if missing: \`git worktree add <worktree_dir>/<id> -b <branch_prefix><id>\`.
4. Inside the worktree follow \`.claude/commands/todomd-build.md\` for the card (UNLOCKED — this is the long part). Never touch \`.todomd/\` inside the worktree.
5. **LOCK**, set \`status: Verify\`, commit, **UNLOCK**. Spawn a SUBAGENT (Agent/Task tool) — never verify your own work in-context — giving it the text of \`.claude/commands/todomd-verify.md\`, the card id, and the worktree path; require back: verdict pass|fail, per-criterion results, findings, and a \`setup_error\` if the verify command couldn't run at all (missing dep/file/env/service, not a test assertion).
6. **setup_error** (the verify command couldn't even run) → **LOCK**, set \`status: Needs Human\`, \`needs_human_reason: worktree_env\`, quote the cause in the Run Log with the hint "add the missing gitignored file/dep to \`worktree_link\` in .todomd/config.yml, then move the card back to Queue", commit, **release your coordination claim (step C)**, **UNLOCK**. (Don't retry — another build won't fix a missing env file.)
   **pass** → **LOCK**, then: confirm \`git diff --name-only HEAD...<branch> -- .todomd\` is empty (not empty → Needs Human, reason board_tampering, commit, release claim step C, **UNLOCK**); \`git merge --no-ff <branch> -m "chore(todomd): merge <id> (verified)"\`; remove worktree, delete branch; set \`status: Done\` + verification.last_verdict, commit; **release your coordination claim (step C)**; **UNLOCK**. Then, if the card's frontmatter has a \`parent:\` field, shell out \`npx todomd advance <parent-id>\` (outside the lock) to cascade the next chunk to Queue and allow the epic to auto-complete when all chunks are Done.
   **fail** (on the merits) → if attempts < max_attempts: fix the findings in the worktree (UNLOCKED), re-run step 5. Else **LOCK**, Needs Human as in step 1 with the findings quoted in the Run Log, **release your coordination claim (step C)**, **UNLOCK**.

### Coordination manifest — \`.todomd/ACTIVE.md\` (only if \`coordination.enabled\`)

So multiple developers don't build the same files at once. A claim is exactly two lines (note the em-dashes \`—\` and backticks; match this format so the server's launcher mode can read it too):

\`\`\`
- **<id>** — <title> — \`branch: <branch_prefix><id>\` — worker \`<worker>\` — started <UTC, e.g. 2026-06-10T14:30Z>
  - files: <comma-separated paths from the plan>
\`\`\`

\`<worker>\` = config \`coordination.worker\` if set, else the output of \`echo "$(whoami)@$(hostname -s)"\`. **Add a claim** = remove any existing line for this card, append yours, commit \`.todomd/ACTIVE.md\`. **(step C) Release** = remove your card's two lines, commit. If the file becomes empty leave the \`# Active work\` header.

## 3. Self-heal

Cards left in \`Build\`/\`Verify\` by an interrupted earlier tick: treat as Queue and re-enter step 2 (which LOCKs). Also: if \`coordination.enabled\`, under **LOCK** remove from \`.todomd/ACTIVE.md\` any claim whose card is no longer \`Queue\`/\`Build\`/\`Verify\` (a stale claim), commit, **UNLOCK**. (A crashed dispatcher's \`.todomd/.lock\` itself auto-expires after 5 minutes.)

## Rules

- Frontmatter: you may change only \`status\`, \`verification\`, \`needs_human_reason\`, \`session_id\`, \`triaged\`, \`lease\`.
- Run Log: one line per action — \`- <UTC time> · <stage> attempt N (budget) · <result>\`.
- Board commits are path-scoped to the card file: \`git commit -m "chore(todomd): <id> <from> -> <to> (<reason>)" -- .todomd/tasks/<file>\`. Code commits happen on the task branch per the build command.
- Nothing to do → reply "board idle" and finish.
`;

export function cmdDispatch(nodeBin, todomdBin) {
  return CMD_DISPATCH_TMPL.replaceAll('npx todomd', `"${nodeBin}" "${todomdBin}"`);
}

// Backward-compat shim for callers that haven't switched yet.
export const CMD_DISPATCH = cmdDispatch('npx', 'todomd');

// Gitignored runtime deps the build worktree needs symlinked so the verify
// command can actually run. node_modules is the near-universal case (kept even
// if absent, since it appears after `npm install`); we additionally detect any
// present-AND-gitignored env/dep files so a user whose tests read `.env` doesn't
// hit a wall of "Needs Human" caused purely by a missing worktree file.
const WORKTREE_LINK_CANDIDATES = [
  '.env', '.env.local', '.env.development', '.env.production', '.env.test',
  '.npmrc', '.venv', 'venv', 'vendor',
];
export function detectWorktreeLinks(repoPath) {
  const links = ['node_modules'];
  for (const name of WORKTREE_LINK_CANDIDATES) {
    if (!fs.existsSync(path.join(repoPath, name))) continue;
    try {
      execFileSync('git', ['check-ignore', '-q', name], { cwd: repoPath, stdio: 'ignore' });
      links.push(name); // present and gitignored → the worktree won't have it
    } catch { /* tracked (committed) → already in the worktree; nothing to link */ }
  }
  return links;
}

export function initProject(repoPath, { nodeBin, todomdBin } = {}) {
  const links = detectWorktreeLinks(repoPath);
  const configYml = CONFIG_YML.replace('worktree_link: [node_modules]', `worktree_link: [${links.join(', ')}]`);
  const writes = [
    ['.todomd/config.yml', configYml],
    ['.todomd/tasks/task-0001-welcome.md', WELCOME_CARD],
    ['.claude/commands/todomd-plan.md', CMD_PLAN],
    ['.claude/commands/todomd-build.md', CMD_BUILD],
    ['.claude/commands/todomd-verify.md', CMD_VERIFY],
    ['.claude/commands/todomd-dispatch.md', cmdDispatch(nodeBin ?? 'npx', todomdBin ?? 'todomd')],
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
  const extra = links.filter((l) => l !== 'node_modules');
  if (extra.length && created.includes('.todomd/config.yml')) {
    created.push(`config worktree_link: ${links.join(', ')} (auto-linked gitignored deps so the worktree can run tests)`);
  }
  return created;
}
