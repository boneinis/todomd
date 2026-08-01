// Protected post-wake Realtime session creation (docs/voice.md § Post-wake
// credential and transport flow). Called only from the primary-only
// `POST /api/voice/session` route in server.js. This module is the ONLY place
// the long-lived `OPENAI_API_KEY` is read — it forwards the browser's SDP
// offer to OpenAI with the server-owned session policy and returns just the
// SDP answer. The key never appears in a response, an error body, or a log.
const DEFAULT_MODEL = 'gpt-realtime-2.1-mini';
const DEFAULT_TRANSCRIBE_MODEL = 'whisper-1';
const DEFAULT_TIMEOUT_MS = 15_000;
const MAX_SDP_BYTES = 64 * 1024; // a browser SDP offer is a few KB; bound it generously

const INSTRUCTIONS = [
  'You are the TODOMD board voice assistant.',
  'Speak concisely. Use only the results of read_board_report, read_card, and',
  'propose_board_action for board facts — never invent card ids, statuses, or',
  'outcomes. You cannot execute or confirm any action yourself: propose it and',
  'let the human-facing confirmation flow decide. Never repeat, transcribe, or',
  'guess at credentials, tokens, file paths, or environment values.',
].join(' ');

// Read-only reports plus exactly one mutation-*proposal* function. Realtime
// never receives a confirm or direct board-mutation function — see
// docs/voice.md § Post-wake credential and transport flow.
const TOOLS = Object.freeze([
  {
    type: 'function',
    name: 'read_board_report',
    description: 'Speak a deterministic, sanitized summary of the current board.',
    parameters: { type: 'object', properties: {}, additionalProperties: false },
  },
  {
    type: 'function',
    name: 'read_card',
    description: 'Speak the status and a concise diagnostic for one card.',
    parameters: {
      type: 'object',
      properties: { cardId: { type: 'string' } },
      required: ['cardId'],
      additionalProperties: false,
    },
  },
  {
    type: 'function',
    name: 'propose_board_action',
    description: 'Propose (never execute) a board action; TODOMD returns the exact read-back and confirmation policy.',
    parameters: {
      type: 'object',
      properties: {
        cardId: { type: 'string' },
        action: { type: 'string' },
        arguments: { type: 'object' },
      },
      required: ['cardId', 'action'],
      additionalProperties: false,
    },
  },
]);

// Exported so a unit test can assert the exposed tool policy never grows a
// confirm/mutate function without reaching into the private request builder.
export function buildSessionConfig({ model = process.env.TODOMD_VOICE_MODEL || DEFAULT_MODEL } = {}) {
  return {
    type: 'realtime',
    model,
    instructions: INSTRUCTIONS,
    input_audio_transcription: { model: DEFAULT_TRANSCRIBE_MODEL },
    tools: TOOLS,
    tool_choice: 'auto',
  };
}

function looksLikeSdp(value) {
  return typeof value === 'string' && value.length > 0 && value.length <= MAX_SDP_BYTES && /^v=0\r?\n/.test(value);
}

// { status, ok, sdp } on success or { status, ok:false, error } — `error` is
// always a short, generic, bounded string; it never includes the upstream
// response body, headers, or the API key.
export async function createRealtimeSession(sdpOffer, {
  fetchFn = fetch,
  baseUrl = process.env.TODOMD_OPENAI_REALTIME_URL || 'https://api.openai.com/v1/realtime/calls',
  apiKey = process.env.OPENAI_API_KEY,
  timeoutMs = DEFAULT_TIMEOUT_MS,
  signal,
} = {}) {
  if (!apiKey) return { status: 503, ok: false, error: 'voice is not configured' };
  if (!looksLikeSdp(sdpOffer)) return { status: 400, ok: false, error: 'malformed SDP offer' };
  if (signal?.aborted) return { status: 504, ok: false, error: 'client disconnected' };

  const session = buildSessionConfig();
  let url;
  try {
    url = new URL(baseUrl);
  } catch {
    return { status: 503, ok: false, error: 'voice is not configured' };
  }
  url.searchParams.set('model', session.model);
  url.searchParams.set('session', JSON.stringify(session));

  const controller = new AbortController();
  const onAbort = () => controller.abort();
  signal?.addEventListener('abort', onAbort);
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const res = await fetchFn(url, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${apiKey}`,
        'content-type': 'application/sdp',
        'openai-beta': 'realtime=v1',
      },
      body: sdpOffer,
      signal: controller.signal,
    });
    if (!res.ok) return { status: 503, ok: false, error: 'voice service unavailable' };
    const answer = await res.text();
    if (!looksLikeSdp(answer)) return { status: 503, ok: false, error: 'voice service unavailable' };
    return { status: 200, ok: true, sdp: answer };
  } catch {
    if (signal?.aborted) return { status: 504, ok: false, error: 'client disconnected' };
    if (controller.signal.aborted) return { status: 504, ok: false, error: 'voice service timed out' };
    return { status: 503, ok: false, error: 'voice service unavailable' };
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener('abort', onAbort);
  }
}
