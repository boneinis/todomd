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

test('a successful exchange forwards Authorization/content-type and returns only the SDP answer', async () => {
  const fetchFn = fakeFetchOk(ANSWER);
  const result = await createRealtimeSession(OFFER, { fetchFn, apiKey: 'sk-secret-value' });
  assert.equal(result.status, 200);
  assert.equal(result.ok, true);
  assert.equal(result.sdp, ANSWER);
  assert.equal(fetchFn.calls.length, 1);
  const { opts, url } = fetchFn.calls[0];
  assert.equal(opts.headers.authorization, 'Bearer sk-secret-value');
  assert.equal(opts.headers['content-type'], 'application/sdp');
  assert.equal(opts.body, OFFER);
  assert.doesNotMatch(JSON.stringify(result), /sk-secret-value/, 'the API key never appears in the returned object');
  assert.match(String(url), /model=gpt-realtime-2\.1-mini/);
});

test('the outgoing session policy carries only the three allowed tools, never a confirm tool', async () => {
  const fetchFn = fakeFetchOk(ANSWER);
  await createRealtimeSession(OFFER, { fetchFn, apiKey: 'sk-test' });
  const url = new URL(fetchFn.calls[0].url);
  const session = JSON.parse(url.searchParams.get('session'));
  assert.deepEqual(session.tools.map((t) => t.name).sort(), ['propose_board_action', 'read_board_report', 'read_card']);
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
