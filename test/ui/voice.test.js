// Browser coverage for the board mic control (docs/voice.md). Node tests
// cannot see a real render or drive real DOM events, so this file exercises
// what only a browser can: the capability-unavailable and downloadable-pack
// paths in an actual browser, then
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
import { isolateHome, makeRepo, writeCard, until, BUDGET, useFakeAgent, clearFakeAgent, git } from '../helpers.js';
import { addProject } from '../../src/registry.js';
import { startServer } from '../../src/server.js';
import { openPage } from '../browser.js';

// Reads the router's function_call_output for one tool call id off the most
// recently opened data channel, or null while it hasn't arrived yet — for use
// with `until()`. Stringified and evaluated in the page like installVoiceFakes.
function readToolOutput(callId) {
  return `(() => {
    const sent = window.__voiceHooks.pcs.at(-1).dataChannel.sent;
    const entry = sent.map((s) => JSON.parse(s)).reverse()
      .find((e) => e.type === 'conversation.item.create' && e.item.call_id === ${JSON.stringify(callId)});
    return entry ? JSON.parse(entry.item.output) : null;
  })()`;
}

// Delivers one server event on the most recently opened fake data channel,
// exactly as it would arrive over a real one.
function emitEvent(event) {
  return `window.__voiceHooks.pcs.at(-1).dataChannel.emit('message', { data: ${JSON.stringify(JSON.stringify(event))} })`;
}

// The completed function-call event a real Realtime session sends when the
// model invokes one of the three exposed tools.
function emitToolCall(callId, name, args) {
  return emitEvent({
    type: 'response.output_item.done',
    item: { type: 'function_call', call_id: callId, name, arguments: JSON.stringify(args) },
  });
}

// The finalized-input-transcription event — the only signal the controller
// trusts for a spoken sign-off/offline/confirmation reply.
function emitTranscript(text) {
  return `(() => {
    const channel = window.__voiceHooks.pcs.at(-1).dataChannel;
    const itemId = 'voice-input-' + (window.__voiceInputSequence = (window.__voiceInputSequence || 0) + 1);
    channel.emit('message', { data: JSON.stringify({ type: 'input_audio_buffer.speech_started', item_id: itemId }) });
    channel.emit('message', { data: JSON.stringify({ type: 'conversation.item.input_audio_transcription.completed', item_id: itemId, transcript: ${JSON.stringify(text)} }) });
  })()`;
}

// The response lifecycle a real session emits after a propose_board_action
// tool call, in arrival order. TWO responses are involved, and telling them
// apart is the whole point:
//
//   1. the function-call response that carried the tool call finishes with its
//      OWN `response.done`. Preparing a proposal is an async POST, so this can
//      land after the router has already armed its read-back wait — a router
//      keying off any `response.done` opens the confirmation window here,
//      before the read-back has even started.
//   2. the router's `response.create` produces the read-back as a separate
//      response: `response.created` (naming its id), `response.done`
//      (generation finished), and only then `output_audio_buffer.stopped` —
//      on WebRTC the output audio is still draining until that event, and the
//      read-back speaks the challenge phrase aloud.
//
// Only the read-back's stopped event may open the confirmation window.
async function playReadback(page, tag) {
  const readbackId = await until(async () => (await page.eval(`(() => {
    const sent = window.__voiceHooks.pcs.at(-1).dataChannel.sent;
    const request = sent.map((entry) => JSON.parse(entry)).reverse()
      .find((event) => event.type === 'response.create' && event.response?.metadata?.todomd_readback_id);
    return request?.response.metadata.todomd_readback_id || null;
  })()`)) || null, { timeout: BUDGET.quick });
  await page.eval(emitEvent({ type: 'response.done', response: { id: `resp-tool-${tag}`, status: 'completed' } }));
  await page.eval(emitEvent({ type: 'response.created', response: { id: `resp-readback-${tag}`, metadata: { todomd_readback_id: readbackId } } }));
  await page.eval(emitEvent({ type: 'response.done', response: { id: `resp-readback-${tag}`, status: 'completed' } }));
  await page.eval(emitEvent({ type: 'output_audio_buffer.stopped', response_id: `resp-readback-${tag}` }));
}

// Records every state the mic control passes through. Polling can only show a
// state isn't entered right now; proving `confirming` was NEVER entered while
// a read-back was unverified needs the whole transition history.
function observeVoiceStates(page) {
  return page.eval(`(() => {
    window.__voiceStates = [];
    const btn = document.getElementById('voice-btn');
    new MutationObserver(() => window.__voiceStates.push(btn.dataset.voiceState))
      .observe(btn, { attributes: true, attributeFilter: ['data-voice-state'] });
  })()`);
}

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
    sessionRequests: [], // every fetch to /api/voice/session — the SDP endpoint itself, not just the fixture upstream it forwards to
    actionRequests: [],  // every fetch to the Actions API — prepare, confirm, and reject
    holdNextAction: false,
    releaseAction: null,
    getUserMediaMode: 'ok', // 'ok' | 'deny'
  };
  const realFetch = window.fetch.bind(window);
  window.fetch = (input, init) => {
    const url = String(typeof input === 'string' ? input : input.url);
    if (url.includes('/api/voice/session')) window.__voiceHooks.sessionRequests.push(url);
    if (url.includes('/api/voice/actions')) window.__voiceHooks.actionRequests.push(url);
    if (window.__voiceHooks.holdNextAction && /\/api\/voice\/actions\?/.test(url)) {
      window.__voiceHooks.holdNextAction = false;
      return new Promise((resolve) => {
        window.__voiceHooks.releaseAction = () => resolve(realFetch(input, init));
      });
    }
    return realFetch(input, init);
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
    constructor() { this.listeners = {}; this.sent = []; }
    addEventListener(type, fn) { this.listeners[type] = fn; }
    emit(type, payload) { if (this.listeners[type]) this.listeners[type](payload); }
    send(data) { this.sent.push(data); }
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
    const track = { kind: 'audio', enabled: true, stopped: false, stop() { this.stopped = true; } };
    window.__voiceHooks.tracks.push(track);
    return { getAudioTracks: () => [track], getTracks: () => [track] };
  };
}

