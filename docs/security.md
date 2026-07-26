# Access & security notes

## Token tiers

The server holds three per-machine tokens (in `~/.todomd/`, mode `0600`):

- `token` — the desktop session (full access, plus the things only the computer
  running todomd may do: enabling LAN access, minting a full-control QR).
- `token-mobile` — full access, for the opt-in control QR link.
- `token-viewer` — read-only monitor (the default QR link). Viewers can load the
  board but cannot mutate anything, read run logs, list models, or receive the
  live `run-event` WebSocket stream.

## `todomd revoke` needs a server restart

`todomd revoke` deletes `token-mobile` and `token-viewer` from disk, but a
**running** server keeps its tokens in memory — old QR links keep working until
the server restarts. After revoking, run `todomd stop` and start todomd again:
fresh tokens are minted on boot and the old links are dead.

## LAN access

The main listener is always loopback-only. Enabling LAN access (the ▦ button or
`todomd --lan`) opens a second listener on the LAN IP; turning it off closes
that listener **and** terminates any WebSocket clients that connected through
it. Use only on trusted networks.

## Pipeline hardening (prompt-injection surface)

Cards can arrive from outside the UI (git pull, email intake), so every stage
that runs without a human in the loop is confined:

- **Triage reads are repo-scoped.** The auto-fired triage agent runs with
  `allowedTools: ['Read(./**)', 'Glob', 'Grep', 'Edit(.todomd/tasks/**)']` —
  a poisoned card can't make it read `~/.ssh`, `~/.aws/credentials`, or a repo
  `.env` and write the contents into an auto-committed card. (Codex ignores the
  allowlist; its confinement is `--sandbox workspace-write` keyed on the tasks
  dir as cwd.)
- **The Plan stage's Edit is scoped to the cards dir.** The plan agent runs in
  the *main checkout* with `--permission-mode acceptEdits`, so the shipped
  default is `allowed_tools: [Read, Glob, Grep, "Edit(.todomd/tasks/**)"]`.
  Unscoped, an email-injected plan could rewrite `.todomd/config.yml`'s
  `verify_command` — which runs as a shell hook on the next build.
  **Existing repos:** update your `.todomd/config.yml` Plan `allowed_tools`
  likewise (and re-`init` won't clobber an existing config).
- **No broad Bash rules in Build.** The shipped Build allowlist drops
  `Bash(node:*)`: `node -e 'fs.writeFileSync(...)'` auto-approves and writes
  anywhere as you, defeating every other guard. Only `Bash(npm test:*)` and
  read-only/scoped `git` rules remain. Treat any broad Bash rule
  (`Bash(node:*)`, `Bash(*)`, `Bash(curl:*)`, …) as weakening the whole
  pipeline's guard set.
- **Column prompts are committed — the local layer is not.** The
  `.claude/commands/todomd-*.md` files travel with the repo by design, and the
  **⚙** editor's *shared instructions* box writes into them, so anything typed
  there is committed and pushed. Private context (client names, internal URLs,
  staging hosts) belongs in the *local only* box, which writes
  `.todomd/local/<command>.md` — gitignored (`init` adds the entry, and saving
  re-adds it if missing), never committed, and appended to the stage prompt at
  spawn time. If you push your board to a public remote, assume every word in
  the shared box is public.
- **The Stop-hook settings file is `0600`.** The `verify_command` is handed to
  the agent CLI as a temp settings file in `/tmp` (world-readable on a shared
  machine) and deleted when the run ends — it's written owner-only so no other
  user can read, or on a lax umask rewrite, a command this process runs.
- **Executable config comes from `HEAD:`, not the working tree.** The keys that
  can make something run or widen what a run may do — `verify_command` (a shell
  hook), `stages` (per-column command/model/`allowed_tools`), `default_agent`
  (codex ignores the allowlist), `worktree_link` (what gets linked into the
  worktree an agent reads) — are resolved via
  `git show HEAD:.todomd/config.yml`. A `git pull` or a mid-run agent edit
  can't arm a new shell hook or widen an allowlist for a run already in flight.
  **This holds for keys the committed config OMITS too:** `verify_command` is
  optional, so if an absent key fell through to the working tree, an injected
  edit that *adds* one would arm arbitrary shell as the next build's Stop hook.
  An omitted key falls to the code's own default instead. Operational keys
  (`mode`, `concurrency`, `max_attempts`, `columns`) still follow the working
  tree, so the board behaves the way it displays and an uncommitted
  `mode: budget` is honored rather than spending credits. Board *display*
  always reads the working tree.
  **Caveat — a repo that gitignores `.todomd/` has no committed config, so this
  guard cannot apply to it** (there is nothing in `HEAD:` to trust); the working
  tree is used, as it is before a fresh `init`'s first commit. Commit
  `.todomd/config.yml` to get the guarantee.
- **The merge never lands blind.** A card records `base_branch` when its
  worktree forks (the literal `unknown` on a detached HEAD); the merge is
  refused (`base_branch_moved` / `base_branch_unknown` → Needs Human, work
  preserved) unless HEAD still matches. After a "successful" merge, the
  branch must actually be an ancestor of HEAD or the card escalates instead
  of marking Done. The boot-time orphan sweep checks the same ancestor
  relation: merged work finishes as Done, unmerged work is KEPT (worktree +
  branch) and routed to Needs Human.
