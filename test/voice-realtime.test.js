// public/voice/realtime.js is the browser-side post-wake WebRTC adapter. Every
// browser API is dependency-injected, so these tests drive it with fakes —
// no real microphone, WebRTC stack, or network call.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRealtimeSession } from '../public/voice/realtime.js';

function fakeTrack() { return { stopped: false, stop() { this.stopped = true; } }; }
function fakeStream(tracks) {
  return { getAudioTracks: () => tracks, getTracks: () => tracks };
}

function fakeRtcClass({ connectionState = 'connected' } = {}) {
  return class FakeRTCPeerConnection {
    static instances = [];
    constructor() {
      this.tracks = [];
      this.dataChannels = [];
      this.listeners = {};
      this.closed = false;
      this.connectionState = connectionState;
      this.constructor.instances.push(this);
    }
    addTrack(track, stream) { this.tracks.push({ track, stream }); }
    createDataChannel(label) {
      const listeners = {};
      const channel = {
        label,
        closed: false,
        addEventListener(type, fn) { listeners[type] = fn; },
        emit(type, payload) { listeners[type]?.(payload); },
        close() { this.closed = true; },
      };
      this.dataChannels.push(channel);
      return channel;
    }
    addEventListener(type, fn) { this.listeners[type] = fn; }
    fireConnectionStateChange(state) { this.connectionState = state; this.listeners.connectionstatechange?.(); }
    fireTrack(streams) { this.listeners.track?.({ streams }); }
    async createOffer() { return { type: 'offer', sdp: 'v=0\r\no=fake offer\r\n' }; }
    async setLocalDescription() {}
    async setRemoteDescription(desc) { this.remoteDescription = desc; }
    close() { this.closed = true; }
  };
}

function fakeAudioElement() {
  return {
    autoplay: false,
    srcObject: null,
    playCalls: 0,
    paused: false,
    removed: false,
    play() { this.playCalls += 1; return Promise.resolve(); },
    pause() { this.paused = true; },
    remove() { this.removed = true; },
  };
}

function fakeFetchOk(answerSdp = 'v=0\r\no=fake answer\r\n') {
  const calls = [];
  const fn = async (url, opts) => {
    calls.push({ url: String(url), opts });
    return { ok: true, status: 200, text: async () => answerSdp, json: async () => ({}) };
  };
  fn.calls = calls;
  return fn;
}

test('open() posts the SDP offer with the token header and applies the returned SDP answer', async () => {
  const track = fakeTrack();
  const RTC = fakeRtcClass();
  const fetchFn = fakeFetchOk();
  const session = createRealtimeSession({
    RTCPeerConnectionClass: RTC,
    getUserMediaFn: async () => fakeStream([track]),
    fetchFn,
    token: 'tok-123',
    project: 'demo',
  });
  await session.open({});
  assert.equal(fetchFn.calls.length, 1);
  assert.match(fetchFn.calls[0].url, /^\/api\/voice\/session\?project=demo$/);
  assert.equal(fetchFn.calls[0].opts.headers['x-todomd-token'], 'tok-123');
  assert.equal(fetchFn.calls[0].opts.headers['content-type'], 'application/sdp');
  assert.equal(fetchFn.calls[0].opts.body, 'v=0\r\no=fake offer\r\n');
  const pc = RTC.instances.at(-1);
  assert.equal(pc.remoteDescription.sdp, 'v=0\r\no=fake answer\r\n');
  assert.deepEqual(pc.tracks.map((t) => t.track), [track], 'the acquired audio track was attached before the offer');
  await session.close();
  assert.equal(track.stopped, true);
});

test('a finalized input-transcription event surfaces through onTranscript; other events are ignored', async () => {
  const RTC = fakeRtcClass();
  const session = createRealtimeSession({
    RTCPeerConnectionClass: RTC,
    getUserMediaFn: async () => fakeStream([fakeTrack()]),
    fetchFn: fakeFetchOk(),
    token: 't', project: 'p',
  });
  const transcripts = [];
  await session.open({ onTranscript: (t) => transcripts.push(t) });
  const channel = RTC.instances.at(-1).dataChannels.at(-1);
  channel.emit('message', { data: JSON.stringify({ type: 'response.audio_transcript.delta', transcript: 'ignore me' }) });
  channel.emit('message', { data: JSON.stringify({ type: 'conversation.item.input_audio_transcription.completed', transcript: 'That is all, To-do' }) });
  channel.emit('message', { data: 'not json' }); // must not throw
  assert.deepEqual(transcripts, [{ text: 'That is all, To-do', final: true }]);
});

test('a remote track is rendered to an audio sink and played; close() tears it down', async () => {
  const RTC = fakeRtcClass();
  const audioEl = fakeAudioElement();
  const session = createRealtimeSession({
    RTCPeerConnectionClass: RTC,
    getUserMediaFn: async () => fakeStream([fakeTrack()]),
    fetchFn: fakeFetchOk(),
    createAudioSink: () => audioEl,
    token: 't', project: 'p',
  });
  await session.open({});
  const pc = RTC.instances.at(-1);
  const remoteStream = { fake: 'remote-stream' };
  pc.fireTrack([remoteStream]);
  assert.equal(audioEl.srcObject, remoteStream, 'the assistant\'s remote audio is otherwise never heard');
  assert.equal(audioEl.autoplay, true);
  assert.equal(audioEl.playCalls, 1);

  await session.close();
  assert.equal(audioEl.paused, true);
  assert.equal(audioEl.srcObject, null);
  assert.equal(audioEl.removed, true);
});

