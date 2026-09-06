# Board Agent and remote CI runtime integration

This candidate combines Board Agent commit `c0cc777` with the focused remote-CI
review at `4ff557c` (PR #2). It preserves per-board context, the separate scoped
Codex connection, policy-controlled routine actions, and review-before-publish
behavior. The viewer connection remains read-only.

Pipeline conflicts were resolved to retain both sets of behavior:

- Same-candidate CI retries work for local failures and remote prerequisites;
  remote recovery preserves the candidate and adapter journal without creating
  a new Build attempt.
- Missing remote evidence reruns the mandatory remote gate. Existing local CI
  evidence requirements and read-only Verify restrictions remain enforced.
- Boot recovery holds interrupted remote CI for explicit reconciliation while
  preserving existing local post-Build checkpoint recovery.
- The final merge checks remote evidence and still observes the Board Agent
  publication policy. A passing CI/Verify result cannot bypass a human-review
  publishing hold.
- Dedicated remote wait processes retain CI process tracking and local wait
  process-group cleanup; accepted fleet jobs are outside that process group.

## Installation boundary

No shared-service restart, global CLI relink, project configuration change,
source approval, or queue resume was performed during this integration.

The read-only preflight observed service PID 28865 on port 7337 and nine
registered boards. It found no active Plan/Build/CI/Verify card. 4Upfit remained
paused, with task-0013 held as `held_for_fleet_ci` and task-0027 queued for Build.
ShopTach remained paused. This snapshot is not restart clearance and must be
repeated immediately before an operator-coordinated restart.

Before live use, complete the required CI gates, review/land the desired
runtime branch, record the previous CLI target and commit, and have the operator
restart within an agreed idle window. Check every board's queue, holds and
active state afterward. Leave P1-05 held until the fleet and 4Upfit adapter
owners qualify every applicable check and exact-source approval.

For Board Agent activation, follow [the setup guide](board-agent.md): explicitly
select boards, save each board's routine permissions, configure the dedicated
Codex Board Agent MCP connection, then verify a real voice session with the
[spoken acceptance scenarios](board-agent-context-and-codex-voice-plan.md).
Installing To-do MD in a repository alone does not select it or grant agent
access. One Codex coordinator can contact all selected boards on the connected
server; each board retains its own context.
