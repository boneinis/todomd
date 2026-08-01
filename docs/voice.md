# Voice control — spike and implementation contract

Status: Chrome/macOS capability gate pending
Date: 2026-08-01

TODOMD will provide a dedicated board voice controller. After one explicit
**Arm voice** action, the browser listens locally for **Hey To-do**, plays an
entry earcon, opens a short post-wake voice conversation, and returns to local
wake listening after **That is all, To-do**. It does not automate the Codex,
ChatGPT, Claude, Gemini, Siri, or Slack user interfaces.

This spike selects the dependency-free browser path conditionally: it becomes
the production wake engine only after the recorded Chrome/macOS hardware run
passes the reliability thresholds below.

## Wake engine decision

Repository constraints:

- plain browser ESM served directly from `public/`;
- no bundler or frontend build step;
- `node --test` must run without a microphone, account, key, or network;
- no pre-wake audio may leave the device; and
- the board must boot normally when voice is unavailable.

| Option | Local before wake | Added application dependency | Decision |
|---|---:|---:|---|
| Chrome on-device Web Speech API | Yes, when `processLocally` is required | None; Chrome manages the language pack | **Primary capability spike** |
| Picovoice Porcupine Web | Yes | Web package/runtime, custom keyword, account, browser-visible AccessKey | Fallback only if measured browser reliability fails |
| `onnxruntime-web` + openWakeWord | Yes | Runtime, model, browser feature-extraction/inference code, external training flow | Rejected for the first release |
| Apple `NSSpeechRecognizer` | Yes | No third-party library, but requires a separately shipped native Mac helper | Later cold-start option |

Chrome 139 added on-device Web Speech recognition. TODOMD's browser adapter
must require all of the following before it can arm:

1. `SpeechRecognition` is present.
2. A recognition instance exposes `processLocally`.
3. `SpeechRecognition.available({ langs: ["en-US"], processLocally: true })`
   reports `available`, or the explicit arm flow successfully completes
   `SpeechRecognition.install()` for that local pack.
4. The recognizer is created with `processLocally = true`.

Chrome 150's `SpeechRecognitionOptions.quality` permits the availability and
installation checks to request `quality: "command"`. Older local-capable
Chrome releases may retry those checks without the quality member, but they
must retain `processLocally: true`. No code path may retry with
`processLocally: false` or use the browser's remote speech service.

The adapter uses continuous recognition and interim results for visible
feedback only. It opens the wake gate only for a finalized result whose
normalized text is exactly `hey to do` or `hey todo`. Ordinary `end` events
restart with bounded backoff. Permission, policy, audio-capture, network,
language, and repeated-start errors stop arming and surface a local diagnostic.
Transcripts are not retained in diagnostics.

The implementation stays behind a replaceable `WakeWordEngine` contract:

```js
{
  init(),
  start(onWake),
  pause(),
  resume(),
  stop(),
  diagnostics()
}
```

Porcupine is not a first-release dependency. If the browser spike fails, a
separate decision must review its package/version, custom **Hey To-do** model,
AccessKey exposure, licensing, and privacy before adding it behind this same
interface.

### Hardware release gate

Run the isolated `npm run voice:spike` harness for at least four armed hours.
It must cover quiet speech, normal room noise, ordinary conversation, media
playback, tab backgrounding, and Mac sleep/wake. Chrome passes only with:

- at least 95% intended wakes in quiet conditions;
- at least 90% intended wakes in normal room noise;
- no more than one false wake in four armed hours; and
- automatic recovery after ordinary recognition ends and Mac sleep/wake.

Stable Edge remains capability-gated. It may arm only when the same local APIs
and model checks pass at runtime. Otherwise Edge receives push-to-talk; it may
not substitute its Azure-backed recognition while waiting for a wake phrase.
Safari is not a supported always-armed desktop browser in the first release.

## Privacy contract

- Before wake, recognition is required to run locally on the device.
- No TODOMD provider request or Realtime connection exists while merely armed.
- Local recognition stops before the post-wake Realtime microphone path opens.
- Only audio captured after wake may reach the configured provider.
- **That is all, To-do** closes the provider connection, clears pending state,
  plays the exit earcon, and returns to local `armed` wake listening.
- **Go offline, To-do**, the visible off control, navigation, or the armed
  lifetime limit stops all microphone capture and returns to `inactive`.
- The browser never silently falls back from local to remote pre-wake speech.
- Raw audio and transcript history are not logged.

The sign-off/offline distinction is required: if sign-off stopped every
microphone path, the page could not hear the next **Hey To-do** without another
click.

## Post-wake credential and transport flow

The long-lived `OPENAI_API_KEY` exists only in protected server environment
storage. It never appears in browser JavaScript, HTML, logs, errors, or an API
response. OpenAI API usage is separately metered from ChatGPT or Codex
subscriptions.

The selected first implementation uses a server-mediated WebRTC session setup:

```http
POST /api/voice/session?project=<project>
x-todomd-token: <primary desktop token>
Content-Type: application/sdp

v=0
...browser SDP offer...
```

The route:

1. requires the primary desktop token, valid loopback Host, and same-origin
   browser request;
2. rejects missing configuration with `503` and a bounded error;
3. adds the server-owned model, instructions, transcription, and tool policy;
4. forwards the SDP offer to OpenAI's Realtime calls endpoint with the
   server-side standard key; and
5. returns only the SDP answer.

The upstream call is the documented multipart request — no query parameters,
and no manual `content-type` (fetch owns the multipart boundary):

