# Local wake capability spike results

Status: automated harness verified; microphone and endurance run pending
Date: 2026-08-01
Environment: macOS host running TODOMD

## Installed browser baseline

| Browser | Installed version | Local wake disposition |
|---|---:|---|
| Google Chrome | 150.0.7871.187 | Primary test target; real local model and microphone check pending. |
| Microsoft Edge | 150.0.4078.105 | Capability-gated comparison target; never permit remote recognition before wake. |

## Harness verification

The non-production harness is under `scripts/voice-spike/` and runs with
`npm run voice:spike`. It binds only to `127.0.0.1`, serves four static files,
exposes no board routes, and sends a Content Security Policy with
`connect-src 'none'`.

Verified on 2026-08-01:

- `GET /` returns `200`, `Permissions-Policy: microphone=(self)`, and the
  network-blocking Content Security Policy.
- `GET /api/board` returns `404`; the harness cannot read or mutate TODOMD.
- Focused tests cover strict `processLocally` enforcement, language-pack
  installation, Chrome 139-style quality fallback, finalized exact phrase
  matching, ordinary recognition restart, and terminal permission errors.
- No wake-engine package, model, account, or vendor key was added.
- The focused wake tests pass: 6/6.
- The relevant full TODOMD suite passes: 274 unit/integration tests and 5 UI
  tests. This includes the existing Resume Build, preserved-worktree, Retry
  Verification, and Codex infrastructure-diagnostic coverage.

## Pending hardware gate

The browser bridge detected Chrome 150 and confirmed that its extension and
native-host files are installed, but the existing Chrome session did not accept
a browser-control connection. Therefore microphone permission, local model
availability, actual wake accuracy, false wakes, background behavior, and
sleep/wake recovery have not yet been measured.

The production voice build remains **no-go** until one real Chrome/macOS run
meets all thresholds in `docs/voice-control-plan.md`:

- at least 95% intended wakes in quiet conditions;
- at least 90% intended wakes in normal room noise;
- no more than one false wake in four armed hours; and
- automatic recovery after ordinary recognition ends and Mac sleep/wake.

Downloaded metrics JSON must be reviewed before marking this gate complete.
