# Codex Plugin Integration Plan

- **Status:** Implemented; security review remediation in verification
- **Target:** Personal Codex installation on Irvin Bowman's Mac
- **Primary plugin:** `todomd` (read-only)
- **Optional plugin:** `todomd-control` (full board control)
- **Last reviewed:** 2026-08-14

## Purpose

Package To-do MD's existing MCP server and a concise workflow skill as a
personal Codex plugin. The normal plugin must be read-only. Full board control
must remain a separately installed, explicitly invoked capability.

This plan is the build authority for the Codex plugin work. It does not replace:

- the shipped MCP usage documentation in [README.md](../README.md#mcp-server-agent-tool-access);
- the broader Codex Voice/Remote design in
  [voice-control-plan.md](voice-control-plan.md#codex-desktop-and-iphone-remote);
- the completed MCP implementation history in
  [task-0034](../.todomd/tasks/task-0034-expose-to-do-md-board-controls-through-m.md).

## Decisions

1. Build a personal marketplace plugin first. Do not create a team or public
   marketplace as part of this build.
2. Use the existing `todomd-mcp` stdio server. Do not duplicate board, API,
   pipeline, authentication, or run-state logic inside the plugin.
3. Keep the normal `todomd` plugin viewer-only.
4. Put mutation tools in a separate `todomd-control` plugin. Do not expose both
   access tiers from the same installed plugin.
5. Load token files inside `todomd-mcp`; never put a raw token in a plugin
   manifest, marketplace entry, environment block, committed file, prompt, or
   log.
6. Do not auto-start or stop the To-do MD board from the plugin. The existing
   launcher remains the owner of the board server lifecycle.
7. Do not add a custom Codex/ChatGPT app UI. The existing browser board remains
   the visual interface.
8. Do not add plugin lifecycle hooks in version 1.
9. The personal marketplace entry must use the standard defaults:
   `installation: AVAILABLE`, `authentication: ON_INSTALL`, category
   `Productivity`.
10. Build and prove the viewer plugin before starting the control plugin.

## Current baseline

Already shipped:

- `bin/todomd-mcp.js` and `src/mcp-server.js`;
- stdio JSON-RPC/MCP transport;
- viewer and full token validation;
- loopback HTTP calls into the authoritative running To-do MD process;
- read tools: `list_projects`, `get_board`, `get_run_state`, `get_card`, and
  `get_card_file`;
- full-access tools: `list_commands`, `create_card`, `move_card`,
  `assign_card`, `retry_verify`, `cancel_card`, and `archive_card`;
- focused MCP tests and README configuration documentation.

Machine findings recorded on 2026-08-14:

- `todomd` is globally linked;
- `package.json` declares `todomd-mcp`, but the global `todomd-mcp` executable
  is missing;
- Codex has no configured To-do MD MCP server or plugin;
- the recorded To-do MD server PID did not identify a live process;
- the existing Codex monitoring automation is paused.

Treat these as preflight checks, not permanent product assumptions.

## Target architecture

```text
Codex task
  |
  +-- todomd plugin
  |     +-- todomd-board skill (implicit use allowed)
  |     +-- todomd-viewer MCP process
  |           +-- todomd-mcp --access viewer
  |                 +-- ~/.todomd/token-viewer
  |                 +-- loopback To-do MD HTTP API
  |
  +-- todomd-control plugin (optional, separately installed)
        +-- todomd-control skill (explicit use only)
        +-- todomd-control MCP process
              +-- todomd-mcp --access full
                    +-- ~/.todomd/token-control
                    +-- short-lived server-side control approval
                    +-- loopback To-do MD HTTP API
```

Both MCP processes remain thin clients. The running To-do MD server continues
to own registry lookup, board state, live run state, transition guards,
authorization, validation, and mutations.

## Planned artifacts

### To-do MD repository

```text
bin/todomd-mcp.js
src/mcp-server.js
test/mcp-server.test.js
README.md
docs/codex-plugin-integration-plan.md
```

Only the MCP access-selection work, tests, and documentation belong in this
repository during the personal-plugin phase.

### Personal plugin: `todomd`

```text
~/plugins/todomd/
├── .codex-plugin/
│   └── plugin.json
├── .mcp.json
├── skills/
│   └── todomd-board/
│       ├── SKILL.md
│       └── agents/
│           └── openai.yaml
└── assets/
    └── icon.png
```

### Optional personal plugin: `todomd-control`

```text
~/plugins/todomd-control/
├── .codex-plugin/
│   └── plugin.json
├── .mcp.json
├── skills/
│   └── todomd-control/
│       ├── SKILL.md
│       └── agents/
│           └── openai.yaml
└── assets/
    └── icon.png
```

### Personal marketplace

Use the implicitly discovered personal marketplace:

```text
~/.agents/plugins/marketplace.json
```

Do not run `codex plugin marketplace add` for this default personal marketplace.
Do not hand-edit the marketplace during update/reinstall iterations; use the
plugin-creator helpers.

## Phase 0 — protect the starting state

1. Read any repository agent instructions present at implementation time.
2. Record `git status --short --branch`, current HEAD, and worktree list.
3. The repository was already ahead of `origin/main` when this plan was
   created. Preserve those commits. Do not reset, rewrite, or discard them.
4. Create an isolated feature branch or worktree from the user-approved base.
5. Confirm no other task owns `bin/todomd-mcp.js`, `src/mcp-server.js`,
   `test/mcp-server.test.js`, or `README.md`.
6. Record the current global binary targets without changing them.
7. Confirm both `~/.todomd/token` and `~/.todomd/token-viewer` exist with
   restrictive permissions. Never print their contents.

Exit gate:

- the implementation base and existing local commits are preserved;
- no overlapping work is active;
- token values have not appeared in terminal or agent output.

## Phase 1 — make MCP access selection plugin-safe

Add an explicit access selector to the existing MCP CLI:

```text
todomd-mcp --access viewer
todomd-mcp --access full
```

Required behavior:

1. `--access viewer` reads `~/.todomd/token-viewer` internally.
2. `--access full` reads the dedicated `~/.todomd/token-control` internally;
   it never loads the primary browser token.
3. `--access` must take precedence over an inherited `TODOMD_MCP_TOKEN` so a
   viewer plugin cannot accidentally inherit a full token.
4. Reject an invocation that combines `--access` with `--token`; do not guess
   which credential the caller intended.
5. Preserve the existing `--token` and `TODOMD_MCP_TOKEN` paths for backward
   compatibility when `--access` is absent.
6. Reject missing, unreadable, empty, or invalid token files with a concise
   diagnostic that names the file tier but never its contents.
7. File-sourced `--access` must ignore inherited endpoint overrides, reject
   explicit `--url`/`--port`, and verify the live loopback server from a
   protected PID/port/nonce identity file before sending any credential.
   Preserve endpoint overrides for legacy explicit-token clients.
8. Preserve the HTTP API as the authority. Do not import board or pipeline
   state into the MCP process.

Add focused coverage for:

- viewer selector lists only viewer tools;
- full selector lists viewer and full tools;
- inherited full-token environment cannot widen `--access viewer`;
- `--access` plus `--token` fails closed;
- missing or bad token files fail without leaking a value;
- legacy explicit-token startup still works;
- server-down calls preserve the actionable connection diagnostic.

Update the README MCP section with the new preferred plugin-safe invocation
while retaining the existing explicit-token examples for other clients.

Verification:

```bash
node --test test/mcp-server.test.js
npm test
npm run ci
```

Exit gate:

- viewer and full tiers are proven distinct;
- all existing MCP clients remain compatible;
- no token is copied into configuration or test output;
- the full repository gate passes.

## Phase 2 — repair and verify the installed CLI

Refresh the existing global To-do MD installation using the repository's
documented installation method. Do not install an unrelated npm package with a
similar name.

Verify:

```bash
command -v todomd
command -v todomd-mcp
```

Then confirm both commands resolve to the intended To-do MD installation and
that `todomd-mcp --access viewer` can initialize when the board server is
running.

Do not change the board, create a card, or invoke a write tool during this
phase.

Exit gate:

- both executables resolve correctly;
- the browser board still starts and stops normally;
- the viewer MCP process initializes without exposing a token.

## Phase 3 — scaffold the viewer plugin

Use the installed `plugin-creator` scaffold rather than creating the manifest
or marketplace entry by hand. From the plugin-creator skill root, run the
equivalent of:

```bash
python3 scripts/create_basic_plugin.py todomd \
  --with-skills \
  --with-mcp \
  --with-assets \
  --with-marketplace
```

Expected destination:

```text
~/plugins/todomd
```

Manifest requirements:

- `name`: `todomd`;
- strict semantic version beginning at `0.1.0`;
- clear description of read-only live board access;
- author and repository metadata from To-do MD;
- `skills`: `./skills/`;
- `mcpServers`: `./.mcp.json`;
- display name: `To-do MD`;
- category: `Productivity`;
- capabilities must not claim write access;
- no `apps` entry;
- no hooks entry;
- no placeholder values.

Recommended starter prompts:

- `Show my To-do MD board.`
- `Summarize cards that need human attention.`
- `Check the live status of task-0020.`

The `.mcp.json` must use a distinct viewer server name and must not contain a
token:

```json
{
  "mcpServers": {
    "todomd-viewer": {
      "command": "todomd-mcp",
      "args": ["--access", "viewer"],
      "tool_timeout_sec": 60
    }
  }
}
```

Reuse `public/icon.png` as the source for the plugin icon, copied into the
plugin's own `assets/` directory. Do not reference an icon outside the plugin;
Codex rejects asset paths that escape the plugin root.

Exit gate:

- the plugin scaffold validates;
- its marketplace entry is `AVAILABLE` with `ON_INSTALL` authentication;
- no raw token or machine-generated runtime file is present.

## Phase 4 — author the viewer skill

Create the skill as `todomd-board`. Keep `SKILL.md` concise and imperative.

The frontmatter description must trigger for requests to:

- inspect a To-do MD board;
- report card or run status;
- summarize Needs Human or verification findings;
- inspect attachments or recovery actions;
- monitor a card without mutating it.

Required workflow rules:

1. Use MCP tools for live state. Do not treat task markdown or cached run logs
   as the current board when MCP is available.
2. Read the project and card before reporting a conclusion.
3. Distinguish infrastructure diagnostics from code failures.
4. Report Needs Human reasons, recovery actions, and verification state
   directly.
5. Never claim Done without a live board/card read.
6. Never expose tokens, raw secrets, or protected attachment contents.
7. Do not shell out to `curl` when the MCP tool exists.
8. If the board server is stopped, report the actionable startup requirement;
   do not silently start a background service.
9. Do not attempt a write through another shell, HTTP, filesystem, browser, or
   agent path when the viewer plugin lacks a write tool.
10. For monitoring requests, report meaningful transitions only and leave all
    retries and mutations to fresh user authorization.

Generate `agents/openai.yaml` with:

- display name `To-do MD Board`;
- a 25–64 character short description;
- a default prompt that explicitly mentions `$todomd-board`;
- MCP dependency `todomd-viewer`;
- `policy.allow_implicit_invocation: true`.

Do not add a README, installation guide, changelog, scripts, or references to
the skill unless a real use case demonstrates they are needed.

Exit gate:

- the skill triggers on the intended board-status requests;
- it does not trigger for unrelated Markdown TODO files;
- it never instructs the model to mutate through a viewer connection.

## Phase 5 — validate and install the viewer plugin

Run the skill and plugin validators from their installed skill roots:

```bash
python3 /Users/irvinbowman/.codex/skills/.system/skill-creator/scripts/quick_validate.py \
  /Users/irvinbowman/plugins/todomd/skills/todomd-board

python3 /Users/irvinbowman/.codex/skills/.system/plugin-creator/scripts/validate_plugin.py \
  /Users/irvinbowman/plugins/todomd
```

Read the personal marketplace name with the plugin-creator helper, then install
the plugin using that returned name:

```bash
python3 /Users/irvinbowman/.codex/skills/.system/plugin-creator/scripts/read_marketplace_name.py
codex plugin add todomd@<returned-marketplace-name>
```

Do not add the default personal marketplace explicitly. Start a fresh Codex
task after installation so the new skill and MCP tools are loaded.

Exit gate:

- Codex lists the installed plugin;
- a fresh task exposes `todomd-viewer` tools;
- no write tool is available through this plugin.

## Phase 6 — viewer end-to-end verification

Run these checks with a running To-do MD server:

1. Ask: `Show my To-do MD board.`
2. Ask: `Summarize cards that need human attention.`
3. Ask for one known card by ID.
4. Ask for its current run state and recovery actions.
5. Read one safe test attachment.
6. Ask to move, retry, cancel, or archive the card and confirm the viewer plugin
   cannot perform the mutation.
7. Stop To-do MD and confirm the next read returns a concise server-not-running
   diagnostic.
8. Restart To-do MD and confirm reads recover without reinstalling the plugin.
9. Restart Codex or open another fresh task and confirm discovery remains
   stable.
10. Inspect configuration and logs for token leakage.

Use disposable test data for any scenario that could otherwise affect a real
project. Viewer verification itself must produce zero board mutations.

Exit gate:

- all read tools return current live state;
- write requests remain unavailable;
- server restart recovery works;
- no credentials appear in configuration, logs, or task history.

## Phase 7 — optional full-control plugin

Do not begin this phase until the viewer plugin passes Phase 6 and the owner
explicitly approves full control.

Scaffold `todomd-control` as a separate personal plugin with its own marketplace
entry. Its MCP configuration uses a distinct name:

```json
{
  "mcpServers": {
    "todomd-control": {
      "command": "todomd-mcp",
      "args": ["--access", "full"],
      "tool_timeout_sec": 60
    }
  }
}
```

The control skill must set `policy.allow_implicit_invocation: false` and require
explicit `$todomd-control` invocation.

Installing the control plugin does not enable writes. Before an authorized
mutation, the user must personally run `todomd control-enable --minutes N`
(1–15 minutes). The skill must not run that command for the user. The live
server rejects every control-token mutation outside that window, and the user
can close it early with `todomd control-disable`.

Control workflow requirements:

1. Read the live card immediately before every mutation.
2. State the exact project, card, current state, requested action, and expected
   transition.
3. Require explicit user authorization for create, move, assign, retry,
   cancel, and archive operations.
4. Use recovery actions returned by `get_card`; do not invent recovery paths.
5. Read the card again after mutation and report the observed result.
6. Never retry, cancel, archive, or move as a side effect of monitoring.
7. Never use a mutation to test whether permissions work.
8. Do not expose deletion; the current MCP server does not provide it.
9. Require `archived: true` or `archived: false`; never infer archive intent.

Verify each write tool only against a disposable repository/board fixture.
Prove the normal viewer plugin remains read-only while the control plugin is
installed.

Exit gate:

- control requires explicit invocation;
- each mutation is authorized, bounded, and read back;
- viewer access remains unchanged;
- no production or real project card was used for destructive testing.

## Phase 8 — iteration and updates

For updates to either installed local plugin:

1. Edit the local plugin source.
2. Run the plugin-creator cachebuster helper; do not manually append version
   suffixes.
3. Re-run skill and plugin validation.
4. Reinstall from the marketplace name returned by the helper flow.
5. Test in a fresh Codex task.

Do not hand-edit `marketplace.json` or Codex `config.toml` to force an update.

If the personal plugins become stable and should be distributed with To-do MD,
write and approve a separate plan for a tracked repository/team marketplace or
public plugin. Do not silently convert this personal installation into a shared
distribution channel.

## Acceptance criteria

- [ ] `todomd-mcp --access viewer` loads only the viewer token and exposes only
      read tools.
- [ ] `todomd-mcp --access full` loads only the dedicated control token and
      exposes full tools while the mutation lease remains server-gated.
- [ ] Existing explicit-token MCP clients remain compatible.
- [ ] Both global executables resolve to the intended To-do MD installation.
- [ ] The `todomd` plugin appears in Codex and validates without warnings.
- [ ] The `todomd-board` skill triggers for live board requests and not generic
      Markdown TODO requests.
- [ ] The viewer plugin can list projects, read boards/cards/run state, and
      retrieve safe attachments.
- [ ] The viewer plugin exposes no mutation tool.
- [ ] A stopped board server yields a useful diagnostic and does not start a
      hidden background process.
- [ ] Restarting the board restores access without reinstalling the plugin.
- [ ] No token appears in a plugin, marketplace file, committed file, prompt,
      log, task transcript, or test output.
- [ ] The full To-do MD test/CI gate passes after MCP changes.
- [ ] The optional control plugin is separately installed and explicitly
      invoked.
- [ ] File-sourced access verifies a protected live loopback identity and
      cannot follow inherited endpoint overrides.
- [ ] Every tested control mutation uses disposable data, explicit approval,
      and post-mutation read-back.
- [ ] Viewer behavior remains read-only when the control plugin is installed.
- [ ] Installation and rollback are documented and repeatable.

## Stop conditions

Stop the build and report the blocker if any of these occur:

- the viewer tool list contains a write-capable tool;
- a token value appears in configuration, output, logs, or Git;
- the implementation needs to bypass the loopback API or duplicate pipeline
  state;
- refreshing the global install changes or breaks the existing `todomd` CLI;
- Codex cannot keep the viewer and control MCP namespaces distinct;
- the plugin requires automatic board-server startup to function;
- the implementation base would overwrite or discard the existing local
  commits;
- validation requires hand-editing the personal marketplace or Codex config;
- full-control verification cannot be confined to disposable data.

## Rollback

1. Uninstall the affected personal plugin through Codex plugin management.
2. Stop its MCP process if it remains loaded, then start a fresh Codex task.
3. Leave `~/.todomd/token`, `~/.todomd/token-viewer`, registered projects,
   task files, run logs, worktrees, and board history untouched.
4. Revert the MCP access-selector commit through normal Git history if it
   caused a CLI regression; do not reset or rewrite unrelated commits.
5. Restore the prior global To-do MD installation only if the refreshed binary
   link is the demonstrated source of the regression.
6. Re-run the existing CLI, MCP, and board tests after rollback.

Rollback is complete when the original To-do MD CLI and browser board operate
normally, no plugin MCP process remains active, and no board data has changed.
