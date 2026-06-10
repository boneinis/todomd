# todomd

Markdown-native kanban for git repos that **drives coding agents through a verified pipeline** — on the subscriptions you already pay for. No SDK, no API keys: the server spawns the same `claude -p` commands you'd type in a terminal.

Each card is a markdown file in `.todomd/tasks/`; the board is just a view. Two human drags take a card from idea to merged code:

```
Review ──drag──▶ Plan ──auto──▶ Planned ──drag──▶ Assigned ──auto──▶ Build ──▶ Verify ──▶ Done
                 (plan agent      (human            (worktree, build agent,   independent   merge,
                  writes plan)     approves)         Stop-hook test gate)     verdict       prune
                                                                              (cheap model) worktree
                                                          ▲                        │
                                                          └── retry w/ findings ◀──┘ fail (≤ max_attempts,
                                                                                      then → Needs Human)
```

Every transition is a path-scoped git commit — board history is `git log`. Run logs stream live to the browser; per-card and monthly costs are tracked from the CLI's own envelopes.

## Use

```bash
cd your-repo
npx todomd init    # writes .todomd/ + the agent pipeline commands
npx todomd         # localhost server + browser board (per-run token)
```

- **+ card** in the UI (or any editor — cards are just files; agents and humans coexist via the file watcher).
- One server, many repos: every `init`'d repo appears in the project switcher.
- Per-column **model/skill routing** in `.todomd/config.yml` (`stages:` block): which command each column invokes, on which model, with which tools. Per-card overrides via `agent:` / `model:` frontmatter.
- Safety: localhost-only + token; humans can't drop cards into orchestrator-only columns; agents can't touch the board from worktrees (tampering guard); failing tests block agent completion (generated Stop hook); attempt cap then **Needs Human** with a recorded reason; reconcile-on-boot catches orphaned runs.
- Email → board: zero-infrastructure cloud-routine recipe in `docs/email-intake.md`.

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

Design + phase-2 spec: `RECOMMENDATIONS.md`. Validation evidence: `spike/SPIKE-RESULTS.md`.