function installDownloadableWakeFake() {
  window.__downloadableWake = { installed: false, installCalls: 0, recognitions: [] };
  class DownloadableSpeechRecognition {
    constructor() {
      this.processLocally = false;
      window.__downloadableWake.recognitions.push(this);
    }
    start() { this.onstart?.(); }
    abort() {}
  }
  DownloadableSpeechRecognition.available = async () => (
    window.__downloadableWake.installed ? 'available' : 'downloadable'
  );
  DownloadableSpeechRecognition.install = async () => {
    window.__downloadableWake.installCalls += 1;
    window.__downloadableWake.installed = true;
    return true;
  };
  window.SpeechRecognition = DownloadableSpeechRecognition;
}

function installUnavailableWakeFake() {
  // Chrome may expose a downloadable pack even in a fresh headless profile;
  // force the separate, truly-unavailable branch this test is about.
  window.SpeechRecognition = undefined;
  window.webkitSpeechRecognition = undefined;
}

let page, srv, name, upstream, repo;
const SKIP = 'no Chrome/Chromium found (set TODOMD_CHROME_BIN to run this)';

before(async () => {
  isolateHome();
  repo = makeRepo();
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
  await page.presetScript(`(${installUnavailableWakeFake.toString()})();`);
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

test('UI voice: a downloadable local pack keeps Arm reachable and installs only after the click', async (t) => {
  if (!page) return t.skip(SKIP);
  await page.presetScript(`(${installDownloadableWakeFake.toString()})();`);
  await page.goto(`http://127.0.0.1:${srv.port}/?token=${srv.token}&project=${encodeURIComponent(name)}`);
  await until(async () => (await page.eval(`document.querySelectorAll('.card').length`)) || null, { timeout: BUDGET.stage });
  await until(async () => (await page.eval(`!document.getElementById('voice-widget').hidden`)) || null, { timeout: BUDGET.stage });

  assert.equal(await page.eval(`document.getElementById('voice-btn').hidden`), false);
  assert.equal(await page.eval(`window.__downloadableWake.installCalls`), 0, 'the read-only boot probe never installs');
  assert.match(await page.eval(`document.getElementById('voice-diag').textContent`), /download available/);

  await page.eval(`document.getElementById('voice-btn').click()`);
  await until(async () => (await page.eval(`document.getElementById('voice-btn').dataset.voiceState`)) === 'armed' || null, { timeout: BUDGET.quick });
  assert.equal(await page.eval(`window.__downloadableWake.installCalls`), 1);
});

test('UI voice: a mobile full-control token does not show unusable desktop-only voice controls', async (t) => {
  if (!page) return t.skip(SKIP);
  const mobile = fs.readFileSync(path.join(process.env.TODOMD_HOME, '.todomd', 'token-mobile'), 'utf8').trim();
  await page.goto(`http://127.0.0.1:${srv.port}/?token=${mobile}&project=${encodeURIComponent(name)}`);
  await until(async () => (await page.eval(`document.querySelectorAll('.card').length`)) || null, { timeout: BUDGET.stage });
  assert.equal(await page.eval(`document.getElementById('voice-widget').hidden`), true);
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
  assert.equal(await page.eval(`window.__voiceHooks.tracks.length`), 0, 'no microphone track acquired before wake');
  assert.equal(await page.eval(`window.__voiceHooks.sessionRequests.length`), 0, 'no /api/voice/session request before wake');
  assert.equal(upstream.requests.length, 0, 'no request ever reached the provider-shaped upstream before wake');

  await page.eval(`window.__voiceHooks.recognitions.at(-1).result('Hey To-do', true)`);
  await until(async () => (await page.eval(`document.getElementById('voice-btn').dataset.voiceState`)) === 'active' || null, { timeout: BUDGET.quick });
  assert.equal(await page.eval(`window.__voiceHooks.pcs.length`), 1);
  assert.equal(await page.eval(`window.__voiceHooks.sessionRequests.length`), 1, 'wake opens exactly one /api/voice/session request');

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

// Shared by the command-routing tests below: arm, wake, and wait for `active`
// so each test starts from an open post-wake session with a real data channel.
async function armAndActivate(page) {
  await page.eval(`document.getElementById('voice-btn').click()`);
  await until(async () => (await page.eval(`document.getElementById('voice-btn').dataset.voiceState`)) === 'armed' || null, { timeout: BUDGET.quick });
  await page.eval(`window.__voiceHooks.recognitions.at(-1).result('Hey To-do', true)`);
  await until(async () => (await page.eval(`document.getElementById('voice-btn').dataset.voiceState`)) === 'active' || null, { timeout: BUDGET.quick });
}

async function cardStatus(page, id) {
  return page.eval(`fetch('/api/cards/${id}?project=${encodeURIComponent(name)}', {
    headers: { 'x-todomd-token': sessionStorage.getItem('todomd-token') },
  }).then((r) => r.json()).then((c) => c.data.status)`);
}

test('UI voice: read_board_report and read_card relay exactly the deterministic server text', async (t) => {
  if (!page) return t.skip(SKIP);
  await page.presetScript(`(${installVoiceFakes.toString()})();`);
  await page.goto(`http://127.0.0.1:${srv.port}/?token=${srv.token}&project=${encodeURIComponent(name)}`);
  await until(async () => (await page.eval(`document.querySelectorAll('.card').length`)) || null, { timeout: BUDGET.stage });
  await armAndActivate(page);

  await page.eval(emitToolCall('call-report', 'read_board_report', {}));
  await until(async () => (await page.eval(readToolOutput('call-report'))) || null, { timeout: BUDGET.quick });
  const report = await page.eval(readToolOutput('call-report'));
  assert.equal(report.ok, true);
  assert.match(report.text, /card.* on the board/);
  assert.equal('counts' in report, false, 'only the deterministic text is exposed to the model, not raw structured data');

  await page.eval(emitToolCall('call-card', 'read_card', { cardId: 'task-0001' }));
  await until(async () => (await page.eval(readToolOutput('call-card'))) || null, { timeout: BUDGET.quick });
  const cardReport = await page.eval(readToolOutput('call-card'));
  assert.equal(cardReport.ok, true);
  assert.match(cardReport.text, /task-0001/);

  await page.eval(emitToolCall('call-missing', 'read_card', { cardId: 'task-9999' }));
  await until(async () => (await page.eval(readToolOutput('call-missing'))) || null, { timeout: BUDGET.quick });
  assert.equal((await page.eval(readToolOutput('call-missing'))).ok, false, 'an unknown card is reported, not invented');

  await page.eval(`document.getElementById('voice-btn').click()`); // offline cleanup
  assert.deepEqual(page.errors, []);
});

test('UI voice: a reversible proposal reads back the exact action and executes only after "Yes To-do"', async (t) => {
  if (!page) return t.skip(SKIP);
  writeCard(repo, 'task-0010', { status: 'Needs Human', title: 'retry candidate' });
  await page.presetScript(`(${installVoiceFakes.toString()})();`);
  await page.goto(`http://127.0.0.1:${srv.port}/?token=${srv.token}&project=${encodeURIComponent(name)}`);
  await until(async () => (await page.eval(`document.querySelectorAll('.card').length`)) || null, { timeout: BUDGET.stage });
  await armAndActivate(page);

  await page.eval(emitToolCall('call-p1', 'propose_board_action', { cardId: 'task-0010', action: 'retry_planned' }));
  await until(async () => (await page.eval(readToolOutput('call-p1'))) || null, { timeout: BUDGET.quick });
  const proposal = await page.eval(readToolOutput('call-p1'));
  assert.equal(proposal.ok, true);
  assert.equal(proposal.confirmation.tier, 'reversible');
  assert.equal(proposal.confirmation.phrase, 'Yes To-do');
  assert.match(proposal.readback, /task-0010 back to Planned/);
  assert.equal(await page.eval(`document.getElementById('voice-btn').dataset.voiceState`), 'active',
    'the confirmation window must not open before the readback finishes playing');
  await playReadback(page, 'p1'); // the model finishes speaking the readback
  await until(async () => (await page.eval(`document.getElementById('voice-btn').dataset.voiceState`)) === 'confirming' || null, { timeout: BUDGET.quick });

  await page.eval(emitTranscript('Yes To-do'));
  await until(async () => (await page.eval(`document.getElementById('voice-btn').dataset.voiceState`)) === 'active' || null, { timeout: BUDGET.quick });
  assert.equal(await cardStatus(page, 'task-0010'), 'Planned', 'the confirmed action executed exactly once');

  // a second, later "Yes To-do" with nothing pending must do nothing
  await page.eval(emitTranscript('Yes To-do'));
  await new Promise((r) => setTimeout(r, 200));
  assert.equal(await cardStatus(page, 'task-0010'), 'Planned');

  await page.eval(`document.getElementById('voice-btn').click()`);
  assert.deepEqual(page.errors, []);
});

test('UI voice: an unrelated reply rejects the pending proposal instead of confirming it', async (t) => {
  if (!page) return t.skip(SKIP);
  writeCard(repo, 'task-0011', { status: 'Needs Human', title: 'reject candidate' });
  await page.presetScript(`(${installVoiceFakes.toString()})();`);
  await page.goto(`http://127.0.0.1:${srv.port}/?token=${srv.token}&project=${encodeURIComponent(name)}`);
  await until(async () => (await page.eval(`document.querySelectorAll('.card').length`)) || null, { timeout: BUDGET.stage });
  await armAndActivate(page);

  await page.eval(emitToolCall('call-p2', 'propose_board_action', { cardId: 'task-0011', action: 'retry_planned' }));
  await until(async () => (await page.eval(readToolOutput('call-p2'))) || null, { timeout: BUDGET.quick });
  await playReadback(page, 'p2');
  await until(async () => (await page.eval(`document.getElementById('voice-btn').dataset.voiceState`)) === 'confirming' || null, { timeout: BUDGET.quick });

  await page.eval(emitTranscript('what is the weather today'));
  await until(async () => (await page.eval(`document.getElementById('voice-btn').dataset.voiceState`)) === 'active' || null, { timeout: BUDGET.quick });
  assert.equal(await cardStatus(page, 'task-0011'), 'Needs Human', 'an unrelated reply must execute nothing');

  await page.eval(`document.getElementById('voice-btn').click()`);
  assert.deepEqual(page.errors, []);
});

test('UI voice: the tool call\'s own response finishing cannot open the confirmation window before the read-back has played', async (t) => {
  if (!page) return t.skip(SKIP);
  writeCard(repo, 'task-0015', { status: 'Needs Human', title: 'premature confirmation candidate' });
  await page.presetScript(`(${installVoiceFakes.toString()})();`);
  await page.goto(`http://127.0.0.1:${srv.port}/?token=${srv.token}&project=${encodeURIComponent(name)}`);
  await until(async () => (await page.eval(`document.querySelectorAll('.card').length`)) || null, { timeout: BUDGET.stage });
  await armAndActivate(page);
  await observeVoiceStates(page);

  await page.eval(emitToolCall('call-race', 'propose_board_action', { cardId: 'task-0015', action: 'retry_planned' }));
  // Once the tool result is visible the router has armed its read-back wait,
  // so everything below reproduces the real post-arming event ordering.
  await until(async () => (await page.eval(readToolOutput('call-race'))) || null, { timeout: BUDGET.quick });
  const readbackId = await until(async () => (await page.eval(`(() => {
    const sent = window.__voiceHooks.pcs.at(-1).dataChannel.sent;
    const request = sent.map((entry) => JSON.parse(entry)).reverse()
      .find((event) => event.type === 'response.create' && event.response?.metadata?.todomd_readback_id);
    return request?.response.metadata.todomd_readback_id || null;
  })()`)) || null, { timeout: BUDGET.quick });

  // The function-call response finishes — generation AND playback — with its
  // own id. Neither event belongs to the read-back.
  await page.eval(emitEvent({ type: 'response.done', response: { id: 'resp-tool-race', status: 'completed' } }));
  await page.eval(emitEvent({ type: 'output_audio_buffer.stopped', response_id: 'resp-tool-race' }));
  await page.eval(emitEvent({ type: 'response.created', response: { id: 'resp-unrelated-race', metadata: { todomd_readback_id: 'unrelated' } } }));
  await page.eval(emitEvent({ type: 'response.done', response: { id: 'resp-unrelated-race', status: 'completed' } }));
  await page.eval(emitEvent({ type: 'output_audio_buffer.stopped', response_id: 'resp-unrelated-race' }));
  await page.eval(emitEvent({ type: 'input_audio_buffer.speech_started', item_id: 'readback-echo' }));

  // The assistant is still speaking the read-back, which says the challenge
  // phrase aloud: a transcript landing now is its own echo, not the human's
  // answer, and must be able to execute nothing.
  await page.eval(emitTranscript('Yes To-do'));
  await new Promise((r) => setTimeout(r, 200));
  assert.equal(await cardStatus(page, 'task-0015'), 'Needs Human',
    'nothing can be confirmed while the read-back is still playing');
  assert.equal(await page.eval(`window.__voiceStates.includes('confirming')`), false,
    'the confirmation window never opened on another response finishing');

  // The read-back's own generation completing is still not enough on WebRTC —
  // only its drained output audio is.
  await page.eval(emitEvent({ type: 'response.created', response: { id: 'resp-readback-race', metadata: { todomd_readback_id: readbackId } } }));
  await page.eval(emitEvent({ type: 'response.done', response: { id: 'resp-readback-race', status: 'completed' } }));
  await new Promise((r) => setTimeout(r, 200));
  assert.equal(await page.eval(`window.__voiceStates.includes('confirming')`), false,
    'generation complete is not finished speaking');

  await page.eval(emitEvent({ type: 'output_audio_buffer.stopped', response_id: 'resp-readback-race' }));
  await until(async () => (await page.eval(`document.getElementById('voice-btn').dataset.voiceState`)) === 'confirming' || null, { timeout: BUDGET.quick });

  // Transcription is asynchronous: audio captured during the read-back can
  // finish transcribing only after confirmation opens. Its exact echoed phrase
  // is still pre-window input and must not execute anything.
  await page.eval(emitEvent({ type: 'conversation.item.input_audio_transcription.completed', item_id: 'readback-echo', transcript: 'Yes To-do' }));
  await new Promise((r) => setTimeout(r, 200));
  assert.equal(await cardStatus(page, 'task-0015'), 'Needs Human');
  assert.equal(await page.eval(`document.getElementById('voice-btn').dataset.voiceState`), 'confirming');

  // The same phrase, now heard for real after the read-back, confirms — the
  // human got the full confirmation window, not what was left of it.
  await page.eval(emitTranscript('Yes To-do'));
  await until(async () => (await page.eval(`document.getElementById('voice-btn').dataset.voiceState`)) === 'active' || null, { timeout: BUDGET.quick });
  assert.equal(await cardStatus(page, 'task-0015'), 'Planned');

  await page.eval(`document.getElementById('voice-btn').click()`);
  assert.deepEqual(page.errors, []);
});

test('UI voice: sign-off fences an in-flight proposal from the next conversation', async (t) => {
  if (!page) return t.skip(SKIP);
  writeCard(repo, 'task-0017', { status: 'Needs Human', title: 'session fence candidate' });
  await page.presetScript(`(${installVoiceFakes.toString()})();`);
  await page.goto(`http://127.0.0.1:${srv.port}/?token=${srv.token}&project=${encodeURIComponent(name)}`);
  await until(async () => (await page.eval(`document.querySelectorAll('.card').length`)) || null, { timeout: BUDGET.stage });
  await armAndActivate(page);

  await page.eval(`window.__voiceHooks.holdNextAction = true`);
  await page.eval(emitToolCall('old-call', 'propose_board_action', { cardId: 'task-0017', action: 'retry_planned' }));
  await until(async () => (await page.eval(`window.__voiceHooks.actionRequests.length`)) > 0 || null, { timeout: BUDGET.quick });
  await page.eval(emitTranscript('That is all, To-do'));
  await until(async () => (await page.eval(`document.getElementById('voice-btn').dataset.voiceState`)) === 'armed' || null, { timeout: BUDGET.quick });

  await page.eval(`window.__voiceHooks.recognitions.at(-1).result('Hey To-do', true)`);
  await until(async () => (await page.eval(`window.__voiceHooks.pcs.length`)) === 2 || null, { timeout: BUDGET.quick });
  await until(async () => (await page.eval(`document.getElementById('voice-btn').dataset.voiceState`)) === 'active' || null, { timeout: BUDGET.quick });
  await page.eval(`window.__voiceHooks.releaseAction()`);
  await until(async () => (await page.eval(
    `window.__voiceHooks.actionRequests.some((url) => url.includes('/reject'))`,
  )) || null, { timeout: BUDGET.quick });

  assert.equal(await page.eval(`(() => {
    const sent = window.__voiceHooks.pcs.at(-1).dataChannel.sent.map((entry) => JSON.parse(entry));
    return sent.some((event) => event.type === 'conversation.item.create' && event.item?.call_id === 'old-call');
  })()`), false, 'the old result never enters the new data channel');
  assert.equal(await cardStatus(page, 'task-0017'), 'Needs Human');
  await page.eval(`document.getElementById('voice-btn').click()`);
  assert.deepEqual(page.errors, []);
});

test('UI voice: a read-back that never finishes playing releases the proposal instead of opening a confirmation window', async (t) => {
  if (!page) return t.skip(SKIP);
  writeCard(repo, 'task-0016', { status: 'Needs Human', title: 'lost read-back candidate' });
  await page.presetScript(`(${installVoiceFakes.toString()})();`);
  await page.goto(`http://127.0.0.1:${srv.port}/?token=${srv.token}&project=${encodeURIComponent(name)}`);
  await until(async () => (await page.eval(`document.querySelectorAll('.card').length`)) || null, { timeout: BUDGET.stage });
  await armAndActivate(page);
  await observeVoiceStates(page);

  await page.eval(emitToolCall('call-lost', 'propose_board_action', { cardId: 'task-0016', action: 'retry_planned' }));
  await until(async () => (await page.eval(readToolOutput('call-lost'))) || null, { timeout: BUDGET.quick });
  const readbackId = await until(async () => (await page.eval(`(() => {
    const sent = window.__voiceHooks.pcs.at(-1).dataChannel.sent;
    const request = sent.map((entry) => JSON.parse(entry)).reverse()
      .find((event) => event.type === 'response.create' && event.response?.metadata?.todomd_readback_id);
    return request?.response.metadata.todomd_readback_id || null;
  })()`)) || null, { timeout: BUDGET.quick });
  const rejectsBefore = await page.eval(`window.__voiceHooks.actionRequests.filter((u) => u.includes('/reject')).length`);

  // The read-back is created and generated, but its finished-playing event
  // never arrives — the data channel died mid-turn.
  await page.eval(emitEvent({ type: 'response.done', response: { id: 'resp-tool-lost', status: 'completed' } }));
  await page.eval(emitEvent({ type: 'response.created', response: { id: 'resp-readback-lost', metadata: { todomd_readback_id: readbackId } } }));
  await page.eval(emitEvent({ type: 'response.done', response: { id: 'resp-readback-lost', status: 'completed' } }));

  // The router's bounded wait elapses and releases the reservation rather than
  // asking the human to confirm something they may never have heard.
  await until(async () => (await page.eval(
    `window.__voiceHooks.actionRequests.filter((u) => u.includes('/reject')).length`,
  )) > rejectsBefore || null, { timeout: BUDGET.stage });
  assert.equal(await page.eval(`window.__voiceStates.includes('confirming')`), false,
    'an unverified read-back must never open a confirmation window');
  assert.equal(await cardStatus(page, 'task-0016'), 'Needs Human');

  // and the released proposal cannot be revived by saying the phrase after
  await page.eval(emitTranscript('Yes To-do'));
  await new Promise((r) => setTimeout(r, 200));
  assert.equal(await cardStatus(page, 'task-0016'), 'Needs Human', 'a released proposal executes nothing');

  await page.eval(`document.getElementById('voice-btn').click()`);
  assert.deepEqual(page.errors, []);
});

test('UI voice: Resume Build continues the preserved worktree via its spoken challenge; Restart Build stays visible-approval-only', async (t) => {
  if (!page) return t.skip(SKIP);
  useFakeAgent({ verdict: 'pass', build: 'good' });
  try {
    const base = git(repo, ['rev-parse', '--abbrev-ref', 'HEAD']);
    const branch = 'todomd/task-0012';
    const wt = path.join(repo, '.todomd/worktrees/task-0012');
    writeCard(repo, 'task-0012', {
      status: 'Needs Human',
      extra: `needs_human_reason: orphaned_run\nrecovery_stage: Build\nworktree: ${branch}\nbase_branch: ${base}\nsession_id: fake-session-0012\n`,
    });
    git(repo, ['worktree', 'add', '-q', '-b', branch, wt]);
    // an orphaned card with the SAME recovery reason but no surviving worktree
    // — restart_build's only eligible target, and never voice-confirmable
    writeCard(repo, 'task-0013', {
      status: 'Needs Human',
      extra: 'needs_human_reason: orphaned_run\nrecovery_stage: Build\nworktree: todomd/task-0013\nsession_id: fake-session-0013\n',
    });

    await page.presetScript(`(${installVoiceFakes.toString()})();`);
    await page.goto(`http://127.0.0.1:${srv.port}/?token=${srv.token}&project=${encodeURIComponent(name)}`);
    await until(async () => (await page.eval(`document.querySelectorAll('.card').length`)) || null, { timeout: BUDGET.stage });
    await armAndActivate(page);

    // Resume Build: agent tier — the vague "yes" a bare confirmation would
    // accept for a reversible move must NOT be enough here. One reply always
    // settles (confirms or rejects) a proposal's one-shot window, so a
    // mismatched "yes" rejects the first proposal outright; re-propose for the
    // successful path rather than expecting a second chance on the same one.
    await page.eval(emitToolCall('call-resume-1', 'propose_board_action', { cardId: 'task-0012', action: 'resume_build' }));
    await until(async () => (await page.eval(readToolOutput('call-resume-1'))) || null, { timeout: BUDGET.quick });
    const firstAttempt = await page.eval(readToolOutput('call-resume-1'));
    assert.equal(firstAttempt.confirmation.tier, 'agent');
    assert.match(firstAttempt.readback, /resume the build for task-0012 in its preserved worktree/);
    assert.match(firstAttempt.confirmation.challenge, /^Confirm resume build task-0012 /);
    await playReadback(page, 'resume-1');
    await until(async () => (await page.eval(`document.getElementById('voice-btn').dataset.voiceState`)) === 'confirming' || null, { timeout: BUDGET.quick });

    await page.eval(emitTranscript('yes'));
    await until(async () => (await page.eval(`document.getElementById('voice-btn').dataset.voiceState`)) === 'active' || null, { timeout: BUDGET.quick });
    assert.equal(await cardStatus(page, 'task-0012'), 'Needs Human', 'a bare "yes" cannot confirm an agent-starting action');

    await page.eval(emitToolCall('call-resume-2', 'propose_board_action', { cardId: 'task-0012', action: 'resume_build' }));
    await until(async () => (await page.eval(readToolOutput('call-resume-2'))) || null, { timeout: BUDGET.quick });
    const secondAttempt = await page.eval(readToolOutput('call-resume-2'));
    const challenge = secondAttempt.confirmation.challenge;
    assert.notEqual(challenge, firstAttempt.confirmation.challenge, 'a fresh proposal gets a fresh, unpredictable challenge');
    await playReadback(page, 'resume-2');
    await until(async () => (await page.eval(`document.getElementById('voice-btn').dataset.voiceState`)) === 'confirming' || null, { timeout: BUDGET.quick });

    await page.eval(emitTranscript(challenge));
    await until(async () => (await page.eval(`document.getElementById('voice-btn').dataset.voiceState`)) === 'active' || null, { timeout: BUDGET.quick });
    await until(async () => (await cardStatus(page, 'task-0012')) === 'Done' || null, { timeout: BUDGET.chain });
    assert.ok(!fs.existsSync(wt), 'successful completion still cleans up the preserved worktree');

    // Restart Build: visible tier only — proposing it must not enter voice
    // confirmation at all, so no spoken phrase (even a plausible-looking one)
    // can ever execute it.
    await page.eval(emitToolCall('call-restart', 'propose_board_action', { cardId: 'task-0013', action: 'restart_build' }));
    await until(async () => (await page.eval(readToolOutput('call-restart'))) || null, { timeout: BUDGET.quick });
    const restartProposal = await page.eval(readToolOutput('call-restart'));
    assert.equal(restartProposal.ok, true);
    assert.equal(restartProposal.requiresVisibleApproval, true);
    assert.equal('confirmation' in restartProposal, false, 'no spoken confirmation object is offered for a visible-only action');
    assert.equal(await page.eval(`document.getElementById('voice-btn').dataset.voiceState`), 'active',
      'a visible-tier proposal never enters the confirming state');

    await page.eval(emitTranscript('Yes To-do'));
    await new Promise((r) => setTimeout(r, 200));
    assert.equal(await cardStatus(page, 'task-0013'), 'Needs Human', 'restart_build can never execute from a spoken phrase');

    await page.eval(`document.getElementById('voice-btn').click()`);
    assert.deepEqual(page.errors, []);
  } finally {
    clearFakeAgent();
  }
});

test('UI voice: Retry Verification reruns only Verify in the preserved worktree via its spoken challenge', async (t) => {
  if (!page) return t.skip(SKIP);
  useFakeAgent({ verdict: 'pass', build: 'good' });
  try {
    const base = git(repo, ['rev-parse', '--abbrev-ref', 'HEAD']);
    const branch = 'todomd/task-0014';
    const wt = path.join(repo, '.todomd/worktrees/task-0014');
    writeCard(repo, 'task-0014', {
      status: 'Needs Human',
      extra: `needs_human_reason: bad_verdict\nworktree: ${branch}\nbase_branch: ${base}\nsession_id: fake-session-0014\n`,
    });
    git(repo, ['worktree', 'add', '-q', '-b', branch, wt]);

    await page.presetScript(`(${installVoiceFakes.toString()})();`);
    await page.goto(`http://127.0.0.1:${srv.port}/?token=${srv.token}&project=${encodeURIComponent(name)}`);
    await until(async () => (await page.eval(`document.querySelectorAll('.card').length`)) || null, { timeout: BUDGET.stage });
    await armAndActivate(page);

    // The fake Build stage appends a `prod` function to src/calc.js and
    // commits it (test/fixtures/fake-agent.js); Verify never touches it. An
    // unchanged file after completion is direct proof Build never reran —
    // stronger than a log-file check, since a successful buffered Verify
    // pass writes no jsonl tee at all.
    const calcPath = path.join(repo, 'src/calc.js');
    const calcBefore = fs.readFileSync(calcPath, 'utf8');

    await page.eval(emitToolCall('call-retry-verify', 'propose_board_action', { cardId: 'task-0014', action: 'retry_verification' }));
    await until(async () => (await page.eval(readToolOutput('call-retry-verify'))) || null, { timeout: BUDGET.quick });
    const proposal = await page.eval(readToolOutput('call-retry-verify'));
    assert.equal(proposal.confirmation.tier, 'agent');
    assert.match(proposal.readback, /retry verification for task-0014 in its preserved worktree/);
    const challenge = proposal.confirmation.challenge;
    assert.match(challenge, /^Confirm retry verification task-0014 /);
    await playReadback(page, 'retry-verify');
    await until(async () => (await page.eval(`document.getElementById('voice-btn').dataset.voiceState`)) === 'confirming' || null, { timeout: BUDGET.quick });

    await page.eval(emitTranscript(challenge));
    await until(async () => (await page.eval(`document.getElementById('voice-btn').dataset.voiceState`)) === 'active' || null, { timeout: BUDGET.quick });
    await until(async () => (await cardStatus(page, 'task-0014')) === 'Done' || null, { timeout: BUDGET.chain });

    assert.equal(fs.readFileSync(calcPath, 'utf8'), calcBefore, 'retry_verification must never rerun Build');
    assert.ok(!fs.existsSync(wt), 'successful completion still cleans up the preserved worktree');

    await page.eval(`document.getElementById('voice-btn').click()`);
    assert.deepEqual(page.errors, []);
  } finally {
    clearFakeAgent();
  }
});

test('UI voice: the board replays context when the voice module announces readiness', async (t) => {
  if (!page) return t.skip(SKIP);
  await page.eval(`document.getElementById('voice-widget').hidden = true`);
  await page.eval(`document.dispatchEvent(new CustomEvent('todomd:voice-ready'))`);
  assert.equal(await page.eval(`document.getElementById('voice-widget').hidden`), false,
    'a late voice module receives the latest primary board context');
});

test('UI voice: push-to-talk supports keyboard press-and-hold with complete cleanup', async (t) => {
  if (!page) return t.skip(SKIP);
  await page.eval(`document.getElementById('voice-ptt').hidden = false`);
  const before = await page.eval(`window.__voiceHooks.tracks.length`);
  await page.eval(`document.getElementById('voice-ptt').dispatchEvent(new KeyboardEvent('keydown', {
    key: ' ', bubbles: true, cancelable: true,
  }))`);
  await until(async () => (await page.eval(`document.getElementById('voice-btn').dataset.voiceState`)) === 'active' || null, { timeout: BUDGET.quick });
  await page.eval(`document.getElementById('voice-ptt').dispatchEvent(new KeyboardEvent('keyup', {
    key: ' ', bubbles: true, cancelable: true,
  }))`);
  await until(async () => (await page.eval(`document.getElementById('voice-btn').dataset.voiceState`)) === 'inactive' || null, { timeout: BUDGET.quick });
  assert.equal(await page.eval(`window.__voiceHooks.tracks.length`), before + 1);
  assert.equal(await page.eval(`window.__voiceHooks.tracks.at(-1).stopped`), true);
});

test('UI voice: focus loss ends pointer push-to-talk and stops its microphone track', async (t) => {
  if (!page) return t.skip(SKIP);
  await page.eval(`document.getElementById('voice-ptt').hidden = false`);
  const before = await page.eval(`window.__voiceHooks.tracks.length`);
  await page.eval(`document.getElementById('voice-ptt').dispatchEvent(new PointerEvent('pointerdown', {
    pointerId: 7, pointerType: 'mouse', button: 0, bubbles: true, cancelable: true,
  }))`);
  await until(async () => (await page.eval(`document.getElementById('voice-btn').dataset.voiceState`)) === 'active' || null, { timeout: BUDGET.quick });

  await page.eval(`window.dispatchEvent(new Event('blur'))`);
  await until(async () => (await page.eval(`document.getElementById('voice-btn').dataset.voiceState`)) === 'inactive' || null, { timeout: BUDGET.quick });
  assert.equal(await page.eval(`window.__voiceHooks.tracks.length`), before + 1);
  assert.equal(await page.eval(`window.__voiceHooks.tracks.at(-1).stopped`), true,
    'losing browser focus must not leave the remote microphone active');
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

  // Hold an old-project reload so it lands after the new project. The stale A
  // response must not redraw A or publish A's primary access under B's name.
  await page.eval(`(() => {
    window.__origVoiceFetch = window.fetch;
    window.__oldBoardHeld = false;
    const gate = new Promise((resolve) => { window.__releaseOldBoard = resolve; });
    window.fetch = (input, init) => {
      const url = String(typeof input === 'string' ? input : input.url);
      if (!window.__oldBoardHeld && url.includes('/api/board?project=${encodeURIComponent(name)}')) {
        window.__oldBoardHeld = true;
        window.__oldBoardDone = gate.then(() => window.__origVoiceFetch(input, init));
        return window.__oldBoardDone;
      }
      return window.__origVoiceFetch(input, init);
    };
    window.__staleBoardLoad = loadBoard();
  })()`);
  await until(async () => (await page.eval(`window.__oldBoardHeld`)) || null, { timeout: BUDGET.quick });

  // switching to a DIFFERENT project must disarm — a live session or armed
  // recognizer must never outlive the board it was opened against
  const immediate = await page.eval(`(() => {
    const sel = document.getElementById('project');
    sel.value = ${JSON.stringify(name2)};
    sel.dispatchEvent(new Event('change'));
    return {
      hidden: document.getElementById('voice-widget').hidden,
      state: document.getElementById('voice-btn').dataset.voiceState,
    };
  })()`);
  assert.deepEqual(immediate, { hidden: true, state: 'inactive' },
    'selection revokes the old voice context before the new board request settles');
  await until(async () => (await page.eval(`document.getElementById('voice-btn').dataset.voiceState`)) === 'inactive' || null, { timeout: BUDGET.quick });
  await until(async () => (await page.eval(`latestVoiceContext?.project`)) === name2 || null, { timeout: BUDGET.quick });

  await page.eval(`(async () => {
    window.__releaseOldBoard();
    await window.__staleBoardLoad;
    for (let i = 0; i < 3; i++) await new Promise((resolve) => requestAnimationFrame(resolve));
    window.fetch = window.__origVoiceFetch;
  })()`);
  assert.equal(await page.eval(`latestVoiceContext?.project`), name2,
    'a late old-project response cannot overwrite the selected project context');
  assert.equal(await page.eval(`document.querySelectorAll('.card').length`), 0,
    'a late old-project response cannot redraw the old board');

  assert.deepEqual(page.errors, []);
});

test('UI voice: removing the current project disarms before its replacement board arrives', async (t) => {
  if (!page) return t.skip(SKIP);
  const removableRepo = makeRepo();
  addProject(removableRepo);
  const removableName = path.basename(removableRepo);

  await page.presetScript(`(${installVoiceFakes.toString()})();`);
  await page.goto(`http://127.0.0.1:${srv.port}/?token=${srv.token}&project=${encodeURIComponent(name)}`);
  await until(async () => (await page.eval(`document.querySelectorAll('.card').length`)) || null, { timeout: BUDGET.stage });

  await page.eval(`(() => {
    const sel = document.getElementById('project');
    sel.value = ${JSON.stringify(removableName)};
    sel.dispatchEvent(new Event('change'));
  })()`);
  await until(async () => (await page.eval(`latestVoiceContext?.project`)) === removableName || null, { timeout: BUDGET.quick });
  await page.eval(`document.getElementById('voice-btn').click()`);
  await until(async () => (await page.eval(`document.getElementById('voice-btn').dataset.voiceState`)) === 'armed' || null, { timeout: BUDGET.quick });

  await page.eval(`document.getElementById('manage-projects').click()`);
  await until(async () => (await page.eval(
    `Boolean(document.querySelector('.proj-remove[data-name=${JSON.stringify(removableName)}]'))`,
  )) || null, { timeout: BUDGET.quick });
  await page.eval(`(() => {
    window.__origRemoveFetch = window.fetch;
    window.__replacementHeld = false;
    const gate = new Promise((resolve) => { window.__releaseReplacement = resolve; });
    window.fetch = (input, init) => {
      const url = String(typeof input === 'string' ? input : input.url);
      if (!window.__replacementHeld && url.includes('/api/board?project=')) {
        window.__replacementHeld = true;
        window.__replacementDone = gate.then(() => window.__origRemoveFetch(input, init));
        return window.__replacementDone;
      }
      return window.__origRemoveFetch(input, init);
    };
    document.querySelector('.proj-remove[data-name=${JSON.stringify(removableName)}]').click();
  })()`);

  await until(async () => (await page.eval(`window.__replacementHeld`)) || null, { timeout: BUDGET.quick });
  assert.deepEqual(await page.eval(`({
    hidden: document.getElementById('voice-widget').hidden,
    state: document.getElementById('voice-btn').dataset.voiceState,
  })`), { hidden: true, state: 'inactive' },
  'project removal revokes capture without waiting for the replacement board');

  await page.eval(`(async () => {
    window.__releaseReplacement();
    await window.__replacementDone;
    for (let i = 0; i < 3; i++) await new Promise((resolve) => requestAnimationFrame(resolve));
    window.fetch = window.__origRemoveFetch;
  })()`);
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
