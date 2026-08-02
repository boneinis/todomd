import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import path from 'node:path';
import { isolateHome, makeRepo } from './helpers.js';
import { addProject } from '../src/registry.js';
import { startServer } from '../src/server.js';
import * as pipeline from '../src/pipeline.js';

after(async () => { try { await pipeline.killAllChildren({ graceMs: 1000 }); } catch { /* best effort */ } });

function freePort() {
  return new Promise((resolve, reject) => {
    const s = net.createServer();
    s.once('error', reject);
    s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => resolve(p)); });
  });
}
const deviceToken = (name) => fs.readFileSync(path.join(process.env.TODOMD_HOME, '.todomd', name), 'utf8').trim();

async function boot() {
  const repo = makeRepo();
  addProject(repo);
  const name = path.basename(repo);
  const srv = await startServer({ port: await freePort() });
  const base = `http://127.0.0.1:${srv.port}`;
  return { repo, name, base, srv, q: `?project=${encodeURIComponent(name)}` };
}

// A fixture standing in for OpenAI's /v1/realtime/calls: it decodes the
// request the same way the provider does — a multipart body with an `sdp`
// field and a `session` field — and replies with a fixed SDP answer, so the
// round trip never touches the real network or a real key.
function fixtureUpstream({ answer = 'v=0\r\no=- 2 2 IN IP4 127.0.0.1\r\n', status = 200, delayMs = 0 } = {}) {
  const requests = [];
  const server = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', async () => {
      const raw = Buffer.concat(chunks);
      let form = null;
      try {
        form = await new Response(raw, { headers: { 'content-type': String(req.headers['content-type'] || '') } }).formData();
      } catch { /* not a multipart body at all */ }
      let session = null;
      try { session = JSON.parse(form?.get('session')); } catch { /* absent or not JSON */ }
      requests.push({
        headers: req.headers,
        url: req.url,
        body: raw.toString('utf8'),
        sdp: form?.get('sdp') ?? null,
        session,
      });
      const send = () => {
        if (status !== 200) { res.writeHead(status, { 'content-type': 'text/plain' }); return res.end('upstream error detail sk-upstream-secret'); }
        res.writeHead(200, { 'content-type': 'application/sdp' });
        res.end(answer);
      };
      if (delayMs) setTimeout(send, delayMs); else send();
    });
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve({
      requests,
      url: `http://127.0.0.1:${server.address().port}/v1/realtime/calls`,
      close: () => new Promise((r) => server.close(r)),
    }));
  });
}

function withEnv(vars, fn) {
  const prev = {};
  for (const k of Object.keys(vars)) prev[k] = process.env[k];
  Object.assign(process.env, vars);
  return fn().finally(() => {
    for (const k of Object.keys(vars)) {
      if (prev[k] === undefined) delete process.env[k]; else process.env[k] = prev[k];
    }
  });
}

const OFFER = 'v=0\r\no=- 1 1 IN IP4 127.0.0.1\r\n';

test('POST /api/voice/session requires the primary desktop session — viewer 403 from the shared guard, mobile 403 from the route', async () => {
  isolateHome();
  const { base, srv, q } = await boot();
  const viewer = deviceToken('token-viewer'), mobile = deviceToken('token-mobile');
  try {
    let r = await fetch(`${base}/api/voice/session${q}`, {
      method: 'POST', headers: { 'x-todomd-token': viewer, 'content-type': 'application/sdp', origin: base }, body: OFFER,
    });
    assert.equal(r.status, 403);
    assert.match((await r.json()).error, /read-only link/);

    r = await fetch(`${base}/api/voice/session${q}`, {
      method: 'POST', headers: { 'x-todomd-token': mobile, 'content-type': 'application/sdp', origin: base }, body: OFFER,
    });
    assert.equal(r.status, 403);
    assert.match((await r.json()).error, /primary desktop session/);
  } finally { srv.close(); }
});

test('wrong content-type is refused with 400 before touching any upstream configuration', async () => {
  isolateHome();
  const { base, srv, q } = await boot();
  try {
    const r = await fetch(`${base}/api/voice/session${q}`, {
      method: 'POST', headers: { 'x-todomd-token': srv.token, 'content-type': 'application/json', origin: base }, body: JSON.stringify({ sdp: OFFER }),
    });
    assert.equal(r.status, 400);
    assert.match((await r.json()).error, /application\/sdp/);
  } finally { srv.close(); }
});

test('missing OPENAI_API_KEY returns a bounded 503, the primary desktop session, no upstream call possible', async () => {
  isolateHome();
  const { base, srv, q } = await boot();
  const prevKey = process.env.OPENAI_API_KEY;
  delete process.env.OPENAI_API_KEY;
  try {
    const r = await fetch(`${base}/api/voice/session${q}`, {
      method: 'POST', headers: { 'x-todomd-token': srv.token, 'content-type': 'application/sdp', origin: base }, body: OFFER,
    });
    assert.equal(r.status, 503);
    assert.deepEqual(await r.json(), { error: 'voice is not configured' });
  } finally {
    if (prevKey === undefined) delete process.env.OPENAI_API_KEY; else process.env.OPENAI_API_KEY = prevKey;
    srv.close();
  }
});

