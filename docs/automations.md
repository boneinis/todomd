# Automation lanes — using the providers' own routines, loops & schedulers

todomd's board is plain files in git, so every automation primitive the providers
offer can drive it. Pick lanes by latency, attendance, and which usage pool pays.

| Lane | Provider feature | Needs | Bills to | Latency |
|---|---|---|---|---|
| Launcher (default) | `claude -p` / `codex exec` headless | todomd server running | headless pool / ChatGPT plan | instant |
| Budget dispatcher | Claude Code **/loop** | a terminal you keep open | **interactive pool** | ≤ loop interval |
| Morning triage / email intake | Claude Code **cloud routines** (`/schedule`) | repo with a remote; runs on Anthropic infra | interactive pool (daily routine caps: 5 Pro / 15 Max) | ≥ 1 hr |
| Local unattended ticks | Claude **desktop scheduled tasks** | Claude desktop app open | interactive pool | ≥ 1 min |
| Machine-level cron | OS cron/launchd wrapping `claude -p "/todomd-dispatch"` | nothing extra | headless pool | your cron interval |
| Codex side | **Codex App Automations** / `codex cloud exec` | ChatGPT login | ChatGPT plan | per schedule |

## Budget mode (/loop dispatcher)

1. In `.todomd/config.yml` set `mode: budget` — the todomd server keeps serving the
   board, validating drags, and committing transitions, but spawns nothing.
2. In a terminal at the repo, start an interactive session and run:

   ```
   /loop 2m /todomd-dispatch
   ```

   Every tick the session plans pending Plan-column cards, processes ONE Queue
   card through build → subagent verify → merge, runs skill cards, self-heals
   anything an interrupted tick left behind, and goes idle when the board is clear.
3. Notes: `/loop` is session-scoped (dies with the terminal, 7-day expiry — restart
   it when you sit down to work); the board UI shows "· budget" next to the meter;
   run badges don't appear (the server isn't running the agents) but column moves
   stream live via the file watcher.

## Cloud routine recipes (`/schedule`)

- **Email → board**: see `docs/email-intake.md` (Gmail label → cards in Review,
  committed and pushed from Anthropic's infra; zero local footprint).
- **Morning triage**: hourly/daily routine with the repo attached:
  *"Read .todomd/tasks. For cards in Review, check the Description is actionable,
  add missing acceptance criteria, set a suggested priority, and leave a one-line
  comment under ## Findings. Commit each card file with a chore(todomd): message
  and push. Do not change status."*
- Routines get a fresh clone — they can write cards and push, but local-only
  state (worktrees, the queue) is invisible to them. Keep routines to board-file
  work; leave builds to the launcher or dispatcher.

## OS cron (vendor-neutral unattended)

```cron
# weekday mornings: one dispatcher tick, headless
0 7 * * 1-5 cd /path/to/repo && claude -p "/todomd-dispatch" --permission-mode acceptEdits --allowedTools "Read,Glob,Grep,Edit,Write,Task,Bash(npm test:*),Bash(git:*)" --max-turns 60 >> ~/.todomd/cron.log 2>&1
```

Same dispatcher logic, no terminal, bills the headless pool. Use launchd on macOS
for laptop-friendly scheduling (cron misses ticks while asleep; launchd runs on wake).
