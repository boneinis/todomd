# Multi-developer coordination (`ACTIVE.md`)

When several developers work on the same repo, todomd can maintain a committed manifest of in-flight work so agents (and people) don't step on each other.

## What it does

With `coordination.enabled: true` in `.todomd/config.yml`, todomd keeps a committed `.todomd/ACTIVE.md`:

- When a card **starts building**, todomd adds a claim — the card, its branch, the **worker** (`<user>@<host>` by default), the start time, and the **files** it plans to touch (read from the card's `## Implementation Plan`).
- Before claiming, it checks for **overlap**: another worker's active claim that touches one of the same files. By default it logs a warning on the card and shows a board banner; with `block: true` it refuses the card (→ Needs Human, reason `work_conflict`) so you decide.
- When the card **finishes** (Done, Needs Human, or cancelled), todomd **removes** the claim.

`ACTIVE.md` is human-readable and lives in git history, so even outside todomd you can see what's being worked on:

```markdown
# Active work

- **task-0042** — Fix login redirect — `branch: todomd/task-0042` — worker `alice@macbook` — started 2026-06-10 14:30Z
  - files: src/auth.js, src/login.js
```

## Configuration

```yaml
coordination:
  enabled: true     # maintain .todomd/ACTIVE.md
  block: false      # true = refuse a card that overlaps another worker's files
  sync: false       # true = git fetch others' claims + push your own
  worker: ""        # optional; defaults to <user>@<host>
```

## Sharing across machines (`sync`)

Without `sync`, claims are committed locally — they reach teammates through your normal `git push`/`pull` of the branch. That's enough if everyone pushes/pulls regularly.

For **automatic** cross-developer coordination, set `sync: true`. Then todomd:
- `git fetch`es the current branch before each overlap check and reads teammates' claims from `origin/<branch>:.todomd/ACTIVE.md`, and
- `git push`es your claim/release commit to `origin/<branch>` (best-effort; failures are logged, never fatal).

Notes on `sync`:
- It pushes the **current branch** (which carries todomd's board commits). Use it where that's expected — typically a board kept on your default branch. If a push is rejected (someone pushed first), it's logged and retried on the next claim/release; the local manifest is still correct.
- It needs an `origin` remote and push access. Cloud-routine intake (which clones fresh) doesn't participate in `sync`.

Coordination is **advisory by design** — any error in fetching/pushing/parsing never blocks the pipeline; at worst you lose the cross-machine view for that run and fall back to local claims.

## Assigning incoming work to a developer

Cards carry an **`assignee`** (a developer name, distinct from `agent`/vendor and the build `worker`). It shows as an `@name` chip on the card and is searchable in the filter box, so each developer can type their name to see their queue.

Set it:
- **On any card** — the assignee field in the new-card modal or the card drawer's routing panel.
- **Automatically on incoming email** — give an intake board or route an `assignee` in `~/.todomd/intake.json`, so mail routed to a project (or to a specific address) is assigned to the right developer as it arrives:

```json
{
  "inboxes": {
    "main": {
      "account": "hub", "folder": "INBOX", "assignee": "lead",
      "routes": [
        { "project": "repo-a", "toMatches": "frontend@you.com", "assignee": "alice" },
        { "project": "repo-b", "toMatches": "api@you.com",      "assignee": "bob" }
      ]
    }
  }
}
```

A route's `assignee` wins; otherwise the inbox/board `assignee` applies; otherwise the card is unassigned. The card still lands in **Review** (the human gate holds) — assignment just tells everyone whose card it is. Combined with `ACTIVE.md`, that's the full picture: **assignee** says who should pick it up, the manifest prevents two people building the same files at once.
