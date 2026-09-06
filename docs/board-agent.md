# Board Agent

One Board Agent contact can coordinate up to 12 explicitly selected boards on one To-do MD server. Each board has its own durable conversation, instructions, routine permissions, contact mode, watching setting and publishing policy. A new repo is never automatically selected. Installing To-do MD alone does not grant an agent access.

## Choose your contact and boards

Open **board agent** in the desktop toolbar. In **All selected boards**, choose the repos and the portfolio contact: built-in Claude chat or an external agent such as Codex. Save, then choose each board in **Conversation scope** to set its contact and permissions. Selecting a board starts with no routine permissions and **Hold for human review** publishing.

The scope selector belongs to this conversation. Changing the main browser board does not silently switch it. Board-specific messages stay with that board; the portfolio view shows cross-board conversation and action results. Returning to a board restores its context. The coordinator can intentionally read multiple selected contexts for comparisons.

Built-in chat uses the installed, authenticated Claude CLI in safe, tool-free mode. Portfolio turns receive a summary for every board and equal small detail allocations. Focus a board to retrieve more detail. The external tools support card and history retrieval without relying on one large Codex transcript.

## Routine rules and exceptions

Routine permissions cover creating Review cards, planning, approving Planned cards, kicking approved Queue work, resuming preserved builds, retrying verification and pausing/resuming queue starts. Global and per-board action limits apply, with a maximum of five per turn. Written instructions guide the agent; they do not grant extra capabilities.

Unchecked operations and cancellation, archiving, restarting a build, re-triage and retrying Planned become proposals in the visible approval inbox. The proposal names its board, card, operation and requested content. **Approve** rechecks current identity, policy, card, queue pause state, live runs and committed repository guidance. Changed inputs reject stale approval. Unrelated model edits preserve proposals; relevant policy changes invalidate only that board's proposals and retain their audit records.

Card operations without a current full context read require review. Plans longer than 6,000 characters also require human approval, even when read in chunks. Card creation uses the YAML serializer, including titles containing `: `. Parse errors, dependency errors and Queue admission results are available to the coordinator. An accepted dispatch means the pipeline accepted the request; it does not mean the build finished.

### Publication policy

**Hold for human review** stops a verified build in **Needs Human** with `publication_review_required`, preserving the branch and worktree. The board does not automatically merge it. Board metadata edits remain local and uncommitted when the checkout is on a listed protected branch (default `main, master`). Review and publish using the repository's normal human workflow.

**Allow the board pipeline to merge** preserves the existing automatic merge behavior. This is a separate user setting from permission to approve plans. Existing v1 boards retain their old publication behavior during migration; review this setting before enabling builds in a repo that forbids automatic main commits or merges.

Policies govern the To-do MD pipeline. Separately granted shell access or unrestricted tools are independent capabilities. Committed `AGENTS.md` and `CLAUDE.md` are supplied as guidance with content revisions; arbitrary prose is not converted into an executable policy. Task worktrees and the existing scheduler remain responsible for code work and resource limits. The coordinator does not launch another dispatcher or a deployment tool.

## Codex voice connection

In Codex **Settings → MCP servers**, add a STDIO connection:

```json
{"command":"todomd-mcp","args":["--board-agent"]}
```

Use the installed absolute executable path if Codex cannot find it. The process reads only its dedicated `~/.todomd/token-board-agent` credential in this mode. Do not supply the primary desktop token: `--board-agent` refuses it. Use `--port` or `--url` if automatic local server discovery is unsuitable. `TODOMD_HOME` is respected for separate local servers; create one connection per server. This release does not federate multiple hosts.

Restart the MCP connection, open your coordinator Codex task and ask for `board_agent_overview`. **Check connection** in the board UI reports whether the server has received scoped requests. **Revoke current agent connection** rotates this credential; existing MCP processes lose access until restarted. Leave the separate viewer plugin read-only.

Start native Codex voice in that task when available. Voice uses the task's configured tools; the To-do MD browser microphone is a separate feature. No automatic voice startup or new Codex task creation is assumed. See [Codex voice](https://learn.chatgpt.com/docs/features/voice) and [MCP configuration](https://learn.chatgpt.com/docs/extend/mcp?surface=cli). Actual spoken acceptance still requires a configured task and a user voice session.

Suggested first message:

