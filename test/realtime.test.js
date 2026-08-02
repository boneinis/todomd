// src/realtime.js is the only module that reads OPENAI_API_KEY and talks to
// OpenAI's Realtime endpoint. fetchFn/baseUrl/apiKey are all injected, so
// these tests never make a real network call.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildSessionConfig, createRealtimeSession } from '../src/realtime.js';

const OFFER = 'v=0\r\no=- 1 1 IN IP4 127.0.0.1\r\n';
const ANSWER = 'v=0\r\no=- 2 2 IN IP4 127.0.0.1\r\n';

function fakeFetchOk(body = ANSWER) {
  const calls = [];
  const fn = async (url, opts) => { calls.push({ url: String(url), opts }); return { ok: true, status: 200, text: async () => body }; };
  fn.calls = calls;
  return fn;
}

// Reads what the module ACTUALLY put on the wire the way the provider will:
// `POST /v1/realtime/calls` is a multipart form with an `sdp` field and a
// `session` field. Anything else (query params, a raw application/sdp body)
// fails here instead of quietly passing against a fixture that takes anything.
function readUpstreamCall(call) {
  const url = new URL(call.url);
  assert.ok(call.opts.body instanceof FormData, 'the Realtime call body must be a multipart FormData');
  const sdp = call.opts.body.get('sdp');
  const rawSession = call.opts.body.get('session');
  assert.equal(typeof rawSession, 'string', 'the session policy travels as a multipart `session` field');
  return { url, sdp, session: JSON.parse(rawSession) };
}

test('buildSessionConfig exposes exactly the read + propose tools, never a confirm or mutate tool', () => {
  const session = buildSessionConfig();
  const names = session.tools.map((t) => t.name).sort();
  assert.deepEqual(names, ['propose_board_action', 'read_board_report', 'read_card']);
  for (const tool of session.tools) {
    assert.doesNotMatch(tool.name, /confirm|mutate|move_card|resume_build|retry_verification|cancel_run|restart_build|archive/i);
  }
  assert.equal(session.model, 'gpt-realtime-2.1-mini');
  assert.equal(typeof session.instructions, 'string');
  assert.ok(session.instructions.length > 0);
  assert.match(session.instructions, /at most one board tool/i);
});

test('buildSessionConfig uses the current session schema, not the beta-era one', () => {
  const session = buildSessionConfig();
  assert.equal(session.type, 'realtime');
  // Transcription moved under `audio.input` when Realtime went GA; the old
  // top-level key is silently ignored, so a session built with it would run
  // with no input transcription at all — and the controller's sign-off /
  // offline phrases are driven entirely by that transcript.
  assert.equal(session.audio.input.transcription.model, 'whisper-1');
  assert.equal('input_audio_transcription' in session, false);
});

test('buildSessionConfig honors a model override without touching the tool policy', () => {
  const before = process.env.TODOMD_VOICE_MODEL;
  process.env.TODOMD_VOICE_MODEL = 'gpt-realtime-2.1';
  try {
    const session = buildSessionConfig();
    assert.equal(session.model, 'gpt-realtime-2.1');
    assert.equal(session.tools.length, 3);
  } finally {
    if (before === undefined) delete process.env.TODOMD_VOICE_MODEL; else process.env.TODOMD_VOICE_MODEL = before;
  }
});

test('missing OPENAI_API_KEY returns a bounded 503 without ever calling fetch', async () => {
  const fetchFn = fakeFetchOk();
  const result = await createRealtimeSession(OFFER, { fetchFn, apiKey: '' });
  assert.equal(result.status, 503);
  assert.equal(result.ok, false);
  assert.equal(result.error, 'voice is not configured');
  assert.equal(fetchFn.calls.length, 0);
});

test('malformed SDP is refused with 400 before any upstream call', async () => {
  const fetchFn = fakeFetchOk();
  for (const bad of ['', 'not sdp at all', 'x'.repeat(70_000), null, 42]) {
    const result = await createRealtimeSession(bad, { fetchFn, apiKey: 'sk-test' });
    assert.equal(result.status, 400, JSON.stringify(bad).slice(0, 20));
    assert.equal(result.ok, false);
  }
  assert.equal(fetchFn.calls.length, 0);
});

