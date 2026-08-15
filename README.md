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
- Email → board: built-in **IMAP polling** (`~/.todomd/intake.json` + `todomd intake-test`) turns inbox mail into Review cards with attachments; or a zero-infra cloud-routine recipe. Inbound mail is **screened** first — marketing/automated mail never makes a card, ambiguous mail (bounces, out-of-office, a body too thin to act on) is held in **Needs Human** rather than dropped, and every decision is logged to `.todomd/intake-audit.jsonl`. See `docs/email-intake.md`.

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
- `stages: { Plan|Build|Verify|<custom>: { command, model, max_turns, allowed_tools } }` — per-column command/model/tool routing. Per-card `agent:` / `model:` / `skill:` frontmatter overrides these. Keep the shipped tool scoping (Plan's Edit confined to the cards dir; no broad Bash rules in Build) — see `docs/security.md`; runs resolve these executable keys from the committed config (`HEAD:`), so a pull or a mid-run edit can't arm a run in flight.
- **Column prompts** are the `.claude/commands/todomd-*.md` files each column runs (`$ARGUMENTS` = task id). Edit them in the **⚙** panel in the board (or directly in your editor) to change what an agent does in a stage — add project conventions, change the verify checklist, etc. Committed, so they travel with the repo. The **⚙** editor has two boxes: *shared* edits the committed file (public if your remote is), while *local only* writes `.todomd/local/<command>.md`, which is gitignored and never leaves this machine — put client names, internal URLs and other private context there. It's appended to the stage prompt at run time. See `docs/security.md`.

todomd commits use a `chore(todomd):` prefix and `--no-verify` so they pass (or bypass) commitlint/lint-staged/secret-scan — they touch only `.todomd/`, while your *agents'* code commits run your git hooks normally. Automation lanes (loop, cloud routines, cron, Codex): `docs/automations.md`. Email intake: `docs/email-intake.md`.

**Secrets on disk:** `~/.todomd/` holds the access token (`token*`, mode 0600) and, for IMAP intake, `intake.json` (set it `chmod 600`). Nothing there is committed to any repo.

> **Network exposure:** the server's main listener is **always loopback-only** (`127.0.0.1`). Mobile/QR access runs on a **separate LAN listener you toggle from the board** (the ▦ button → "enable network access") or start with `todomd --lan` — turning it off closes that listener entirely. It serves plain **HTTP** for the QR links: a read-only **monitor** link and an opt-in full-control link (clearly marked). Enabling/disabling requires the desktop session (a phone can't). Use only on trusted networks; for remote access put it behind a VPN/Tailscale. Revoke device links with `todomd revoke`.

## MCP server (agent tool access)

`bin/todomd-mcp.js` exposes the board over the [Model Context Protocol](https://modelcontextprotocol.io) as a stdio server, so Claude, Codex, or any MCP-capable agent can read and drive the board through reliable tools instead of shelling out to `curl`. It's a thin HTTP client of the *running* `todomd serve` process — every tool calls the same routes the web UI does — rather than a second importer of `board.js`/`pipeline.js`. That's not just style: run/queue state only exists in the memory of the one process that's actually driving the pipeline, so **`todomd serve` must already be running** for these tools to see or change anything real.

**Auth.** File-sourced plugin access uses dedicated credentials: `~/.todomd/token-viewer` for read-only and `~/.todomd/token-control` for MCP full access. The primary browser credential (`~/.todomd/token`) is not loaded by either plugin tier. For a local plugin or private user-level MCP config, select the tier without copying any token into configuration:

```bash
todomd-mcp --access viewer  # reads only ~/.todomd/token-viewer
todomd-mcp --access full    # reads only ~/.todomd/token-control
```

`--access` ignores inherited `TODOMD_MCP_TOKEN`, `TODOMD_MCP_URL`, and `TODOMD_MCP_PORT` values. It cannot be combined with `--token`, `--url`, or `--port`. Before sending the selected credential, it requires a protected `~/.todomd/server.pid` file and verifies the live loopback server's per-process nonce through a credential-free health request. A missing, stale, malformed, permission-broad, or mismatched identity fails closed. Existing explicit-token clients may continue to use `--token <value>` or `TODOMD_MCP_TOKEN` and their explicit endpoint settings:

```bash
TODOMD_MCP_TOKEN=$(cat ~/.todomd/token) todomd-mcp
```

`npm i -g github:boneinis/todomd` (see [Install](#install)) puts `todomd-mcp` on your PATH alongside `todomd`. From a git clone instead, run `node /path/to/todomd/bin/todomd-mcp.js` — there's no published npm package, so `npx todomd-mcp` will not resolve.

**Finding the running server.** `--access` always uses the nonce-verified loopback process recorded in `~/.todomd/server.pid`; endpoint overrides are deliberately unavailable on this credential path. Legacy explicit-token clients can override the default endpoint with `--url <http://host:port>`/`TODOMD_MCP_URL`, or `--port <port>`/`TODOMD_MCP_PORT` for a local server.

**Full-control approval.** Installing or enabling a full-access MCP server does not enable mutations. Every non-GET request made with `token-control` is rejected until a person opens a short-lived server-side approval window:

```bash
todomd control-enable --minutes 5   # 1–15 minutes
todomd control-status
todomd control-disable              # close it early
```

The approval expires automatically and does not affect the primary browser or mobile credentials. Run `todomd revoke` to rotate device/viewer/control credentials and clear the approval; add `--full` to rotate the primary browser credential too. Restart the board after revocation. For token-free startup logs, use `todomd serve --no-open --safe-output`.

**Read tools** (either tier): `list_projects`, `get_board`, `get_run_state`, `get_card`, `get_card_file`. Attachment reads are capped at 2 MiB before MCP base64 expansion. **Full-access-only tools**: `list_commands` (reads stage routing) and every write tool — `create_card`, `move_card`, `assign_card`, `retry_verify`, `cancel_card`, `archive_card`. `archive_card` always requires an explicit boolean `archived` value; omission is rejected. A viewer session simply doesn't see the full-access tools listed, while the running server enforces the credential and current control approval on every request. Every card/project id a tool touches goes through the HTTP API's own validation (registered-project lookup, the `task-NNNN` id format, live-run/triage guards), so an MCP call can't do anything the web UI couldn't.

**Connecting a client.** Point an MCP-capable agent at the stdio command. Prefer a viewer connection and elevate through a separate, deliberately installed configuration only when board mutations are required:

```json
{
  "mcpServers": {
    "todomd-viewer": {
      "command": "todomd-mcp",
      "args": ["--access", "viewer"]
    }
  }
}
```

Keep explicit tokens in a private shell environment or user-local MCP scope; never paste a full-control token into a project-scoped `.mcp.json` or commit it. Legacy clients can export `TODOMD_MCP_TOKEN="$(cat ~/.todomd/token-viewer)"` and omit `args`. From a git clone, use `"command": "node", "args": ["/path/to/todomd/bin/todomd-mcp.js", "--access", "viewer"]` instead.

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
