# Voice control — spike and design

A board microphone button arms a short voice session: press it, hear an
earcon, and the board silently watches audio **on-device** for a TODOMD wake
phrase. Ordinary conversation never leaves the page. Only after a wake phrase
fires does audio reach the realtime voice service, and any action that would
change a card, a run, or routing is spoken back and must be confirmed before
the board calls its own API. This is a dedicated board voice client — it does
not embed or drive the Codex desktop voice session.

This chunk ships no source, only this design. `src/voice.js`, `public/voice-*.js`,
and the vendored wake-word engine are built in later chunks (task-0036,
task-0037, task-0038) against the contracts fixed here.

## Wake-word component

**Constraints this repo actually has:** no bundler, no build step — `public/`
is served straight to the browser as ESM; tests run under `node --test` with
no network access. Any engine has to ship as static files under
`public/vendor/`, be importable with a plain `import()`, and be mockable in
tests via dependency injection (see `createVoiceSession({ wakeWord, ... })`
in task-0037) rather than by actually loading WASM in `node --test`.

Three options were scored:

| Option | On-device? | Needs an account/key? | Fits "no bundler, static vendor" | Verdict |
|---|---|---|---|---|
| **Picovoice Porcupine Web** | Yes (WASM) | Yes — AccessKey | Yes — official prebuilt WASM + JS worker, drop-in static files | **Selected** |
| onnxruntime-web + openWakeWord | Yes (WASM) | No | No — no official browser SDK for our phrases; needs a Python training pipeline and hand-rolled mel-spectrogram/streaming-inference glue in-browser | Rejected |
| Web Speech API interim-transcript gate | **No** | No | Yes — built into the browser, zero vendoring | Rejected |

**Selected: Picovoice Porcupine Web.** It ships an official
`@picovoice/porcupine-web` package as prebuilt WASM + a JS worker file with no
bundler required — the artifact is just static files. `PorcupineWorker.create()`
needs more than the worker JS and one keyword file per phrase, and this repo
vendors all of it under `public/vendor/porcupine/`:

- The worker JS and its WASM binary (recent SDK builds embed the WASM as
  base64 inside the worker JS; either way it ships as static files, no
  bundler step).
- `porcupine_params.pv` — the shared Porcupine **parameter model**: the
  trained acoustic/language model `PorcupineWorker.create()` requires
  regardless of which keyword is active. This is distinct from, and in
  addition to, the per-phrase `.ppn` files below — omitting it is a hard
  init failure, not a missing feature.
- One `.ppn` **keyword model** per wake phrase. It supports **custom
  multi-word keywords**: each of our four phrases is trained once in the
  Picovoice Console (a web UI, not part of this repo's toolchain) and the
  resulting `.ppn` file is committed here.

`PorcupineWorker` itself never touches the microphone — the official browser
integration pairs it with the companion `@picovoice/web-voice-processor`
package's `WebVoiceProcessor`, which owns `getUserMedia`/`AudioWorklet`
capture, resamples to 16 kHz, and pushes frames to whichever engine worker is
subscribed to it. That package is vendored alongside Porcupine, under
`public/vendor/web-voice-processor/`, and is what `createVoiceSession`
(task-0037) calls to start and stop the mic; `PorcupineWorker` only ever sees
frames `WebVoiceProcessor` hands it, never the raw `MediaStream`.

Recognition runs entirely on-device — no audio leaves the page to detect the
wake phrase — which is the hard requirement of the privacy contract below. It
also has a materially lower CPU/battery footprint than a general ASR model,
which matters for an always-armed background listener in a browser tab.

**Rejected — onnxruntime-web / openWakeWord.** Also on-device and, unlike
Porcupine, needs no account or key at all, which is attractive. But
openWakeWord has no official browser SDK: shipping it here would mean (a)
training a custom model outside this repo's toolchain (its training pipeline
is Python/TensorFlow, not `node --test`-compatible) for each of our four
phrases, and (b) hand-writing the browser-side feature extraction
(streaming mel-spectrogram) and inference glue that Porcupine's SDK already
provides. That's materially more surface to build and maintain correctly for
a spike-stage feature, so it loses on implementation risk despite the
no-account appeal.