test('a track event with no stream, or arriving after close, is ignored without throwing', async () => {
  const RTC = fakeRtcClass();
  const audioEl = fakeAudioElement();
  const session = createRealtimeSession({
    RTCPeerConnectionClass: RTC,
    getUserMediaFn: async () => fakeStream([fakeTrack()]),
    fetchFn: fakeFetchOk(),
    createAudioSink: () => audioEl,
    token: 't', project: 'p',
  });
  await session.open({});
  const pc = RTC.instances.at(-1);
  pc.fireTrack([]); // no stream on the event
  assert.equal(audioEl.srcObject, null);

  await session.close();
  pc.fireTrack([{ fake: 'late-stream' }]); // arrives after close
  assert.equal(audioEl.srcObject, null, 'a track event after close must not resurrect the sink');
});

test('missing document/audio support in this environment degrades silently instead of throwing', async () => {
  const RTC = fakeRtcClass();
  const session = createRealtimeSession({
    RTCPeerConnectionClass: RTC,
    getUserMediaFn: async () => fakeStream([fakeTrack()]),
    fetchFn: fakeFetchOk(),
    createAudioSink: () => null,
    token: 't', project: 'p',
  });
  await session.open({});
  const pc = RTC.instances.at(-1);
  assert.doesNotThrow(() => pc.fireTrack([{ fake: 'stream' }]));
});

test('an unexpected connection failure calls onClose, but a deliberate close() does not', async () => {
  const RTC = fakeRtcClass();
  const session = createRealtimeSession({
    RTCPeerConnectionClass: RTC,
    getUserMediaFn: async () => fakeStream([fakeTrack()]),
    fetchFn: fakeFetchOk(),
    token: 't', project: 'p',
  });
  const closes = [];
  await session.open({ onClose: (reason) => closes.push(reason) });
  const pc = RTC.instances.at(-1);
  pc.fireConnectionStateChange('failed');
  assert.deepEqual(closes, ['failed']);

  closes.length = 0;
  await session.close();
  pc.fireConnectionStateChange('closed'); // late/duplicate event after a deliberate close
  assert.deepEqual(closes, [], 'close() marks the session closed before onClose can fire again');
});

test('a non-2xx /api/voice/session response surfaces its bounded JSON error, not a generic throw', async () => {
  const RTC = fakeRtcClass();
  const fetchFn = async () => ({ ok: false, status: 503, json: async () => ({ error: 'voice is not configured' }) });
  const session = createRealtimeSession({
    RTCPeerConnectionClass: RTC,
    getUserMediaFn: async () => fakeStream([fakeTrack()]),
    fetchFn,
    token: 't', project: 'p',
  });
  await assert.rejects(() => session.open({}), /voice is not configured/);
});

test('a failed open cleans up the acquired microphone track and the peer connection', async () => {
  const track = fakeTrack();
  const RTC = fakeRtcClass();
  const fetchFn = async () => ({ ok: false, status: 503, json: async () => { throw new Error('not json'); } });
  const session = createRealtimeSession({
    RTCPeerConnectionClass: RTC,
    getUserMediaFn: async () => fakeStream([track]),
    fetchFn,
    token: 't', project: 'p',
  });
  await assert.rejects(() => session.open({}));
  assert.equal(track.stopped, true, 'no microphone track survives a failed open');
  assert.equal(RTC.instances.at(-1).closed, true);
});

test('microphone permission denial rejects open() without ever creating a peer connection', async () => {
  const RTC = fakeRtcClass();
  const session = createRealtimeSession({
    RTCPeerConnectionClass: RTC,
    getUserMediaFn: async () => { const e = new Error('denied'); e.name = 'NotAllowedError'; throw e; },
    fetchFn: fakeFetchOk(),
    token: 't', project: 'p',
  });
  await assert.rejects(() => session.open({}), /denied/);
  assert.equal(RTC.instances.length, 0, 'no pre-authorization WebRTC connection is ever attempted');
});

test('missing WebRTC support fails closed with an understandable error, no getUserMedia call', async () => {
  let called = false;
  const session = createRealtimeSession({
    RTCPeerConnectionClass: undefined,
    getUserMediaFn: async () => { called = true; return fakeStream([fakeTrack()]); },
    fetchFn: fakeFetchOk(),
    token: 't', project: 'p',
  });
  await assert.rejects(() => session.open({}), /WebRTC is unavailable/);
  assert.equal(called, false);
});

test('open() can only run once per session object', async () => {
  const RTC = fakeRtcClass();
  const session = createRealtimeSession({
    RTCPeerConnectionClass: RTC,
    getUserMediaFn: async () => fakeStream([fakeTrack()]),
    fetchFn: fakeFetchOk(),
    token: 't', project: 'p',
  });
  await session.open({});
  await assert.rejects(() => session.open({}), /already open/);
});
