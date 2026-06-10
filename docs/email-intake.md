# Email → board intake

Two ways to turn emails into Review-column cards. **Option A (IMAP)** is fully local — todomd polls a mailbox directly. **Option B (cloud routine)** runs on Anthropic's infrastructure with no local process. Both land cards in **Review** (the human gate is never skipped), and both trigger auto-triage.

---

## Option A — direct IMAP polling (local-first, built in)

todomd connects to any IMAP inbox (Gmail, Fastmail, iCloud, your own server) and turns new messages into cards: subject → title, body → description, and **email attachments become card attachments** the agents can read.

**Credentials never touch the repo.** They live only in `~/.todomd/intake.json` (per-machine), keyed by project name — never in the committed `.todomd/config.yml`:

```json
{
  "my-repo": {
    "host": "imap.fastmail.com",
    "port": 993,
    "secure": true,
    "user": "you@fastmail.com",
    "pass": "an-app-specific-password",
    "folder": "todomd",
    "pollSeconds": 300,
    "markSeen": true,
    "maxAttachments": 5
  }
}
```

Then:

```bash
chmod 600 ~/.todomd/intake.json     # it holds a password
todomd intake-test my-repo          # verify: prints folder + unseen count, creates nothing
todomd                              # the server now polls that inbox while it runs
```

- **Point it at a dedicated folder/label**, not your main inbox — make a filter that files "todomd" mail into a `todomd` folder. todomd processes **unseen** messages and marks them seen (the idempotency key), so a dedicated folder avoids fighting your mail client.
- Use an **app-specific password** (Gmail/iCloud require one; never your account password).
- Polling runs only while the todomd server is up. For machine-off intake, use Option B.

### Multiple projects

Routing is **per folder**: each board polls its own folder, so the decision "which board does this email become a card on" is made by your mail filters. Two common setups:

**Separate accounts/addresses** — give each project its own entry (or use plus-addressing like `you+repo-a@gmail.com`). Each board is fully independent.

**One shared account, a folder per project** — define the credentials once under `accounts` and reference them, so the password isn't repeated:

```json
{
  "accounts": {
    "work": { "host": "imap.fastmail.com", "port": 993, "secure": true,
              "user": "you@fastmail.com", "pass": "an-app-password" }
  },
  "boards": {
    "repo-a": { "account": "work", "folder": "todomd/repo-a", "pollSeconds": 300 },
    "repo-b": { "account": "work", "folder": "todomd/repo-b" }
  }
}
```

Then a filter files `todomd/repo-a` mail into that folder and `repo-a`'s board picks it up; `repo-b` likewise. A board only ever sees its own folder, so an email can never land on the wrong project. (Both formats can be mixed; the legacy flat `{ "<project>": {…} }` form still works.) Each board polls on its own connection — fine for a handful of projects; for many boards on one provider, stagger `pollSeconds` to stay under the account's simultaneous-connection limit (Gmail allows ~15).

### One shared inbox, routed by the address it was sent to

Best when you set up **one dedicated inbox** and forward each project's address into it (e.g. `repo-a@yourco.com` and `repo-b@yourco.com` both forward to `todomd@gmail.com`). todomd routes each message to a board by **the address it was sent to** — forwarding via aliases preserves the original recipient in the `To` header, and Gmail/server forwarding keeps it in `Delivered-To` / `X-Forwarded-To` / `X-Original-To`, all of which are matched:

```json
{
  "accounts": {
    "hub": { "host": "imap.gmail.com", "port": 993, "secure": true,
             "user": "todomd@gmail.com", "pass": "an-app-password" }
  },
  "inboxes": {
    "main": {
      "account": "hub",
      "folder": "INBOX",
      "pollSeconds": 300,
      "routes": [
        { "project": "repo-a", "toMatches": "repo-a@yourco.com" },
        { "project": "repo-b", "toMatches": "you+repo-b@gmail.com" }
      ],
      "default": "triage"
    }
  }
}
```

- `toMatches` is a case-insensitive substring of any recipient address — so `repo-b@` matches `repo-b@anything`, and a plus-address or full alias both work. First matching route wins.
- `default` (optional) is the board for mail that matches no route; without it, unrouted mail is logged (with the addresses it was sent to, so you can add a route) and skipped. Point `default` at a catch-all board and re-file from its Review column when something needs another project.
- One connection, one folder, any number of projects — no per-project filters needed. `todomd intake-test main` reports the folder, unseen count, and route count.

> **Security note:** email is untrusted input. Card titles are sanitized and bodies are escaped on render, so a crafted email can't corrupt a card or inject script. It *can* contain prompt-injection aimed at the triage agent — which runs read-only-ish (Edit scoped to `.todomd/tasks/`), but treat auto-triaged email cards with the same skepticism as any inbound request.

---

## Option B — cloud routine (zero infrastructure, machine-off)

# Email → board intake (cloud routine)

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