**Rejected — Web Speech API interim-transcript gate.** Zero vendoring, zero
key, built into Chrome/Edge's `SpeechRecognition`. Disqualified on the
privacy contract, not convenience: Chrome's implementation streams raw
microphone audio to Google's cloud recognition service continuously while
listening, so "ordinary conversation is ignored before audio is sent to the
voice service" (task-0020's own acceptance criterion) would already be
violated by the wake-word check itself. It's also unsupported in Firefox and
inconsistent in Safari.

The chosen engine — Porcupine's worker/WASM/`.pv`/`.ppn` files plus
`WebVoiceProcessor` — is **vendored under `public/vendor/`** and is **loaded
lazily via dynamic `import()` only after the mic button is pressed** — it is
never on the critical path of loading the board.

## Privacy contract

- Raw audio frames stay in the page (`MediaStream` → the wake-word worker,
  in-process) and are **discarded**, never transmitted, until the wake gate
  fires.
- Only audio captured **after** a wake phrase fires may reach the realtime
  voice service. Nothing pre-wake is ever sent over the network.
- The gate **re-closes** in two independent cases, which are not the same
  state transition:
  - **`That is all To-do`** ends the whole session: it plays the exit
    earcon, stops every `MediaStream` track (mic fully released), and
    returns to `inactive`.
  - **Idle timeout** (default ~8s of no speech after the gate opened, driven
    by an injected `clock` so it's deterministic in tests) only closes the
    gate back to `armed` — the mic stays open and still watches for the next
    wake phrase; the session is not ended.
- **No-key fallback:** the board must boot identically whether or not a
  wake-word key is configured. The toolbar always renders the mic button.
  Configuration is resolved lazily, on first click, via
  `POST /api/voice/session` (below) — if that call 403s or 503s, the button
  is left disabled with a `title` explaining why (e.g. "voice not
  configured — set TODOMD_VOICE_WAKE_KEY on the server"). This also means a
  non-primary session (a viewer or mobile QR link) needs no separate
  hide/disable logic: its request 403s the same way an unconfigured key
  503s, so the button ends up disabled either way through one code path.

## Credential flow

Two long-lived secrets are involved, held only in server config/env — but
only one of them is designed to stay off the browser entirely:

- `TODOMD_VOICE_KEY` — the realtime voice-service API key (e.g. an OpenAI
  Realtime key). Server-only, and **it never appears in any API response**.
  The browser instead receives a short-TTL **ephemeral token** minted
  server-side per session (see the response shape below).
- `TODOMD_VOICE_WAKE_KEY` — the Picovoice AccessKey used to initialize the
  wake-word engine. This one **does** reach the browser: Porcupine's web SDK
  requires the AccessKey directly in the browser process to initialize the
  WASM engine (there is no server-side wake-word detection step to proxy it
  through), so every browser Porcupine integration works this way. Picovoice's
  own docs still tell integrators to protect the AccessKey from public
  exposure and abuse (https://picovoice.ai/docs/porcupine/) — it is a real
  secret, not a throwaway value, and this repo does not pretend otherwise.
  The mitigation here is *who can reach it*, not *how long it lives*:
  `POST /api/voice/session` hands it to the browser verbatim as `wakeKey`,
  but only after the same primary-only gate used for everything else on this
  route, so only the desktop session that started todomd can ever obtain it —
  exactly like `/api/lan`'s `canToggle`. It is not rotated or scoped to a TTL
  the way `TODOMD_VOICE_KEY` is.

Both are **environment variables, never `.todomd/config.yml` fields** — the
same reasoning `docs/email-intake.md` already applies to IMAP credentials:
`config.yml` is committed and, per `docs/security.md`, is trusted/pinned at
`HEAD:` precisely because it's expected to be safe to commit. A secret placed
there would be pushed to whatever remote the repo has. Non-secret voice
settings (e.g. which realtime model to use) may live under an optional
`voice:` block in `config.yml`; the keys themselves never do.

### `POST /api/voice/session`

Mirrors the `primary(req)` gate `/api/lan` already uses in `src/server.js`
(`const primary = (req) => eq(sentToken(req), token)`), sent the same way as
every other endpoint — `?token=` query param or `x-todomd-token` header.

**Request**

```
POST /api/voice/session
x-todomd-token: <primary token>
Content-Type: application/json

{}
```

No body fields are required; an empty object (or omitted body) is accepted.

**Response — 200** (both keys configured):

```json
{
  "token": "ek_9f2c...",
  "expiresAt": "2026-08-01T12:01:00.000Z",
  "model": "realtime-mini",
  "wakeKey": "porcupine-access-key-value"
}
```

- `token` — the short-lived (60s TTL) ephemeral realtime-voice-service
  credential. Never the raw `TODOMD_VOICE_KEY`.
- `expiresAt` — ISO 8601 timestamp, `now + 60s` (a session minted at
  `12:00:00.000Z` expires at `12:01:00.000Z`, as above).
- `model` — the realtime model id the token is scoped to.
- `wakeKey` — the raw `TODOMD_VOICE_WAKE_KEY`, passed straight to the
  vendored engine's `init()` call client-side. This is the one long-lived
  secret that *does* reach the browser by design — see "Credential flow"
  above for why, and what actually gates it.

**Response — 403** (not the primary desktop session):

```json
{ "error": "enable voice from the computer running todomd" }
```

**Response — 503** (either `TODOMD_VOICE_KEY` or `TODOMD_VOICE_WAKE_KEY` is
unset — `mintVoiceSession` returns `null`):

```json
{ "error": "voice not configured — set TODOMD_VOICE_KEY and TODOMD_VOICE_WAKE_KEY" }
```

`mintVoiceSession({ config, env, now })` (task-0036, `src/voice.js`) is the
single place that reads both env vars and either returns the object above or
`null`; the route just maps `null` → 503. It never returns the raw
`TODOMD_VOICE_KEY`; it does return the raw `TODOMD_VOICE_WAKE_KEY` verbatim
as `wakeKey`, per "Credential flow" above.

## Phrases and confirmation

Four fixed wake/control phrases, plus a small set of spoken intents parsed
only *after* the gate is open (`public/voice-commands.js`, task-0038):

| Phrase / intent | Kind | Read-only or board-changing | Confirmation required? |
|---|---|---|---|
| **Hey To-do** | wake — opens the gate, arms listening | read-only (no board effect) | No |
| **Yes To-do** | `confirm` — executes the one pending board-changing action | is itself the confirmation | No (it *is* the confirmation) |
| **Report To-do** | `report` — speaks a board status summary (`GET /api/voice/summary`) | read-only | No — executes immediately |
| **That is all To-do** | `signoff` — ends the session, stops the mic | read-only (no board effect) | No |
| Move a card to a stage / cancel a run / retry verify | `move`, `cancel`, `retry` | **board-changing** | **Yes** — spoken back, then held pending until `Yes To-do`; any other reply or a confirm timeout discards it, with zero fetches made |
| Anything unrecognized | `unknown` | read-only (no-op) | No |

Rule: **every board-changing intent is spoken back and must be confirmed with
`Yes To-do` before any fetch is made.** `Report To-do` is the one intent that
both reads the board *and* runs without confirmation, because it can't change
anything.

## Risks

The wake-word engine (Picovoice) and the realtime voice service both require
signing up for an account and provisioning an API key — that's a cost and
vendor decision for a human, not something to do inside this chunk. **No
signup was performed.** The exact env vars a human needs to provision before
the feature is usable:

- `TODOMD_VOICE_KEY` — realtime voice-service API key.
- `TODOMD_VOICE_WAKE_KEY` — Picovoice AccessKey.

Until both are set, the board boots normally and the mic button is present
but disabled with a visible reason (see "No-key fallback" above). This
signup decision is flagged here for a human rather than blocking the chunk.