test('a successful exchange posts the documented multipart call request and returns only the SDP answer', async () => {
  const fetchFn = fakeFetchOk(ANSWER);
  const result = await createRealtimeSession(OFFER, { fetchFn, apiKey: 'sk-secret-value' });
  assert.equal(result.status, 200);
  assert.equal(result.ok, true);
  assert.equal(result.sdp, ANSWER);
  assert.equal(fetchFn.calls.length, 1);

  const { url, sdp, session } = readUpstreamCall(fetchFn.calls[0]);
  // The call endpoint takes NO query parameters: `model` and `session` are
  // multipart fields. The beta-era query-param form is rejected upstream, so
  // asserting the absence of a query string is the regression guard.
  assert.equal(url.search, '', 'the Realtime call endpoint takes no query parameters');
  assert.equal(url.pathname, '/v1/realtime/calls');
  assert.equal(sdp, OFFER);
  assert.deepEqual(session, buildSessionConfig());
  assert.equal(session.audio.input.transcription.model, 'whisper-1');
  assert.equal('input_audio_transcription' in session, false);

  // Only authorization is set by hand — a manual content-type would clobber
  // the multipart boundary fetch generates, and `openai-beta` is retired.
  assert.deepEqual(Object.keys(fetchFn.calls[0].opts.headers).map((k) => k.toLowerCase()), ['authorization']);
  assert.equal(fetchFn.calls[0].opts.headers.authorization, 'Bearer sk-secret-value');
  assert.doesNotMatch(String(url), /sk-secret-value/, 'the API key never travels in the URL');
  assert.doesNotMatch(JSON.stringify(result), /sk-secret-value/, 'the API key never appears in the returned object');
});

test('the outgoing session policy carries only the three allowed tools, never a confirm tool', async () => {
  const fetchFn = fakeFetchOk(ANSWER);
  await createRealtimeSession(OFFER, { fetchFn, apiKey: 'sk-test' });
  const { session } = readUpstreamCall(fetchFn.calls[0]);
  assert.deepEqual(session.tools.map((t) => t.name).sort(), ['propose_board_action', 'read_board_report', 'read_card']);
  assert.equal(session.tool_choice, 'auto');
});

test('a non-2xx upstream response becomes a bounded 503 without leaking the upstream body', async () => {
  const fetchFn = async () => ({ ok: false, status: 401, text: async () => 'invalid_api_key: sk-secret-upstream-value' });
  const result = await createRealtimeSession(OFFER, { fetchFn, apiKey: 'sk-test' });
  assert.equal(result.status, 503);
  assert.equal(result.error, 'voice service unavailable');
  assert.doesNotMatch(JSON.stringify(result), /sk-secret-upstream-value/);
});

test('an upstream response that is not itself SDP is treated as unavailable, not forwarded verbatim', async () => {
  const fetchFn = fakeFetchOk('{"error":"nope"}');
  const result = await createRealtimeSession(OFFER, { fetchFn, apiKey: 'sk-test' });
  assert.equal(result.status, 503);
  assert.equal(result.ok, false);
});

test('a network failure (not a timeout) is reported as bounded 503', async () => {
  const fetchFn = async () => { throw new Error('getaddrinfo ENOTFOUND api.openai.com'); };
  const result = await createRealtimeSession(OFFER, { fetchFn, apiKey: 'sk-test' });
  assert.equal(result.status, 503);
  assert.doesNotMatch(result.error, /ENOTFOUND/, 'raw network error detail is never forwarded to the caller');
});

test('a timeout is reported as 504 and the fetch call is aborted', async () => {
  const fetchFn = (url, opts) => new Promise((resolve, reject) => {
    opts.signal.addEventListener('abort', () => { const e = new Error('aborted'); e.name = 'AbortError'; reject(e); });
  });
  const result = await createRealtimeSession(OFFER, { fetchFn, apiKey: 'sk-test', timeoutMs: 10 });
  assert.equal(result.status, 504);
  assert.equal(result.error, 'voice service timed out');
});

test('an already-aborted client signal short-circuits without calling fetch', async () => {
  const fetchFn = fakeFetchOk();
  const ac = new AbortController();
  ac.abort();
  const result = await createRealtimeSession(OFFER, { fetchFn, apiKey: 'sk-test', signal: ac.signal });
  assert.equal(result.status, 504);
  assert.equal(fetchFn.calls.length, 0);
});

test('client disconnect while the upstream call is in flight aborts it and reports 504', async () => {
  const ac = new AbortController();
  const fetchFn = (url, opts) => new Promise((resolve, reject) => {
    opts.signal.addEventListener('abort', () => { const e = new Error('aborted'); e.name = 'AbortError'; reject(e); });
  });
  const promise = createRealtimeSession(OFFER, { fetchFn, apiKey: 'sk-test', signal: ac.signal, timeoutMs: 60_000 });
  ac.abort();
  const result = await promise;
  assert.equal(result.status, 504);
  assert.equal(result.error, 'client disconnected');
});

test('an invalid baseUrl fails closed as bounded 503 instead of throwing', async () => {
  const fetchFn = fakeFetchOk();
  const result = await createRealtimeSession(OFFER, { fetchFn, apiKey: 'sk-test', baseUrl: 'not a url' });
  assert.equal(result.status, 503);
  assert.equal(fetchFn.calls.length, 0);
});
