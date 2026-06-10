# Email → board intake (zero infrastructure)

Tasks arrive on the board by email using a **Claude Code cloud routine** — runs on Anthropic's infrastructure under your subscription, no server, no API key, no email code in todomd. Requires: the repo has a remote (GitHub), and your claude.ai account has the **Gmail connector** enabled (claude.ai → Settings → Connectors).

## Setup (once per repo)

1. In Gmail, create the label `todomd/<repo-name>`. Forward (or label) any email that should become a task.
2. In Claude Code, run `/schedule` and create a routine — hourly (the minimum), with access to your repo — using this prompt:

```text
You maintain the todomd task board in this repository.

1. Using the Gmail connector, find unread emails with the label "todomd/REPO_NAME".
2. For each one, create a file .todomd/tasks/task-NNNN-<slug>.md where NNNN is
   one greater than the highest existing task number, zero-padded to 4 digits.
   Use exactly this format:

   ---
   id: task-NNNN
   title: <subject line, cleaned up>
   status: Review
   type: <fix | improvement | module | troubleshoot — infer from the email>
   priority: <low | medium | high — infer; default medium>
   labels: [email]
   dependencies: []
   created_date: <today>
   source: email
   agent: claude
   session_id:
   worktree:
   verification: { attempts: 0, max_attempts: 3, last_verdict: }
   ---

   ## Description

   <the email body, summarized into a clear task description; quote relevant
   details; note the sender>

   ## Acceptance Criteria

   <2-4 concrete checkboxes ("- [ ] ...") inferred from the request>

   ## Implementation Plan

   ## Run Log

3. Mark each processed email as read.
4. Commit each new file with message "chore(todomd): task-NNNN created (email)" and push. (The `chore(todomd):` prefix matches todomd's own commits and passes Conventional-Commits/commitlint gates.)
5. If there are no matching emails, do nothing and finish.
```

3. Pull (or let your editor auto-fetch): new cards appear in the board's **Review** column — email never skips the human gate.

## Notes

- Routine runs consume your subscription's interactive pool and count against the daily routine cap (5/day Pro, 15/day Max) — schedule accordingly (e.g. every 2–3 hours during work hours).
- For machine-local repos without a remote, the same prompt works as a **desktop scheduled task** (Claude desktop app, 1-minute minimum) pointed at the local checkout — no push step needed.
- The card format above is exactly what `todomd init`/the UI produce; the intake agent is just another writer of the same protocol.
