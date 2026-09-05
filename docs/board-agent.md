# Board Agent

The Board Agent is a shared point of contact for one or several boards registered with the same To-do MD server. Users choose built-in chat or their own external MCP-capable agent. Both use the same saved scope, routine action permissions, conversation history, exception inbox, and board pipeline.

## Setup and everyday use

Open **board agent** in the desktop toolbar. Choose the point of contact, select up to 12 boards, and check the actions the agent may perform without asking. Add priorities or working instructions, then **Save rules**. No boards, permissions, or background watching are enabled by default.

The built-in conversation uses the installed, authenticated Claude CLI in safe, tool-free mode. It receives prepared board context and returns structured action proposals. It can run up to five actions per turn (three by default). Users can instead choose an external agent, including Codex or another MCP-capable client.

Routine permissions cover creating Review cards, planning, approving Planned cards, kicking approved Queue work, resuming preserved builds, retrying verification, and pausing/resuming queue starts. Board selection and action permissions are enforced in code. Written instructions guide the model; they are not a programmable policy language. If a requirement must always require a human decision, leave that action unchecked.

Unchecked actions and cancellation, archiving, restarting a build, re-triage, and retrying Planned are proposed in the exception inbox. The user sees the target, reason, and proposed card contents before **Approve** or **Decline**. Changed cards or boards invalidate old proposals. Changing rules clears pending proposals. Changing contact mode or board scope starts fresh model context; earlier conversation stays visible in the desktop history.

The conversation records actual action results, including queue admission reasons. A successful dispatch means the board accepted the request; it does not mean a build or verification finished. Malformed frontmatter and unresolved dependencies are available in the live snapshot. Card creation uses the board's YAML serializer.

## Background operation

For built-in chat, optionally enable **Run on board changes**. The server checks changed selected boards, with at least five minutes between background checks; unchanged snapshots do not start a model turn. Watching survives an ordinary server restart and only operates while To-do MD is running. An initial check runs after watching is enabled or restored. Resuming a paused queue during a background turn always requires approval, even if queue resume is otherwise permitted.

**Stop agent & watching** stops the coordinator turn and prevents subsequent agent requests. Save rules to resume. Already-dispatched pipeline work continues under the board's existing controls.

The coordinator uses existing pipeline operations for scheduling, locks, dependency checks, resource gates, approvals, recovery, and verification. It does not create a second Build dispatcher. Context is bounded to 250 cards and a byte budget; long card details and omitted cards are marked. Approving a plan that cannot fit in the prepared snapshot always requires human review.

## External agent connection

Configure your MCP client to run:

```text
todomd-mcp --board-agent
```

Supply `TODOMD_MCP_TOKEN` using the primary token from `~/.todomd/token` in the client's environment. Use `--port` or `--url` if automatic server discovery is unsuitable. Do not put a real token in a committed client configuration.

This restricted MCP mode exposes only:

- `board_agent_context`: selected board state, rules, recent conversation and pending decisions.
- `board_agent_propose`: submit one action with a unique `request_id`, `project`, `action`, and `why`; include `card_id` or `title`/`description` when relevant.
- `board_agent_reply`: save a reply in the shared conversation with a unique `request_id` and `text`.

Ask the external agent to read context, follow the saved instructions, propose actions only through these tools, and report actual outcomes using `board_agent_reply`. Exceptions wait for the desktop inbox; the restricted tool set cannot approve them or change rules. Retrying an identical request ID returns its recorded result. Reusing it for another action is rejected.

The external client owns its conversation/run lifecycle and must be running to read new inbox messages. To-do MD does not launch or schedule the external client. The restricted MCP interface governs actions submitted through it; an external agent separately granted shell access or unrestricted board tools retains those independent capabilities. Use a dedicated client profile for delegated board operation.

## Persistence and deployment

State is stored privately in `~/.todomd/board-agent/state.json` (`TODOMD_HOME` is respected): rules, the latest 200 history entries, pending proposals, and durable request receipts. A dispatch interrupted before its result is saved is shown as uncertain and is never replayed automatically. Inspect the live board before issuing a fresh request. Corrupt saved state disables coordinator actions until the state file is restored.

This release coordinates the registry served by one `todomd serve` instance; it does not federate independently hosted servers. Board scope binds both registered name and repository path. Viewer and mobile tokens cannot read or operate the coordinator.

Changes take effect when the operator restarts `todomd serve` in an appropriate idle window. Development and verification used disposable boards and servers; the running production server was not restarted.

## Validation

`test/board-agent.test.js` covers permissions and scope, exception decisions, stale proposals, idempotency, recovery uncertainty, malformed frontmatter, stopped turns, external inbox behavior, restricted MCP/API access, background change detection, and corrupt state. `test/ui/board-agent.test.js` exercises saving rules, built-in replies through the fake CLI, changing contact mode, routine dispatch, and exception approval in Chrome, including safe text rendering. The full `npm test` suite remains the release check.