```http
POST https://api.openai.com/v1/realtime/calls
Authorization: Bearer <server-side standard key>
Content-Type: multipart/form-data; boundary=...

sdp=<browser SDP offer>
session={"type":"realtime","model":…,"audio":{"input":{"transcription":{…}}},"tools":[…]}
```

Transcription belongs under `audio.input.transcription`. The retired top-level
`input_audio_transcription` key is ignored rather than rejected, which would
leave the session with no input transcript — and the browser's sign-off and
offline phrases are driven entirely by that transcript.

Success:

```http
HTTP/1.1 200 OK
Content-Type: application/sdp

v=0
...provider SDP answer...
```

Bounded failures use JSON and never include upstream bodies or credentials:

```json
{ "error": "voice is not configured" }
```

Expected status codes are `400` for malformed SDP, `401` for an invalid token,
`403` for a valid but non-primary/viewer session or origin/host failure, `503`
for disabled configuration or bounded upstream unavailability, and `504` for
timeout. Client disconnect aborts upstream work.

The browser creates this connection only after local wake and closes it on
sign-off, idle timeout, offline, or connection failure. If the unified SDP
interface cannot be integrated safely, the reviewed fallback is a separate
server route that mints an OpenAI ephemeral client secret after wake. It still
keeps the standard key server-side and does not change the local wake contract.

Realtime receives only read functions and one proposal function:

```text
read_board_report()
read_card(cardId)
propose_board_action(cardId, action, arguments)
```

It never receives a confirm function or a direct board-mutation function.

## Phrases and confirmation

| Phrase or intent | Behavior | Confirmation |
|---|---|---|
| **Hey To-do** | Open the post-wake conversation and play the entry earcon. | None |
| **Report To-do** | Speak a deterministic, sanitized board summary. | None |
| Ask about a card | Speak status and a concise diagnostic. | None |
| Reversible workflow change | Prepare and read back the exact action. | **Yes To-do** |
| Start or resume an agent | Prepare and read back the exact action. | Fresh task-specific challenge phrase |
| Cancel, Restart Build, or archive | Prepare and display the exact action. | Visible approval in the first release |
| A move that would discard a preserved worktree | Prepare and display the exact action, naming the discard. | Visible approval |
| Retriage or send-back-to-Planned while a run is live | Refused at preparation; nothing is proposed. | Not offered |
| Any operation on an epic with unfinished children | Refused at preparation; nothing is proposed. | Not offered |
| **No To-do** or unrelated reply | Reject the pending proposal. | None |
| **That is all, To-do** | End active conversation and return to local wake listening. | None |
| **Go offline, To-do** | Stop all microphone capture. | None |

The tier is a property of the *effect on the current board*, not of the action
name. The same guarded call is several different operations depending on state —
moving a card to Review is a plain column move when the card is idle, a run
cancellation when it is live, a worktree deletion when it kept its build, and a
multi-card archive when it is an epic — so TODOMD probes that state at
preparation time and derives the tier, the eligibility answer, and the read-back
from it together. Two consequences are load-bearing:

- **Moves never cancel or cascade.** Retriage and send-back-to-Planned are
  refused outright while a run is live (including a chain claimed between
  spawns), and any epic with unfinished children is refused for both retriage and
  archive. Cancelling is reachable only through the explicit Cancel action and
  its own visible approval; epic-wide cleanup is not reachable by voice at all.
- **Read-backs state the whole effect.** Approve says "start the build" in
  launcher mode and "queue it for the dispatcher" in budget mode, because that is
  what Planned → Queue actually does in each. A move that discards a preserved
  worktree says so, and is raised to visible approval for the same reason.

TODOMD, not the model, owns proposal storage, read-back, confirmation matching,
expiry, revalidation, and dispatch. A proposal changes nothing. A confirmation
is single-use, short-lived, exact-token-bound, project-bound, request-bound,
and action-bound. The controller ignores assistant output and generic speech
that does not match the expected response. Revalidation covers everything the
policy was derived from — column, archived flag, live-run state, worktree
presence, unfinished-child count, and project mode — so a run that starts
between preparation and confirmation makes the proposal stale rather than
changing what the spoken phrase buys.

Voice may invoke only existing guarded board and recovery actions. It cannot
gain arbitrary Bash, filesystem, Git-write, source-edit, browser-automation,
model-change, deletion, or bulk-operation permission.

## Failure behavior

- Missing local capability: show **Local wake unavailable** and offer
  push-to-talk.
- Local language pack missing: offer installation only from explicit arming.
- Local recognition stops normally: restart with bounded backoff.
- Local recognition fails terminally: stop capture and show a bounded local
  diagnostic.
- Realtime unavailable after wake: play the error cue and return to local
  `armed`; do not transmit buffered pre-wake audio.
- Board mutation becomes stale or ineligible: explain the current state and
  execute nothing.
- The board always starts with Voice disabled by default and remains fully
  usable without voice configuration.

## References

- [Chrome 139: on-device Web Speech API](https://developer.chrome.com/release-notes/139)
- [Chrome 150: on-device recognition quality](https://developer.chrome.com/release-notes/150)
- [Web Speech API specification](https://webaudio.github.io/web-speech-api/)
- [Microsoft Edge local SpeechRecognition](https://learn.microsoft.com/en-us/microsoft-edge/web-platform/speech-recognition-api)
- [OpenAI Realtime with WebRTC](https://developers.openai.com/api/docs/guides/realtime-webrtc)
- [Picovoice Porcupine](https://picovoice.ai/docs/porcupine/)
- [Apple NSSpeechRecognizer](https://developer.apple.com/documentation/appkit/nsspeechrecognizer)
