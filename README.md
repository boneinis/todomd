# todomd

Markdown-native kanban for git repos that **drives coding agents through a verified pipeline** — using the authenticated provider CLIs you already run. The server invokes Claude, Codex, or the configured Gemini gateway without embedding provider credentials.

Each card is a markdown file in `.todomd/tasks/`; the board is just a view. Two human drags take a card from idea to merged code:

```
Review ──drag──▶ Plan ──auto──▶ Planned ──drag──▶ Queue ──auto──▶ Build ──▶ CI ──▶ Verify ──▶ Done
                 (plan agent      (human            (worktree, build agent,   independent   merge,
                  writes plan)     approves)         preserved checkpoints)   test gate +   verdict/prune
                                                          ▲                    review
                                                          └──── retry w/ findings ◀── fail (≤ max_attempts,
                                                                                         then → Needs Human)
```

Every transition is a path-scoped git commit — board history is `git log`. Run logs stream live to the browser; per-card and monthly costs are tracked from the CLI's own envelopes.

> **Board history is repository content, not a privacy boundary.** `.todomd/tasks/*.md` and `.todomd/config.yml` are intentionally tracked, so they are visible on every public remote and in Git history. Gitignore cannot hide files that have already been committed. This repository uses CODEOWNERS plus a required pull-request check to reject external task-file edits, but sensitive operational work belongs in a private repository or a separate private board.

## Prerequisites

- **Node ≥ 20** and **git** (each board change is a git commit — run `todomd init` inside a git repo).
- A logged-in **agent CLI** — **`claude`** (the default) and/or **`codex`**; install whichever you'll use and run it once to sign in (`claude`, or `codex login`). Set the default with `default_agent` in `.todomd/config.yml`, or choose per card. todomd never sees your credentials; it spawns the CLIs you've already authenticated.

> **Provider routes are explicit.** `claude`, `codex`, and `gemini` are supported; unsupported or cross-provider model selections fail closed before a run starts. Every Build provider reaches the same independent **CI** and **Verify** stages. Set a card's Build provider with `agent:` frontmatter or a column's `stages:` config; the Verify column remains authoritative so a card-level Build override cannot replace the independent verifier.

## Install

Not on npm — install straight from this repo:

```bash
npm i -g github:boneinis/todomd     # puts `todomd` on your PATH
```

Or run it without installing: `npx github:boneinis/todomd init`. Either way you
get whatever is on `main` at install time (there's no published version to pin
to yet) — re-run the install to update, and `todomd upgrade-commands` refreshes
an existing board's pipeline prompts.

## Use

```bash
cd your-repo        # must be a git repo
todomd init         # writes .todomd/ + the agent pipeline commands
todomd              # localhost server + browser board (per-run token)
```

On first open the board shows a **Getting Started** guide (the flow, the two human gates, and how to add work) — reopen it anytime by clicking the **todomd** wordmark, or hit the **?** on any column header for what that column does.

**Desktop launcher (optional):** `todomd install-launcher` puts a double-clickable, **icon'd** launcher on your Desktop (a `.app` on macOS, a `.desktop` entry on Linux). It starts the server in the background if it isn't already running and opens the board — no terminal needed. `todomd stop` stops a background server.

> **macOS and Linux only.** Windows isn't supported: npm installs agent CLIs as `.cmd` shims, and Node refuses to spawn those without `shell: true` ([CVE-2024-27980](https://nodejs.org/en/blog/vulnerability/april-2024-security-releases)), so the pipeline can't start `claude` or `codex` there at all. A `.bat` launcher is still written for completeness, and the board itself will serve — but no stage will run. CI keeps a manual `windows (exploratory)` workflow for whoever picks this up; expect a wall of `until()` timeouts until the spawn path is fixed.

