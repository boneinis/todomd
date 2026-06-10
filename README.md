# todomd

Markdown-native kanban for git repos. Each card is a markdown file in `.todomd/tasks/`; the board is just a view. Drag a card and the file's `status:` frontmatter changes, committed path-scoped to git — your board history is `git log`.

Phase 1 = the board. Later phases drive subscription coding agents (Claude Code, Codex, …) through Review → Plan → Build → Verify using the repo-committed commands in `.claude/commands/` (already validated end-to-end — see `spike/SPIKE-RESULTS.md`). No SDK, no API keys: only the CLIs you already have.

## Use

```bash
cd your-repo
npx todomd init    # writes .todomd/ + agent pipeline commands
npx todomd         # starts localhost server, opens the board
```

- One server, many repos: every repo you `init` appears in the project switcher.
- Live sync: edits to task files (by you, your editor, or an agent) appear on the board instantly.
- Localhost-only with a per-run session token.

## Task file

```markdown
---
id: task-0042
title: Fix login redirect loop
status: Review        # column
type: fix
priority: high
labels: [auth]
...
---

## Description
## Acceptance Criteria
- [ ] …
## Implementation Plan
## Run Log
```

Design docs: `RECOMMENDATIONS.md`. Spike evidence: `spike/SPIKE-RESULTS.md`.
