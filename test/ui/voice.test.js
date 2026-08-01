// Browser coverage for the board mic control (docs/voice.md). Node tests
// cannot see a real render or drive real DOM events, so this file exercises
// what only a browser can: the capability-unavailable path in an ACTUAL
// browser with no downloaded on-device speech model (no fakes at all), then
// the full wake → active → sign-off → offline lifecycle with injected
// WebRTC/SpeechRecognition/getUserMedia fakes and a real HTTP round trip
// through the server to a fixture OpenAI-shaped upstream. No real microphone,
// vendor account, or network call — see test/browser.js's presetScript.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import path from 'node:path';
import { isolateHome, makeRepo, writeCard, until, BUDGET } from '../helpers.js';
import { addProject } from '../../src/registry.js';
import { startServer } from '../../src/server.js';
import { openPage } from '../browser.js';

function freePort() {
  return new Promise((resolve, reject) => {
    const s = net.createServer();
    s.once('error', reject);
    s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => resolve(p)); });
  });
}

// A STRICT stand-in for OpenAI's /v1/realtime/calls. It accepts only the
// documented request — no query parameters, a multipart body with an `sdp`
// field and a `session` field in the current schema — and replies 400
// otherwise. A fixture that accepts anything would let the beta-era
// query-param/raw-SDP shape pass here while a real provider rejects it.
function fixtureUpstream() {
  const requests = [];
  const server = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', async () => {
      const contentType = String(req.headers['content-type'] || '');
      let form = null;
      try {
        form = await new Response(Buffer.concat(chunks), { headers: { 'content-type': contentType } }).formData();
      } catch { /* not a multipart body at all */ }
      const sdp = form?.get('sdp');
      let session = null;
      try { session = JSON.parse(form?.get('session')); } catch { /* absent or not JSON */ }
      requests.push({ url: req.url, contentType, sdp, session });

      const valid = !req.url.includes('?')
        && typeof sdp === 'string' && sdp.startsWith('v=0')
        && session?.type === 'realtime'
        && typeof session?.model === 'string'
        && typeof session?.audio?.input?.transcription?.model === 'string';
      if (!valid) {
        res.writeHead(400, { 'content-type': 'application/json' });
        return res.end(JSON.stringify({ error: { type: 'invalid_request_error' } }));
      }
      res.writeHead(200, { 'content-type': 'application/sdp' });
      res.end('v=0\r\no=- 2 2 IN IP4 127.0.0.1\r\n');
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

// Stringified via Function.prototype.toString() and handed to
// page.presetScript() — writing it as a real function (instead of a
// hand-escaped string) means the \r\n SDP line endings and class syntax below
// are checked by the same parser as the rest of this file.
function installVoiceFakes() {
  window.__voiceHooks = {
    recognitions: [],
    tracks: [],
    pcs: [],
    getUserMediaMode: 'ok', // 'ok' | 'deny'
  };

  class FakeSpeechRecognition {
    constructor() {
      this.processLocally = false;
      this.onstart = null; this.onresult = null; this.onerror = null; this.onend = null;
      window.__voiceHooks.recognitions.push(this);
    }
    start() { if (this.onstart) this.onstart(); }
    abort() {}
    result(transcript, isFinal) {
      const alt = { transcript, confidence: 0.9 };
      const res = Object.assign([alt], { isFinal: isFinal !== false });
      if (this.onresult) this.onresult({ resultIndex: 0, results: [res] });
    }
  }
  FakeSpeechRecognition.available = async () => 'available';
  window.SpeechRecognition = FakeSpeechRecognition;

  class FakeDataChannel {
    constructor() { this.listeners = {}; }
    addEventListener(type, fn) { this.listeners[type] = fn; }
    emit(type, payload) { if (this.listeners[type]) this.listeners[type](payload); }
    close() {}
  }
  class FakeRTCPeerConnection {
    constructor() {
      this.tracks = [];
      this.listeners = {};
      this.connectionState = 'connected';
      window.__voiceHooks.pcs.push(this);
    }
    addTrack(track) { this.tracks.push(track); }
    createDataChannel() { this.dataChannel = new FakeDataChannel(); return this.dataChannel; }
    addEventListener(type, fn) { this.listeners[type] = fn; }
    async createOffer() { return { type: 'offer', sdp: 'v=0\r\no=fake offer\r\n' }; }
    async setLocalDescription() {}
    async setRemoteDescription(desc) { this.remoteDescription = desc; }
    close() {}
  }
  window.RTCPeerConnection = FakeRTCPeerConnection;

  if (!navigator.mediaDevices) navigator.mediaDevices = {};
  navigator.mediaDevices.getUserMedia = async () => {
    if (window.__voiceHooks.getUserMediaMode === 'deny') {
      const e = new Error('Permission denied');
      e.name = 'NotAllowedError';
      throw e;
    }
    const track = { kind: 'audio', stopped: false, stop() { this.stopped = true; } };
    window.__voiceHooks.tracks.push(track);
    return { getAudioTracks: () => [track], getTracks: () => [track] };
  };
}

let page, srv, name, upstream;
const SKIP = 'no Chrome/Chromium found (set TODOMD_CHROME_BIN to run this)';

before(async () => {
  isolateHome();
  const repo = makeRepo();
  writeCard(repo, 'task-0001', { status: 'Review' });
  addProject(repo);
  name = path.basename(repo);
  page = await openPage();
  if (!page) return;
  upstream = await fixtureUpstream();
  process.env.OPENAI_API_KEY = 'sk-test-value';
  process.env.TODOMD_OPENAI_REALTIME_URL = upstream.url;
  srv = await startServer({ port: await freePort() });
});

after(async () => {
  try { await page?.close(); } catch { /* browser already gone */ }
  try { srv?.close(); } catch { /* already closed */ }
  try { await upstream?.close(); } catch { /* already closed */ }
  delete process.env.OPENAI_API_KEY;
  delete process.env.TODOMD_OPENAI_REALTIME_URL;
});

test('UI voice: with no local wake capability, the board leads with push-to-talk and stays usable', async (t) => {
  if (!page) return t.skip(SKIP);
  await page.goto(`http://127.0.0.1:${srv.port}/?token=${srv.token}&project=${encodeURIComponent(name)}`);
  await until(async () => (await page.eval(`document.querySelectorAll('.card').length`)) || null, { timeout: BUDGET.stage });

  // real headless Chrome has no downloaded on-device speech model in a fresh
  // profile — this exercises the true "missing local capability" path with
  // zero fakes installed, matching AC5 without mocking away the real gap.
  await until(async () => (await page.eval(`!document.getElementById('voice-ptt').hidden`)) || null, { timeout: BUDGET.stage });
  assert.equal(await page.eval(`document.getElementById('voice-btn').hidden`), true);
  assert.match(await page.eval(`document.getElementById('voice-diag').textContent`), /press and hold/);
  assert.deepEqual(page.errors, [], 'a missing capability never throws or logs a console error');
});

test('UI voice: arm, wake, active session, sign-off phrase, second wake, offline stops every track', async (t) => {
  if (!page) return t.skip(SKIP);
  await page.presetScript(`(${installVoiceFakes.toString()})();`);
  await page.goto(`http://127.0.0.1:${srv.port}/?token=${srv.token}&project=${encodeURIComponent(name)}`);
  await until(async () => (await page.eval(`document.querySelectorAll('.card').length`)) || null, { timeout: BUDGET.stage });
  await until(async () => (await page.eval(`!document.getElementById('voice-btn').hidden`)) || null, { timeout: BUDGET.stage });

  await page.eval(`document.getElementById('voice-btn').click()`);
  await until(async () => (await page.eval(`document.getElementById('voice-btn').dataset.voiceState`)) === 'armed' || null, { timeout: BUDGET.quick });
  assert.equal(await page.eval(`window.__voiceHooks.pcs.length`), 0, 'no transport before wake');

  await page.eval(`window.__voiceHooks.recognitions.at(-1).result('Hey To-do', true)`);
  await until(async () => (await page.eval(`document.getElementById('voice-btn').dataset.voiceState`)) === 'active' || null, { timeout: BUDGET.quick });
  assert.equal(await page.eval(`window.__voiceHooks.pcs.length`), 1);

  // the request that actually reached the provider-shaped upstream, through
  // the real server — the end of the "primary-only SDP endpoint" path
  const upstreamCall = upstream.requests.at(-1);
  assert.equal(upstreamCall.url, '/v1/realtime/calls', 'no query parameters reach the call endpoint');
  assert.match(upstreamCall.contentType, /^multipart\/form-data;\s*boundary=/);
  assert.equal('input_audio_transcription' in upstreamCall.session, false);
  assert.equal(upstreamCall.session.audio.input.transcription.model, 'whisper-1');

  await page.eval(`window.__voiceHooks.pcs.at(-1).dataChannel.emit('message', {
    data: JSON.stringify({ type: 'conversation.item.input_audio_transcription.completed', transcript: 'That is all, To-do' }),
  })`);
  await until(async () => (await page.eval(`document.getElementById('voice-btn').dataset.voiceState`)) === 'armed' || null, { timeout: BUDGET.quick });

  await page.eval(`window.__voiceHooks.recognitions.at(-1).result('Hey To-do', true)`);
  await until(async () => (await page.eval(`window.__voiceHooks.pcs.length`)) === 2 || null, { timeout: BUDGET.quick });
  await until(async () => (await page.eval(`document.getElementById('voice-btn').dataset.voiceState`)) === 'active' || null, { timeout: BUDGET.quick });

  await page.eval(`document.getElementById('voice-btn').click()`); // always-available off action while active
  await until(async () => (await page.eval(`document.getElementById('voice-btn').dataset.voiceState`)) === 'inactive' || null, { timeout: BUDGET.quick });

  const totalTracks = await page.eval(`window.__voiceHooks.tracks.length`);
  const stoppedTracks = await page.eval(`window.__voiceHooks.tracks.filter((t) => t.stopped).length`);
  assert.equal(totalTracks, 2, 'one microphone track per opened session');
  assert.equal(stoppedTracks, totalTracks, 'every acquired microphone track was stopped by offline');
  assert.deepEqual(page.errors, []);
});

test('UI voice: microphone denial after wake reveals push-to-talk with a diagnostic; the board stays usable', async (t) => {
  if (!page) return t.skip(SKIP);
  await page.goto(`http://127.0.0.1:${srv.port}/?token=${srv.token}&project=${encodeURIComponent(name)}`);
  await until(async () => (await page.eval(`document.querySelectorAll('.card').length`)) || null, { timeout: BUDGET.stage });
  await until(async () => (await page.eval(`!document.getElementById('voice-btn').hidden`)) || null, { timeout: BUDGET.stage });
  // the fallback starts hidden here: local wake IS available in this page, so
  // this test proves the failure itself reveals it, not the boot-time probe.
  assert.equal(await page.eval(`document.getElementById('voice-ptt').hidden`), true);

  await page.eval(`window.__voiceHooks.getUserMediaMode = 'deny'`);
  await page.eval(`document.getElementById('voice-btn').click()`);
  await until(async () => (await page.eval(`document.getElementById('voice-btn').dataset.voiceState`)) === 'armed' || null, { timeout: BUDGET.quick });
  await page.eval(`window.__voiceHooks.recognitions.at(-1).result('Hey To-do', true)`);

  await until(async () => (await page.eval(`document.getElementById('voice-btn').dataset.voiceState`)) === 'armed'
    && /denied/i.test(await page.eval(`document.getElementById('voice-diag').textContent`)) || null, { timeout: BUDGET.quick });
  await until(async () => (await page.eval(`!document.getElementById('voice-ptt').hidden`)) || null, { timeout: BUDGET.quick });
  assert.notEqual(await page.eval(`getComputedStyle(document.getElementById('voice-ptt')).display`), 'none',
    'a denied microphone must leave a usable way to talk to the board, not just a message');

  // the board itself stays fully usable — open a card
  await page.eval(`document.querySelector('[data-id="task-0001"]').click()`);
  await until(async () => (await page.eval(`!document.getElementById('drawer').hidden`)) || null, { timeout: BUDGET.quick });
  assert.deepEqual(page.errors, []);
});

test('UI voice: missing provider configuration after wake reveals push-to-talk; the board stays usable', async (t) => {
  if (!page) return t.skip(SKIP);
  const prevKey = process.env.OPENAI_API_KEY;
  delete process.env.OPENAI_API_KEY;
  try {
    await page.goto(`http://127.0.0.1:${srv.port}/?token=${srv.token}&project=${encodeURIComponent(name)}`);
    await until(async () => (await page.eval(`document.querySelectorAll('.card').length`)) || null, { timeout: BUDGET.stage });
    await until(async () => (await page.eval(`!document.getElementById('voice-btn').hidden`)) || null, { timeout: BUDGET.stage });
    assert.equal(await page.eval(`document.getElementById('voice-ptt').hidden`), true);

    await page.eval(`window.__voiceHooks.getUserMediaMode = 'ok'`);
    await page.eval(`document.getElementById('voice-btn').click()`);
    await until(async () => (await page.eval(`document.getElementById('voice-btn').dataset.voiceState`)) === 'armed' || null, { timeout: BUDGET.quick });
    await page.eval(`window.__voiceHooks.recognitions.at(-1).result('Hey To-do', true)`);

    await until(async () => (await page.eval(`document.getElementById('voice-btn').dataset.voiceState`)) === 'armed'
      && /not configured/i.test(await page.eval(`document.getElementById('voice-diag').textContent`)) || null, { timeout: BUDGET.quick });
    await until(async () => (await page.eval(`!document.getElementById('voice-ptt').hidden`)) || null, { timeout: BUDGET.quick });
    assert.notEqual(await page.eval(`getComputedStyle(document.getElementById('voice-ptt')).display`), 'none');

    // the board itself stays fully usable — open a card
    await page.eval(`document.querySelector('[data-id="task-0001"]').click()`);
    await until(async () => (await page.eval(`!document.getElementById('drawer').hidden`)) || null, { timeout: BUDGET.quick });
    assert.deepEqual(page.errors, []);
  } finally {
    process.env.OPENAI_API_KEY = prevKey;
  }
});

test('UI voice: switching to a different project disarms voice; reloading the SAME project does not', async (t) => {
  if (!page) return t.skip(SKIP);
  const repo2 = makeRepo();
  addProject(repo2);
  const name2 = path.basename(repo2);

  await page.presetScript(`(${installVoiceFakes.toString()})();`);
  await page.goto(`http://127.0.0.1:${srv.port}/?token=${srv.token}&project=${encodeURIComponent(name)}`);
  await until(async () => (await page.eval(`document.querySelectorAll('.card').length`)) || null, { timeout: BUDGET.stage });
  await until(async () => (await page.eval(`!document.getElementById('voice-btn').hidden`)) || null, { timeout: BUDGET.stage });

  await page.eval(`document.getElementById('voice-btn').click()`);
  await until(async () => (await page.eval(`document.getElementById('voice-btn').dataset.voiceState`)) === 'armed' || null, { timeout: BUDGET.quick });

  // an ordinary re-load of the SAME project (e.g. a periodic poll) must not disarm
  await page.eval(`loadBoard()`);
  await new Promise((resolve) => setTimeout(resolve, 300));
  assert.equal(await page.eval(`document.getElementById('voice-btn').dataset.voiceState`), 'armed',
    'reloading the same project/access context must not disarm an already-armed control');

  // switching to a DIFFERENT project must disarm — a live session or armed
  // recognizer must never outlive the board it was opened against
  await page.eval(`(() => {
    const sel = document.getElementById('project');
    sel.value = ${JSON.stringify(name2)};
    sel.dispatchEvent(new Event('change'));
  })()`);
  await until(async () => (await page.eval(`document.getElementById('voice-btn').dataset.voiceState`)) === 'inactive' || null, { timeout: BUDGET.quick });

  assert.deepEqual(page.errors, []);
});

test('UI voice: the board losing its current project also disarms voice', async (t) => {
  if (!page) return t.skip(SKIP);
  await page.presetScript(`(${installVoiceFakes.toString()})();`);
  await page.goto(`http://127.0.0.1:${srv.port}/?token=${srv.token}&project=${encodeURIComponent(name)}`);
  await until(async () => (await page.eval(`document.querySelectorAll('.card').length`)) || null, { timeout: BUDGET.stage });
  await until(async () => (await page.eval(`!document.getElementById('voice-btn').hidden`)) || null, { timeout: BUDGET.stage });

  await page.eval(`document.getElementById('voice-btn').click()`);
  await until(async () => (await page.eval(`document.getElementById('voice-btn').dataset.voiceState`)) === 'armed' || null, { timeout: BUDGET.quick });

  // the exact app.js path exercised when the last registered project goes away
  await page.eval(`currentProject = ''; loadBoard();`);
  await until(async () => (await page.eval(`document.getElementById('voice-btn').dataset.voiceState`)) === 'inactive' || null, { timeout: BUDGET.quick });
  assert.equal(await page.eval(`getComputedStyle(document.getElementById('voice-widget')).display`), 'none');

  assert.deepEqual(page.errors, []);
});

test('UI voice: a viewer link never shows the mic control', async (t) => {
  if (!page) return t.skip(SKIP);
  const viewerToken = fs.readFileSync(path.join(process.env.TODOMD_HOME, '.todomd', 'token-viewer'), 'utf8').trim();
  await page.goto(`http://127.0.0.1:${srv.port}/?token=${viewerToken}&project=${encodeURIComponent(name)}`);
  await until(async () => (await page.eval(`document.querySelectorAll('.card').length`)) || null, { timeout: BUDGET.stage });
  assert.equal(await page.eval(`getComputedStyle(document.getElementById('voice-widget')).display`), 'none');
  assert.deepEqual(page.errors, []);
});
