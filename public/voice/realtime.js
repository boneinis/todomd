// Browser-side post-wake WebRTC adapter (docs/voice.md § Post-wake credential
// and transport flow). This module never talks to OpenAI directly — it posts
// the local SDP offer to the primary-only `POST /api/voice/session` route and
// applies whatever SDP answer comes back. The standard OpenAI key never
// reaches this file or any browser-visible request.
//
// Every browser API (RTCPeerConnection, getUserMedia, fetch) is dependency
// injected so node --test can drive this with fakes — no real microphone,
// WebRTC stack, or network call.
function boundedMessage(value, max = 200) {
  const text = typeof value === 'string' ? value : (value?.message || '');
  return text.replace(/\s+/g, ' ').trim().slice(0, max);
}

async function readErrorMessage(res) {
  try {
    const body = await res.json();
    if (body && typeof body.error === 'string' && body.error) return boundedMessage(body.error);
  } catch { /* non-JSON or empty error body */ }
  return `voice session error (${res.status})`;
}

// One post-wake session. Call open() once; call close() exactly once when
// done (sign-off, offline, idle timeout, or an open() failure caller-side).
export function createRealtimeSession({
  scope = globalThis,
  fetchFn = scope.fetch?.bind(scope),
  AbortControllerClass = scope.AbortController,
  RTCPeerConnectionClass = scope.RTCPeerConnection,
  getUserMediaFn = (constraints) => scope.navigator?.mediaDevices?.getUserMedia?.(constraints),
  // Where the assistant's remote audio is rendered. Defaults to a real
  // <audio> element so production code needs no wiring; tests inject a fake
  // to assert playback without a real DOM/audio device.
  createAudioSink = () => scope.document?.createElement?.('audio') ?? null,
  token = '',
  project = '',
} = {}) {
  let pc = null;
  let dataChannel = null;
  let stream = null;
  let audioEl = null;
  let closed = false;
  let opened = false;
  let offerAbortController = null;

  function stopStream() {
    for (const track of stream?.getTracks?.() || []) {
      try { track.stop(); } catch { /* already stopped */ }
    }
    stream = null;
  }

  // The model's speech arrives as a remote track on the same peer connection
  // — without rendering it, the "conversation" is one-way and unusable.
  function attachRemoteAudio(event) {
    if (closed) return;
    const remoteStream = event?.streams?.[0];
    if (!remoteStream) return;
    if (!audioEl) {
      audioEl = createAudioSink();
      if (!audioEl) return; // no document/Audio support in this environment — degrade silently, never throw
      audioEl.autoplay = true;
    }
    audioEl.srcObject = remoteStream;
    // Autoplay can reject before the arming click's user-activation window is
    // considered current by the browser; that's non-fatal, not a session error.
    try { audioEl.play?.()?.catch?.(() => {}); } catch { /* best effort */ }
  }

  function stopAudioSink() {
    if (!audioEl) return;
    try { audioEl.pause?.(); } catch { /* already stopped */ }
    try { audioEl.srcObject = null; } catch { /* best effort */ }
    try { audioEl.remove?.(); } catch { /* best effort, or never attached */ }
    audioEl = null;
  }

  function handleServerEvent(raw, { onTranscript, onToolCall, onResponseDone }) {
    let event;
    try { event = JSON.parse(raw); } catch { return; }
    if (!event || typeof event !== 'object') return;
    // Realtime's finalized-input-transcript event — the only remote signal the
    // controller trusts for "That is all, To-do" / "Go offline, To-do" (never
    // the assistant's own output-audio transcript).
    if (event.type === 'conversation.item.input_audio_transcription.completed'
      && typeof event.transcript === 'string') {
      onTranscript({ text: event.transcript, final: true });
      return;
    }
    // A finished function-call output item — the model invoking one of
    // read_board_report/read_card/propose_board_action. `arguments` arrives as
    // a JSON string; a malformed one surfaces as `null` so the router can
    // reply with an error instead of silently dropping the call and leaving
    // the model waiting forever for a tool result.
    if (event.type === 'response.output_item.done' && event.item?.type === 'function_call') {
      const { call_id: callId, name, arguments: rawArguments } = event.item;
      if (typeof callId !== 'string' || typeof name !== 'string') return;
      let parsedArguments = {};
      if (typeof rawArguments === 'string' && rawArguments) {
        try { parsedArguments = JSON.parse(rawArguments); } catch { parsedArguments = null; }
      }
      onToolCall({ callId, name, arguments: parsedArguments });
      return;
    }
    // A full response (including its output audio) has finished playing. The
    // command router waits for this before opening a confirmation window, so
    // a proposal's read-back always finishes speaking before the human's
    // reply can be heard — see commands.js's handleProposeBoardAction.
    if (event.type === 'response.done') onResponseDone();
  }

  async function postOffer(sdp) {
    if (typeof fetchFn !== 'function') throw new Error('fetch is unavailable');
    const controller = typeof AbortControllerClass === 'function' ? new AbortControllerClass() : null;
    offerAbortController = controller;
    try {
      const res = await fetchFn(`/api/voice/session?project=${encodeURIComponent(project)}`, {
        method: 'POST',
        headers: { 'content-type': 'application/sdp', 'x-todomd-token': token },
        body: sdp,
        ...(controller ? { signal: controller.signal } : {}),
      });
      if (!res.ok) throw new Error(await readErrorMessage(res));
      return res.text();
    } finally {
      if (offerAbortController === controller) offerAbortController = null;
    }
  }

  // Any failure mid-open (denied mic, no WebRTC, SDP exchange failure) cleans
  // up whatever was already acquired before rethrowing — the caller never has
  // to know how far this got to avoid leaking a live microphone track.
  async function open({ onTranscript = () => {}, onToolCall = () => {}, onResponseDone = () => {}, onClose = () => {} } = {}) {
    if (opened) throw new Error('session already open');
    opened = true;
    try {
      if (!RTCPeerConnectionClass) throw new Error('WebRTC is unavailable in this browser');
      if (typeof getUserMediaFn !== 'function') throw new Error('microphone capture is unavailable');

      stream = await getUserMediaFn({ audio: true });
      // A permission prompt can outlive the gesture that opened it: offline,
      // a push-to-talk release, or an idle timeout may already have closed
      // this session. Drop the track here rather than relying on the catch
      // below, so the microphone dies with the grant that produced it.
      if (closed) { stopStream(); throw new Error('session closed before it opened'); }

      pc = new RTCPeerConnectionClass();
      for (const track of stream.getAudioTracks ? stream.getAudioTracks() : []) {
        pc.addTrack(track, stream);
      }
      dataChannel = pc.createDataChannel('oai-events');
      dataChannel.addEventListener?.('message', (event) => handleServerEvent(event.data, { onTranscript, onToolCall, onResponseDone }));
      pc.addEventListener?.('track', attachRemoteAudio);
      pc.addEventListener?.('connectionstatechange', () => {
        if (closed) return;
        if (['failed', 'closed', 'disconnected'].includes(pc.connectionState)) onClose(pc.connectionState);
      });

      const offer = await pc.createOffer();
      await pc.setLocalDescription(offer);
      if (closed) throw new Error('session closed before it opened');

      const answerSdp = await postOffer(offer.sdp);
      if (closed) throw new Error('session closed before it opened');
      await pc.setRemoteDescription({ type: 'answer', sdp: answerSdp });
      if (closed) throw new Error('session closed before it opened');
    } catch (error) {
      await close();
      throw error;
    }
  }

  // Deliberately has NO `if (closed) return` fast path. A close can land while
  // open() is still awaiting getUserMedia or the SDP exchange, so resources
  // keep arriving after the first close — an early return would strand them
  // (a live microphone track being the one that matters). Every step below is
  // null-safe and try-wrapped, so calling this repeatedly is free and always
  // drains whatever exists now.
  async function close() {
    closed = true;
    try { offerAbortController?.abort?.(); } catch { /* already aborted */ }
    offerAbortController = null;
    try { dataChannel?.close?.(); } catch { /* already closed */ }
    try { pc?.close?.(); } catch { /* already closed */ }
    stopStream();
    stopAudioSink();
    pc = null;
    dataChannel = null;
  }

  // Sends one client event (a tool result, a suppression session.update, an
  // explicit response.create/instructions override) over the data channel.
  // Best effort and silent: a channel that isn't open yet/anymore (not opened,
  // already closed, or mid-teardown) must never throw into command-routing
  // code that has no useful recovery for a session that's already gone.
  function send(clientEvent) {
    if (!dataChannel) return false;
    try { dataChannel.send(JSON.stringify(clientEvent)); return true; } catch { return false; }
  }

  return { open, close, send };
}
