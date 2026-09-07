# Provider execution boundaries

Every stage runs one headless agent CLI. The board decides *what* a stage may
do; each CLI enforces that with its own mechanism, and those mechanisms are not
interchangeable. This page covers the ones that need an operator decision.

Two rules hold for every provider:

- **The global skip-permissions flag is never used.** A stage that cannot do its
  job under a bounded permission set is a configuration problem to fix, not a
  guard to switch off wholesale.
- **A run that was refused is a failed run.** See "Blocked runs" below.

---

## Providers with a terminal sandbox (`gemini` / the `agy` CLI)

This CLI has two independent controls, and it is easy to mistake one for the
other:

| Control | What it bounds | Where it is set |
|---|---|---|
| permission grants (`allow` / `deny`) | which shell commands and which paths the agent may touch at all | the CLI's global grant store (`config/config.json` → `userSettings.globalPermissionGrants`) |
| `--add-dir` | which directory is the agent's *workspace* (its file tools only write there) | the board passes the task worktree |
| `--sandbox` | whether an allowed command runs confined | the board (`stages.<col>.sandbox`) |

### 1. Headless mode cannot prompt, so anything unlisted is auto-denied

Interactively the CLI asks. Headlessly it cannot, so a tool call needing a
permission nobody pre-granted is refused, and the refusal is easy to miss: the
run still reports an OK status, one completed turn and **exit code 0**. The only
evidence is a `denied_actions` entry beside an empty response.

An agent typically shells out to orient itself before it does anything else, so
a git-only allow-list makes every Build die on its first step.

**Grant the exploration set as well as git, in the store the CLI actually
reads.** The grants live in the CLI's global config (`config/config.json`, under
`userSettings.globalPermissionGrants`); a `permissions` block in `settings.json`
is not consulted by current versions. Command rules match by prefix at a word
boundary (`git` matches `git add`, but not `github`), and a compound command is
checked **per segment** — `pwd && git status` needs both `pwd` and `git`
granted. File rules are path-scoped: grant the directory that holds the task
worktrees for reads *and* writes, or the file tools are refused there.

```jsonc
// config/config.json
{
  "userSettings": {
    "globalPermissionGrants": {
      "allow": [
        "command(pwd)", "command(ls)", "command(cat)", "command(find)",
        "command(grep)", "command(head)", "command(tail)", "command(wc)",
        "command(test)", "command(echo)", "command(mkdir)", "command(touch)",
        "command(sort)", "command(cut)", "command(awk)", "command(sed)", "command(diff)",
        "command(git)",
        "read_file(/path/to/repo/.todomd/worktrees)",
        "write_file(/path/to/repo/.todomd/worktrees)"
      ],
      "deny": [
        "command(npm)", "command(pnpm)", "command(yarn)", "command(npx)", "command(pip)",
        "command(docker)", "command(kubectl)", "command(psql)",
        "command(curl)", "command(ssh)", "command(sudo)",
        "command(git push)", "command(rm)"
      ]
    }
  }
}
```

Expect a short tail of one-off refusals the first few runs (`test`, `echo`, a
`stat`): each parks the card as `permission_denied` naming the command, at zero
cost, and the fix is one more `allow` line. Two shapes are refused **regardless**
of the list and cannot be granted: shell redirect/heredoc writes (the agent must
write files with its file tool, which is why the workspace registration in § 2
matters) and command substitution (`$(…)`, backticks). The board's provider note
tells the agent both; a repo command file that suggests
`git diff --check $(git merge-base …)` will still trip it, so write such steps as
two plain commands.

Notes on that shape:

- **`deny` is supported.** Its permission store carries allow/deny/ask lists, it
  persists a rule from its own "always deny" prompt, and it merges
  project-scoped grants over global ones; a denied command is documented as
  always blocked. Keep both lists. `allow` is not exhaustive — a stage prompt
  can suggest a command you did not anticipate — so a denylist for test
  runners, package managers, database clients, container tooling and anything
  that reaches the network is worth the duplication.
- **Do not allow a test runner here.** Independent CI is the board's own stage;
  it runs the verify command itself, outside the agent, on an exact clean HEAD.
  An agent that can run the suite can also report on a suite it just edited.
- **`git push` stays denied.** Merging is the board's job.
- **The board cannot inject this list per stage.** The CLI takes no
  settings-path override and no per-invocation allow-rule flag, so the
  allow/deny lists are an operator-level setting on the machine that runs the
  board, and they apply to every stage that provider runs. This is the one place
  where this provider is coarser than the board's own `allowed_tools`.

### 2. `--sandbox` is a *terminal* sandbox, and it cannot see a worktree's git

The sandbox confines shell commands. It does **not** confine the agent's own
file-editing tools — those write to the real filesystem either way. What it does
block is the repository's git metadata:

- Each task builds in a `git worktree` checkout, whose `.git` is a *file*
  pointing at `<repo>/.git/worktrees/<name>` — outside the checkout. From inside
  the sandbox that target is unreachable, so every git command fails with
  `fatal: not a git repository`. A sandboxed Build therefore cannot stage or
  commit its candidate.
