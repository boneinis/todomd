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
  RTCPeerConnectionClass = scope.RTCPeerConnection,
  getUserMediaFn = (constraints) => scope.navigator?.mediaDevices?.getUserMedia?.(constraints),
  token = '',
  project = '',
} = {}) {
  let pc = null;
  let dataChannel = null;
  let stream = null;
  let closed = false;
  let opened = false;

  function stopStream() {
    for (const track of stream?.getTracks?.() || []) {
      try { track.stop(); } catch { /* already stopped */ }
    }
    stream = null;
  }

  function handleServerEvent(raw, onTranscript) {
    let event;
    try { event = JSON.parse(raw); } catch { return; }
    if (!event || typeof event !== 'object') return;
    // Realtime's finalized-input-transcript event — the only remote signal the
    // controller trusts for "That is all, To-do" / "Go offline, To-do" (never
    // the assistant's own output-audio transcript).
    if (event.type === 'conversation.item.input_audio_transcription.completed'
      && typeof event.transcript === 'string') {
      onTranscript({ text: event.transcript, final: true });
    }
  }

  async function postOffer(sdp) {
    if (typeof fetchFn !== 'function') throw new Error('fetch is unavailable');
    const res = await fetchFn(`/api/voice/session?project=${encodeURIComponent(project)}`, {
      method: 'POST',
      headers: { 'content-type': 'application/sdp', 'x-todomd-token': token },
      body: sdp,
    });
    if (!res.ok) throw new Error(await readErrorMessage(res));
    return res.text();
  }

  // Any failure mid-open (denied mic, no WebRTC, SDP exchange failure) cleans
  // up whatever was already acquired before rethrowing — the caller never has
  // to know how far this got to avoid leaking a live microphone track.
  async function open({ onTranscript = () => {}, onClose = () => {} } = {}) {
    if (opened) throw new Error('session already open');
    opened = true;
    try {
      if (!RTCPeerConnectionClass) throw new Error('WebRTC is unavailable in this browser');
      if (typeof getUserMediaFn !== 'function') throw new Error('microphone capture is unavailable');

      stream = await getUserMediaFn({ audio: true });
      if (closed) throw new Error('session closed before it opened');

      pc = new RTCPeerConnectionClass();
      for (const track of stream.getAudioTracks ? stream.getAudioTracks() : []) {
        pc.addTrack(track, stream);
      }
      dataChannel = pc.createDataChannel('oai-events');
      dataChannel.addEventListener?.('message', (event) => handleServerEvent(event.data, onTranscript));
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
    } catch (error) {
      await close();
      throw error;
    }
  }

  async function close() {
    if (closed) return;
    closed = true;
    try { dataChannel?.close?.(); } catch { /* already closed */ }
    try { pc?.close?.(); } catch { /* already closed */ }
    stopStream();
    pc = null;
    dataChannel = null;
  }

  return { open, close };
}