test('a full round trip against a fixture upstream returns only the SDP answer and never the key', async () => {
  isolateHome();
  const { base, srv, q } = await boot();
  const upstream = await fixtureUpstream();
  try {
    await withEnv({ OPENAI_API_KEY: 'sk-test-secret-value', TODOMD_OPENAI_REALTIME_URL: upstream.url }, async () => {
      const r = await fetch(`${base}/api/voice/session${q}`, {
        method: 'POST', headers: { 'x-todomd-token': srv.token, 'content-type': 'application/sdp', origin: base }, body: OFFER,
      });
      assert.equal(r.status, 200);
      assert.equal(r.headers.get('content-type'), 'application/sdp');
      const body = await r.text();
      assert.equal(body, 'v=0\r\no=- 2 2 IN IP4 127.0.0.1\r\n');
      assert.doesNotMatch(body, /sk-test-secret-value/);

      assert.equal(upstream.requests.length, 1);
      const call = upstream.requests[0];
      assert.equal(call.headers.authorization, 'Bearer sk-test-secret-value');
      // the documented call request: no query parameters, and the offer plus
      // the server-owned session policy as multipart fields
      assert.equal(call.url, '/v1/realtime/calls');
      assert.match(String(call.headers['content-type']), /^multipart\/form-data;\s*boundary=/);
      assert.equal(call.sdp, OFFER);
      assert.equal(call.session.type, 'realtime');
      assert.equal(call.session.audio.input.transcription.model, 'whisper-1');
      assert.equal('input_audio_transcription' in call.session, false);
      // the browser's own offer never carries the key, and neither does the URL
      assert.doesNotMatch(call.url, /sk-test-secret-value/);
    });
  } finally { await upstream.close(); srv.close(); }
});

test('an upstream failure becomes a bounded 503 and never leaks the upstream body or the key', async () => {
  isolateHome();
  const { base, srv, q } = await boot();
  const upstream = await fixtureUpstream({ status: 401 });
  try {
    await withEnv({ OPENAI_API_KEY: 'sk-test-secret-value', TODOMD_OPENAI_REALTIME_URL: upstream.url }, async () => {
      const r = await fetch(`${base}/api/voice/session${q}`, {
        method: 'POST', headers: { 'x-todomd-token': srv.token, 'content-type': 'application/sdp', origin: base }, body: OFFER,
      });
      assert.equal(r.status, 503);
      const text = await r.text();
      assert.doesNotMatch(text, /sk-test-secret-value/);
      assert.doesNotMatch(text, /sk-upstream-secret/);
    });
  } finally { await upstream.close(); srv.close(); }
});

test('a malformed SDP body is refused with 400 without reaching the upstream', async () => {
  isolateHome();
  const { base, srv, q } = await boot();
  const upstream = await fixtureUpstream();
  try {
    await withEnv({ OPENAI_API_KEY: 'sk-test-secret-value', TODOMD_OPENAI_REALTIME_URL: upstream.url }, async () => {
      const r = await fetch(`${base}/api/voice/session${q}`, {
        method: 'POST', headers: { 'x-todomd-token': srv.token, 'content-type': 'application/sdp', origin: base }, body: 'not an sdp offer',
      });
      assert.equal(r.status, 400);
      assert.equal(upstream.requests.length, 0);
    });
  } finally { await upstream.close(); srv.close(); }
});

test('a slow-but-under-timeout upstream still completes normally through the route', async () => {
  isolateHome();
  const { base, srv, q } = await boot();
  const upstream = await fixtureUpstream({ delayMs: 300 });
  try {
    await withEnv({ OPENAI_API_KEY: 'sk-test-secret-value', TODOMD_OPENAI_REALTIME_URL: upstream.url }, async () => {
      const r = await fetch(`${base}/api/voice/session${q}`, {
        method: 'POST', headers: { 'x-todomd-token': srv.token, 'content-type': 'application/sdp', origin: base }, body: OFFER,
      });
      assert.equal(r.status, 200);
      assert.equal(await r.text(), 'v=0\r\no=- 2 2 IN IP4 127.0.0.1\r\n');
    });
  } finally { await upstream.close(); srv.close(); }
});

test('a viewer may still read /api/voice/summary while voice/session stays primary-only (unaffected by this route)', async () => {
  isolateHome();
  const { base, srv, q } = await boot();
  const viewer = deviceToken('token-viewer');
  try {
    const r = await fetch(`${base}/api/voice/summary${q}`, { headers: { 'x-todomd-token': viewer } });
    assert.equal(r.status, 200);
  } finally { srv.close(); }
});