- `--add-dir` of the **main repository** does not fix this. It makes the
  metadata *readable* (`git status` works) but writes are still refused
  (`Unable to create .git/index.lock: Operation not permitted`), and it
  re-points the agent's workspace at the added directory — an agent given the
  main checkout will edit files there instead of in its own task worktree, which
  is exactly what the per-task worktree exists to prevent.
- `--add-dir` of the **task worktree itself** is required, and the board always
  passes it. Headless, the CLI opens no workspace of its own, and its
  file-writing tool then only accepts paths under a private artifact directory
  (`… is not a valid artifact path`) — so without it a Build cannot write its
  candidate with the file tool at all, and falls back to shell redirects that
  the permission checker refuses. Registering the worktree makes it the
  workspace: file tools write there, and the agent stops searching the
  filesystem for "the repo".
- The only sandbox escape the CLI offers is an `unsandboxed(<command>)`
  permission grant, i.e. pre-authorising specific commands to run *outside* the
  sandbox. That is strictly more privilege than dropping the terminal sandbox
  for one stage while keeping a narrow command allow-list, so the board does not
  use it.

### 3. Two write tools, one of which cannot reach the checkout

The CLI exposes `write_file` / `replace_file_content` (workspace files) next to
`write_to_file` (its artifact tool, confined to a private directory). A model
asked to "create a file" reaches for the artifact tool often enough that a Build
would fail with `… is not a valid artifact path` and then try a shell heredoc,
which the checker refuses. The board appends a short provider note to every
prompt — the workspace path, and for Build which tool writes the checkout — so
this is handled; it is described here so the failure is recognisable if a
future CLI renames the tools.

**So: keep the sandbox on for review stages, and let Build opt out.**

```yaml
stages:
  Build:
    agent: gemini
    sandbox: false   # required for this provider to commit from a worktree
  Verify:
    agent: gemini    # sandbox stays on (the default) — Verify only reads
```

`sandbox` defaults to `true`, and the opt-out has to be explicit. `stages` is one
of the executable config keys resolved from `HEAD:`, so the opt-out only takes
effect once committed — a mid-run edit cannot widen a run already in flight.

**The trade-off, stated plainly.** With `sandbox: false` the Build's shell
commands run as your user, with your filesystem and network reach. What still
bounds them is the `allow` / `deny` grant pair above — so that
list is now the whole boundary, and it is worth keeping tight. Review stages
lose nothing by keeping the sandbox, because they never commit.

---

## Blocked runs

A stage that answered nothing and changed nothing did not do the work, however
cleanly its CLI exited. The board treats two shapes as failures rather than
successes:

- **A refused permission.** A non-empty `denied_actions` list fails the run
  regardless of the reported status or exit code. The card lands in Needs Human
  with reason `permission_denied`, and the run log names the permission that was
  refused, so the fix is an allow-rule rather than a debugging session.
- **An empty response with no worktree change.** No new commit and no edited or
  added file, plus no final text, is reason `blocked_build`. Without this an
  empty candidate would pass CI (nothing to fail) and reach the verifier looking
  like finished work.

Both preserve the worktree and branch, so the recovery is: fix the permission,
then **Resume Build** on the same card.


## Routing Build by the planner's difficulty rating

The Plan stage rates every card's implementation **difficulty** (`complexity:`
one of `trivial | low | medium | high | very-high`, judged independently of size,
which `build_profile` covers). `stages.Build.route_by_complexity` turns that
rating into a provider choice, so routine work can go to a cheaper or faster
provider without anyone touching the card:

```yaml
stages:
  Build:
    agent: claude
    model: opus
    route_by_complexity:
      trivial: { agent: gemini, model: gemini-3.8-flash-high }
      low:     { agent: gemini, model: gemini-3.8-flash-high }
      # levels not listed use the column default above
```

Precedence for Build is card → **map** → column → board:

- An explicit `agent:` on the card always wins — a human pin is never overridden.
  A card is *unpinned* when it has no agent: the create form's and the drawer's
  **auto** choice, or the API without `agent`. Choosing a provider pins it.
- The map applies only to a card that has a rating, at a listed level, with
  `build_profile: standard`. Long and split work stays on the column default.
- A map entry's `model` is authoritative for that provider; leave it out and the
  provider's own default is used. The column's `model` is never inherited across
  providers (it would fail route validation as belonging to the other family).
- Unknown levels and malformed entries are ignored, so a typo degrades to the
  routing you had before rather than parking cards. An unsupported agent or a
  model from the wrong family still parks as `routing_error`, as it does today.
- Plan, Verify and Recovery are unaffected: they remain pinned to their columns.
- A repair Build keeps the provider that built the candidate.

Each map-driven decision is written to the card's run log so it is auditable:

```
- 2026-09-07T15:40 · Build attempt 1 · routed to gemini/gemini-3.8-flash-high by complexity: low
```

`stages` is one of the executable config keys resolved from `HEAD:`, so the map
takes effect once committed. The board edits it for you: **column settings →
Build → route by difficulty** writes the block and commits it, the same way the
column's agent and model are saved. Start narrow (`trivial`/`low`), read a few
run logs, and widen on evidence.