> Use the Board Agent tools as my point of contact. Show all selected boards, then focus on ShopTach. Keep each board's instructions and decisions in its own context. Follow saved routine permissions and bring exceptions to the board's approval inbox.

### Tool protocol

| Tool | Use |
| --- | --- |
| `board_agent_overview` | Every selected board's UUID, current name/aliases, counts, policy and connection state. |
| `board_agent_context` | One `board_id` and `session_id`; page cards with `cursor`, `limit` and `revision`, or fetch a `card_id` and `detail_cursor`. Follow returned cursors; omissions are explicit. |
| `board_agent_message` | Save an actual user request using stable `session_id`, unique `request_id`, `text`, and either `board_id` or `scope: portfolio`. Establishes focus and the turn budget. |
| `board_agent_propose` | Submit a typed action with explicit `board_id`, session and request IDs. Returns the actual result or a pending exception. |
| `board_agent_reply` | Save a response in the named board or portfolio context. Report real results and pending decisions. |
| `board_agent_events` | Retrieve new events for a board or portfolio using the previous `next_cursor`. A reset requires fresh context. |

Use one stable session ID per Codex conversation. Resolve spoken names and aliases against the overview. If multiple boards fit, clarify before proposing an action; shared card IDs such as `task-0001` are never sufficient alone. A portfolio request may intentionally target multiple boards, but each action carries a board ID and produces its own outcome. Do not invent new user messages to reset action limits.

The scoped credential cannot change settings, approve proposals, read unselected boards, call raw card APIs or access general files. Exceptions require the primary desktop approval UI. There is no `approved: true` tool and no speech-only approval bypass.

Identical retries return durable receipts, including an existing proposal's later decision. Reusing an ID with different input is rejected. A 60-second external session lease prevents competing controllers for a board. Switching the board's saved contact determines whether built-in or external actions are allowed; multiple interfaces can still read and submit messages.

## Watching, stopping and reconnecting

Built-in watching is enabled per board. Changed board state triggers a check, with at least five minutes between checks on that board; unchanged state does not start a model. Watching survives restart. Background queue resumes always ask for approval.

Stopping one board's coordinator leaves other boards available. Stopping the portfolio stops all coordinator turns and watching. Save the corresponding rules to resume. Already-dispatched pipeline work continues. Stopping voice, stopping a coordinator, pausing Queue and cancelling a build are separate operations. To-do MD does not start or schedule an external Codex agent after the user disconnects.

State lives privately under `~/.todomd/board-agent/`. Board UUIDs bind to the canonical path and board directory identity; renaming retains identity. A replaced path requires an explicit desktop rebind and fresh rule review. Deselecting a board does not erase its history or silently relax its publication restriction.

A single fenced service owner writes `state.json`. Independently scoped records commit in one atomic snapshot, avoiding partial updates across separate files. Dispatch intent is persisted before execution. Interrupted operations are marked uncertain on restart and are never blindly replayed. Review the live board before issuing a fresh request. Corrupt state or conflicting ownership disables coordinator writes; preserve the files for recovery.

## Upgrade and validation

At the operator's idle-window restart, v1 state is backed up exactly to `state.v1.backup.json`. Existing selected boards retain their permissions, contact, watching, stop state and publication behavior. Attributable action history moves to its board; mixed legacy conversation remains a portfolio archive. Old proposals retain an invalidated audit record and need fresh review. Receipts survive. No queue marker is changed by migration.

Do not run an older service against migrated state. For rollback, first stop the service in an appropriate idle window and preserve the entire new state directory and any post-upgrade receipts before restoring the v1 backup. V1 does not understand v2 ownership or policy guarantees.

Automated acceptance uses disposable repos, fake agents, a separate STDIO MCP process, raw HTTP denial tests, a verified pipeline build and browser tests. It covers separate context/rules, fair retrieval, stale proposals, migration, competing owners, stop isolation, reconnect receipts, token revocation and publication review. `npm test` is the full regression check. Final implementation run: **663 core/integration + 36 browser tests passed**, with no skips. A disposable visual check also verified scoped settings, board history and a visible Save button.

Production rollout and a real spoken test remain operator steps: restart safely, confirm the ShopTach and Church Broadcast settings and queue states survived, configure/restart the scoped Codex connection, then speak the multi-board acceptance scenarios in [the implementation plan](board-agent-context-and-codex-voice-plan.md). No production restart or live board permission change was performed during development.