- **+ card** in the UI (or any editor — cards are just files; agents and humans coexist via the file watcher).
- **Attach files** to a card (＋ file in the drawer, or drag-drop): images render inline, docs become links. Stored in `.todomd/attachments/<id>/` and committed — so a screenshot or spec travels with the card, and plan/build agents can **read** it (e.g. attach a bug screenshot and the agent sees it).
- One server, many repos: add/remove projects from the **⊕** button next to the project switcher (paste a repo's path — it's scaffolded and registered), or from the CLI with `todomd init` inside the repo.
- Per-column **model/skill routing** in `.todomd/config.yml` (`stages:` block): which command each column invokes, on which model, with which tools. Per-card overrides via `agent:` / `model:` frontmatter.
- Safety: localhost-only + token; humans can't drop cards into orchestrator-only columns; agents can't touch the board from worktrees (tampering guard); an independent CI stage blocks completion when tests fail; attempt cap then **Needs Human** with a recorded reason; reconcile-on-boot catches orphaned runs.
- **Recovery agent:** open a Needs Human card and click **review & process**. A tool-less reviewer reads the card and latest run, then either resumes preserved Build work, retries infrastructure-only CI/Verify, returns substantive findings to a fresh repair Build with a durable handoff, or holds for a real human decision. One click permits one high-confidence, server-revalidated action—there is no recursive retry loop or silent attempt-cap growth.
- Email → board: built-in **IMAP polling** (`~/.todomd/intake.json` + `todomd intake-test`) turns inbox mail into Review cards with attachments; or a zero-infra cloud-routine recipe. Inbound mail is **screened** first — marketing/automated mail never makes a card, ambiguous mail (bounces, out-of-office, a body too thin to act on) is held in **Needs Human** rather than dropped, and every decision is logged to `.todomd/intake-audit.jsonl`. See `docs/email-intake.md`.

**Delivery workflow preview:** `todomd delivery-preview /path/to/repo` shows proposed
delivery states and migration issues without modifying cards or starting agents.
Add `--json` for structured output. Legacy Done cards keep deployment **unknown**.
See the [foundation contract](docs/delivery-foundation.md) and
[implementation plan](docs/delivery-workflow-update-plan.md).

**Delivery mutations:** migrated tasks use a private canonical record; the board
and drawer project its current state while Markdown remains the authored source.
Delivery actions require a scoped owner credential from `todomd delivery-access`
in addition to board access. Paste it into the drawer's **owner credential** field;
it is kept only in the open page. Assignment and blocker resolution require
handoff evidence and a next action. Commands check the current revision and reuse
their idempotency key on retry. Unsupported transitions and missing candidate,
review, integration, or deployment evidence are rejected, never inferred as success.

`todomd delivery-rollback /path/to/repo` checks for active writers and unreleased
execution ownership before restoring legacy operation. Inactive private records
are archived under the project's private delivery store `history/` directory.
Changed source files or unresolved execution require reconciliation first.

## Task file

```markdown
---
id: task-0042
title: Fix login redirect loop
status: Review            # the column (orchestrator-managed in the pipeline)
type: fix                 # fix | improvement | module | troubleshoot
priority: high
labels: [auth]
dependencies: [task-0038] # gates approval
agent: claude             # vendor routing
model: opus               # optional per-card model override
verification: { attempts: 0, max_attempts: 3, last_verdict: }
cost_usd: 0
---

## Description
## Acceptance Criteria
- [ ] …                   # the verifier's checklist
## Implementation Plan    # written by the plan agent
## Run Log                # one orchestrator line per attempt
```

## Configuring the board

Everything is in the repo's `.todomd/config.yml` (generated by `init`, with inline comments):

- `mode: launcher | budget` — **how work is billed, and how much todomd guarantees.**
  - **launcher** (default): the always-on server spawns provider CLIs directly. Usage and limits follow the selected provider and execution type. It's the well-tested path — deterministic state machine, independent CI gate, schema-validated verdict, orphan reconciliation on boot — but a busy day can still exhaust a provider's plan and park work until its limit resets.
  - **budget**: the server only manages the board; you run a dispatcher in an interactive session (`/loop 2m /todomd-dispatch`), so work bills your **interactive subscription pool** instead. It mirrors the launcher (triage → plan → build-in-worktree → independent verify → retry, with the cross-process lock + lease and the same setup-error handling), **but it only runs while that `/loop` is running** and its guarantees are prompt-enforced, not server-enforced (no Stop-hook hard gate; the server can only *nudge* if cards sit stuck). Treat it as the cheaper, lighter-touch path. See `docs/automations.md`.
