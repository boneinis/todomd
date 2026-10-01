---
id: task-0063
title: LAN listener binds the first non-internal IPv4 (ZeroTier wins) — plain LAN access unreachable
status: Review
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
