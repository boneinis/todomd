---
id: task-0063
title: LAN listener binds the first non-internal IPv4 (ZeroTier wins) — plain LAN access unreachable
status: CI
type: bug
priority: medium
labels: [server, lan]
dependencies: []
created_date: 2026-10-01
source: agent
assignee:
agent:
triaged: 2026-10-01
cost_usd: 0
needs_human_reason:
build_profile: standard
build_limits: { max_slices: 3, budget_minutes: 60 }
complexity: medium
base_branch: main
worktree: todomd/task-0063
ci_evidence: {  }
ci_remote: {  }
verification: { attempts: 2, max_attempts: 3, last_verdict: fail }
session_id: zinc-tenor
---

## Description

The LAN/mobile listener calls `lanAddress()`, which returns the first non-internal IPv4 from `os.networkInterfaces()` — on a Mac also joined to ZeroTier that's the ZT IP (10.0.152.11), not the LAN IP (192.168.1.33). The listener binds only that one address (`lanServer.listen(port, ip)`), so phones on the real LAN get connection-refused even with "enable network access" on. Additionally `hostOk()` only accepts `lanAddress():port`, so even relaying traffic to the LAN IP 403s. Observed live: `curl http://192.168.1.33:7337/` → unreachable while `http://10.0.152.11:7337/` → 200.

## Acceptance Criteria

- [ ] With LAN access enabled, the board is reachable on the machine's real LAN IPv4 (e.g. 192.168.x.x) even when ZeroTier/Tailscale interfaces exist
- [ ] `hostOk` accepts every address the LAN listener is actually bound to (or a documented wildcard), not only `lanAddress()`
- [ ] The QR/link advertises the LAN IP by preference; ZT/VPN IPs may still be offered but not at the cost of LAN reachability
- [ ] LAN toggle remains off by default and viewer-token-only; no auth weakening

## Verification

- [ ] With the LAN listener on and a VPN interface up, `curl http://<lan-ip>:7337/` returns 200 and a tokenized board GET succeeds

## Triage

- **Decision:** Actionable
- **Rationale:** The root cause and scope of the LAN listener binding and host validation issue are clear and well-scoped. The acceptance criteria provide explicit requirements for interface selection and request validation.
- **Risks or questions:** none
- **Next step:** Plan

## Run Log
- 2026-10-01 08:13Z · Triage · 1 turns · gemini/gemini-3.7-flash-high · gateway · usage unavailable · $0.000 est · ok
- 2026-10-01 14:30Z · Plan · 1 turns · codex/gpt-6.1-sol · subscription CLI · 190.7K input, 150.5K cached, 3.0K output · $0.000 est · ok
- 2026-10-01 16:33Z · Build attempt 1 · 31 turns · devin/swe-2-high · subscription CLI · 1.64M input, 1.57M cached, 28.0K output · $0.000 est · ok
- 2026-10-01 17:18Z · CI attempt 1 · 236.5s · `npm test` passed
- 2026-10-01 17:20Z · Verify attempt 1 · 1 turns · codex/gpt-6.1-sol · subscription CLI · 24.6K input, 0 cached, 1.9K output · $0.000 est · verdict: fail (unmet: 1)
  - retrying with findings (attempt 2/3)
- 2026-10-01 18:09Z · Build attempt 2 · 44 turns · devin/swe-2-high · subscription CLI · 2.86M input, 2.69M cached, 38.9K output · $0.000 est · ok