- **Pause queue** in the top bar is a local operational hold: active work finishes normally, while new Build starts remain parked in Queue until you click **Resume queue**. The pause survives a board restart, does not touch task worktrees, and is kept under the gitignored `.todomd/local/` directory rather than being shared through Git.
- `verify_command` — the repo's own gate (e.g. `npm test`). It runs in the task worktree as the **CI stage** between Build and Verify for every vendor and is admitted through the scheduler's `CI` column. A failing CI stage sends the card to **Needs Human** (`ci_failed`) with the command's output and never reaches Verify; leaving it empty skips the CI stage. **Treated as trusted/executable — only board repos you trust.**
- `worktree_link` — gitignored runtime deps symlinked into each build worktree so the verify command can actually run. `init` auto-detects `node_modules` plus any present, gitignored `.env*`/`.npmrc`/`venv`; **add anything else your tests need** (a built `dist/`, a generated client, a `.env.vault`). If the verify command can't even start in the worktree, the card goes to **Needs Human** with reason `worktree_env` and the missing-file hint — a distinct signal that it's an environment gap, not an agent failure.
- `max_attempts`, `concurrency`, `merge`, `default_agent`.
- `triage: { enabled, model, max_turns }` — auto-review of incoming cards.
- `coordination: { enabled, block, sync, worker }` — maintain a committed `.todomd/ACTIVE.md` of in-flight work so multiple developers on one repo don't overlap (claims files on build start, warns/blocks on conflict, releases on finish). See `docs/coordination.md`.
- `stages: { Plan|Build|Verify|Recovery|<custom>: { command, model, max_turns, allowed_tools } }` — per-column command/model/tool routing. Recovery is always tool-less even if configured otherwise; per-card `agent:` / `model:` / `skill:` frontmatter overrides ordinary stages. A stage may also set `sandbox: false` for providers that run shell commands in a terminal sandbox — required for such a provider to commit from a worktree; see `docs/providers.md`. Keep the shipped tool scoping (Plan's Edit confined to the cards dir; no broad Bash rules in Build) — see `docs/security.md`; runs resolve these executable keys from the committed config (`HEAD:`), so a pull or a mid-run edit can't arm a run in flight.
- **Column prompts** are the `.claude/commands/todomd-*.md` files each column runs (`$ARGUMENTS` = task id). Edit them in the **⚙** panel in the board (or directly in your editor) to change what an agent does in a stage — add project conventions, change the verify checklist, etc. Committed, so they travel with the repo. The **⚙** editor has two boxes: *shared* edits the committed file (public if your remote is), while *local only* writes `.todomd/local/<command>.md`, which is gitignored and never leaves this machine — put client names, internal URLs and other private context there. It's appended to the stage prompt at run time. See `docs/security.md`.

### Verify chain

By default the `Verify` column runs **one** reviewer (`stages.Verify.{agent, model, effort, …}`): a `fail` sends the card back to Build (attempt budget `verification.max_attempts`), a `pass` merges the candidate and moves the card to Done. A `chain` runs several independent reviewers **in order on the same candidate** — the first reviewer iterates with the builder until it passes, then each later reviewer gets one final read of that exact candidate, and only the **last** reviewer's pass merges:

```yaml
stages:
  Verify:
    command: todomd-verify
    chain:
      - { agent: gemini, model: gemini-3.8-flash-high, effort: high }
      - { agent: codex,  model: gpt-6-astra,          effort: high }
```

- **Semantics.** Links run in order on one attempt: no rebuild and no re-CI between links — link N+1 spawns in the same worktree, on the same candidate commit, once link N passes. Each link is its own scheduler admission (always heavy, so a reviewer with tools never runs in a light, tool-less slot admitted under CPU pressure), and the chain is re-read from the committed config at every link, so a chain shortened or removed mid-run takes effect at the next link. A `fail` at **any** link returns the card to Build exactly as a single-reviewer fail does today (same findings hand-off, same escalation and attempt budget), and the **next attempt restarts from link 1**. A cancel, timeout, malformed verdict, `question` or `setup_error` at any link is handled exactly as it is for the single reviewer; a cancel that lands between two links reverts like a cancel before Verify spawned (worktree abandoned, attempt rolled back, card requeued).
- **Per-link keys.** `agent` (required), `model`, `effort`, `max_turns`, `allowed_tools`, `sandbox`, `workflow`, `teamwork`. Each falls back to the same key on the stage (`stages.Verify.<key>`), then to the existing defaults — the same precedence the stage itself uses, and like the stage, a link is *independent* (a card's `agent:`/`model:`/`effort:` never reaches it). `command` is shared by every link. Give every link its own `model`: a link without one inherits the column's `model`, which may belong to another provider and then fails closed as `routing_error`.
- **When `chain` is present**, `stages.Verify.agent`/`model` are not used for spawning — `chain[0]` is what runs first. They are still validated if set, and a link's missing `model`/`effort` still fall back to them.
- **Validation.** An empty `chain`, a non-list `chain`, a link without `agent`, an unsupported agent, or a model that belongs to another provider parks the card in Needs Human with `routing_error` before anything spawns (the same fail-closed path as a bad single-reviewer route). Absent `chain`, behaviour is unchanged.
- **Record.** Each link's final verdict is appended to the card's `verification.chain` as `{ link, agent, model, verdict, at }`, and the run log gets one line per link (`verdict: pass — link 1/2 (gemini/…); next: link 2/2 (codex/…)`). Intermediate passes never write `verification.last_verdict: pass` — only the last link's verdict does, so nothing downstream can mistake a half-verified candidate for an approved one. A failed link's record rides along into the repair Build; it is replaced when the next attempt's Verify starts again from link 1, and dropped whenever `attempts`/`last_verdict` are reset.

todomd commits use a `chore(todomd):` prefix and `--no-verify` so they pass (or bypass) commitlint/lint-staged/secret-scan — they touch only `.todomd/`, while your *agents'* code commits run your git hooks normally. Automation lanes (loop, cloud routines, cron, Codex): `docs/automations.md`. Email intake: `docs/email-intake.md`.

**Secrets on disk:** `~/.todomd/` holds the access token (`token*`, mode 0600) and, for IMAP intake, `intake.json` (set it `chmod 600`). Nothing there is committed to any repo.

> **Network exposure:** the server's main listener is **always loopback-only** (`127.0.0.1`). Mobile/QR access runs on a **separate LAN listener you toggle from the board** (the ▦ button → "enable network access") or start with `todomd --lan` — turning it off closes that listener entirely. It serves plain **HTTP** for the QR links: a read-only **monitor** link and an opt-in full-control link (clearly marked). Enabling/disabling requires the desktop session (a phone can't). Use only on trusted networks; for remote access put it behind a VPN/Tailscale. Revoke device links with `todomd revoke`.

## MCP server (agent tool access)

`bin/todomd-mcp.js` exposes the board over the [Model Context Protocol](https://modelcontextprotocol.io) as a stdio server, so Claude, Codex, or any MCP-capable agent can read and drive the board through reliable tools instead of shelling out to `curl`. It's a thin HTTP client of the *running* `todomd serve` process — every tool calls the same routes the web UI does — rather than a second importer of `board.js`/`pipeline.js`. That's not just style: run/queue state only exists in the memory of the one process that's actually driving the pipeline, so **`todomd serve` must already be running** for these tools to see or change anything real.

**Auth.** The server is started with one token (`~/.todomd/token` for full access, `~/.todomd/token-viewer` for read-only — the same files `todomd serve` writes) and refuses to start with anything else. Pass it as `--token <value>` or `TODOMD_MCP_TOKEN`:

```bash
TODOMD_MCP_TOKEN=$(cat ~/.todomd/token) todomd-mcp
```

`npm i -g github:boneinis/todomd` (see [Install](#install)) puts `todomd-mcp` on your PATH alongside `todomd`. From a git clone instead, run `node /path/to/todomd/bin/todomd-mcp.js` — there's no published npm package, so `npx todomd-mcp` will not resolve.

**Finding the running server.** By default it reads the port `todomd serve` recorded in `~/.todomd/server.pid`. Override with `--url <http://host:port>`/`TODOMD_MCP_URL`, or just `--port <port>`/`TODOMD_MCP_PORT` if it's local.

**Read tools** (either token): `list_projects`, `get_board`, `get_run_state`, `get_card`, `get_card_file`. **Full-access-only tools**: `list_commands` (reads stage routing) and every write tool — `create_card`, `move_card`, `assign_card`, `retry_verify`, `cancel_card`, `archive_card`. A viewer-token session simply doesn't see the full-access tools listed, and the running server enforces the same tier on every request regardless — a bad or mismatched token is a 401/403 from the real API, not a client-side guess. Every card/project id a tool touches goes through the HTTP API's own validation (registered-project lookup, the `task-NNNN` id format, live-run/triage guards), so an MCP call can't do anything the web UI couldn't.

**Connecting a client.** Point an MCP-capable agent at the stdio command. Keep the token in your shell environment or a private user/local MCP scope; never paste a full-control token into a project-scoped `.mcp.json` or commit it. For a client that expands environment variables:

```json
{
  "mcpServers": {
    "todomd": {
      "command": "todomd-mcp",
      "env": { "TODOMD_MCP_TOKEN": "${TODOMD_MCP_TOKEN}" }
    }
  }
}
```

Export `TODOMD_MCP_TOKEN="$(cat ~/.todomd/token)"` before starting the client. From a git clone, use `"command": "node", "args": ["/path/to/todomd/bin/todomd-mcp.js"]` instead. Use the viewer token for a read-only connection.

**Argument validation.** Each tool's advertised `inputSchema` is enforced before anything is dispatched: unknown properties, missing required ones, and wrong types are all refused with a message naming the offending property (no coercion — `archived: "false"` is an error, not `true`). That matters because the HTTP API underneath is a *trusted-caller* interface: `POST /api/cards` deliberately honours internal orchestrator fields (`status`, `triaged`, `plan`, …) so the Plan stage can mint chunk cards. `create_card` forwards an explicit allowlist (`title`, `description`, `type`, `priority`, `labels`, `criteria`) and nothing else, so an MCP caller can't create a card born `status: "Done"` and skip the Review → triage → build → verify flow.

## Development

`npm test` runs the suite (Node's built-in runner, no deps): unit tests for the board/frontmatter, git, registry, intake, and run-output parsing layers, plus an integration test that drives a card through the real state machine (happy path, verification-retry loop, attempt-cap escalation, transition-table guards, quota park/resume) using a deterministic fake agent — no LLM or network. Tests isolate to a temp `TODOMD_HOME` and temp git repos; they never touch your real boards. `test/ui/` adds a headless-Chrome smoke test of the board render (driven over the DevTools protocol with the `ws` dep — no Playwright); it skips itself where no Chrome is installed.

**Local CI.** `npm run ci` is the gate: the suite, the browser smoke test, `npm audit`, and a **pack → install → init → serve → stop** stage that packs the tarball, installs it into a throwaway project and exercises the running server. That last stage is the only thing that sees the *installed* artifact — unit tests import from `src/`, so they can't catch a path missing from `files`, a missing runtime dep, or a broken bin.

To gate your own pushes, opt in once per clone:

```bash
git config core.hooksPath .githooks   # pre-push runs `npm run ci -- --quick`
```

That runs everything but the browser stage (~60s idle). Bypass once with `git push --no-verify`; opt out with `git config --unset core.hooksPath`.

> Deliberately **not** wired to a `prepare` script. npm leaves a git install symlinked to its staging clone when the package has one — `npm i -g github:boneinis/todomd` produced a dangling `todomd` bin — so the convenience would have broken the documented install for everyone.

Timing note: the suite spawns git and agent CLIs, so it stretches with machine load (measured ~20x median at load 120 on 10 cores). `until()` in `test/helpers.js` scales its deadlines by `loadavg/cores` so a busy machine doesn't produce phantom failures; pin it with `TODOMD_TEST_TIMEOUT_SCALE` if you'd rather it were fixed.

What local CI can't do: tell you the code works anywhere but your machine. The `ps` probe in `todomd stop` was macOS-only and would pass here forever. For that you want the same commands on a clean Linux runner — the stages above are a single `npm run ci` line in any CI service.

### Board Agent

Use **board agent** in the desktop toolbar to choose built-in chat or your own external agent as the point of contact for selected boards. Each board keeps separate context, routine permissions and a publication policy. Review exceptions, optionally enable per-board background checks, or use the scoped MCP connection from a Codex voice task. See [Board Agent setup and behavior](docs/board-agent.md).
