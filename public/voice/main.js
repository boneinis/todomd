// DOM wiring for the board mic control (docs/voice-control-plan.md § Visible
// controls). This is the only voice module that touches `document`/`window`
// directly — everything it drives (wake-word.js, earcons.js, realtime.js,
// controller.js) is pure and independently unit tested. app.js is a classic
// (non-module) script and stays fully independent of this one; the two only
// share the sessionStorage token key and the `todomd:context` custom event
// app.js dispatches whenever the current project/access level changes.
import { createWakeWordEngine, inspectLocalSpeech } from './wake-word.js';
import { createEarcons } from './earcons.js';
import { createRealtimeSession } from './realtime.js';
import { createVoiceController } from './controller.js';

const btn = document.getElementById('voice-btn');
const ptt = document.getElementById('voice-ptt');
const diagEl = document.getElementById('voice-diag');
const widget = document.getElementById('voice-widget');

if (btn && widget) {
  const token = sessionStorage.getItem('todomd-token') || '';
  let project = '';

  const STATE_TEXT = {
    inactive: 'voice off — click to arm',
    arming: 'arming…',
    armed: 'listening for "Hey To-do"',
    active: 'voice active — say "That is all, To-do" to end',
    confirming: 'awaiting confirmation',
    error: 'voice unavailable',
  };

  const earcons = createEarcons({ scope: window });
  const wakeEngine = createWakeWordEngine({ scope: window });
  const controller = createVoiceController({
    wakeEngine,
    earcons,
    createRealtime: () => createRealtimeSession({ scope: window, token, project }),
    onState: renderState,
    onDiagnostic: renderDiagnostic,
  });

  function renderState(state) {
    btn.dataset.voiceState = state;
    btn.setAttribute('aria-pressed', String(state !== 'inactive' && state !== 'error'));
    const label = STATE_TEXT[state] || state;
    btn.title = label;
    btn.setAttribute('aria-label', `voice control — ${label}`);
    if (diagEl) diagEl.textContent = label;
  }

  function renderDiagnostic(detail) {
    if (diagEl && detail?.message) diagEl.textContent = detail.message;
  }

  btn.addEventListener('click', () => {
    const state = controller.state;
    if (state === 'inactive' || state === 'error') controller.arm();
    else controller.goOffline(); // always-available off action while armed/active/confirming
  });

  if (ptt) {
    const start = (event) => { event.preventDefault(); controller.pushToTalkStart(); };
    const end = (event) => { event.preventDefault(); controller.pushToTalkEnd(); };
    ptt.addEventListener('mousedown', start);
    ptt.addEventListener('touchstart', start);
    ptt.addEventListener('mouseup', end);
    ptt.addEventListener('mouseleave', end);
    ptt.addEventListener('touchend', end);
    ptt.addEventListener('touchcancel', end);
  }

  document.addEventListener('todomd:context', (event) => {
    project = event.detail?.project || '';
    widget.hidden = event.detail?.access !== 'full';
  });

  // Read-only capability probe on load: no microphone permission requested,
  // no language pack installed. Decides whether the board leads with the
  // normal arm control or falls straight to push-to-talk (AC: missing local
  // capability must still leave the board usable).
  inspectLocalSpeech({ scope: window, install: false }).then((capability) => {
    if (!capability.supported) {
      if (btn) btn.hidden = true;
      if (ptt) ptt.hidden = false;
      if (diagEl) diagEl.textContent = 'local wake unavailable — press and hold to talk';
    }
  }).catch(() => { /* capability probe never blocks board boot */ });

  renderState('inactive');
  window.addEventListener('pagehide', () => { controller.goOffline(); });
}
