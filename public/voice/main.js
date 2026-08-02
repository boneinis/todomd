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
import { createCommandRouter } from './commands.js';

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
  // `controller` doesn't exist yet when wakeEngine is constructed, but
  // onStatus only ever fires later (after arm()), by which point it's
  // assigned — the closure just needs the binding to exist now.
  let controller;
  const wakeEngine = createWakeWordEngine({
    scope: window,
    // A terminal recognizer failure (permission revoked, audio-capture
    // error, repeated restart exhaustion) fires asynchronously, independent
    // of whatever start() already resolved — without this the control stays
    // falsely `armed` with a dead recognizer and no diagnostic.
    onStatus: (status) => { if (status.state === 'error') controller?.notifyWakeEngineError(status); },
  });
  controller = createVoiceController({
    wakeEngine,
    earcons,
    createRealtime: () => createRealtimeSession({ scope: window, token, project }),
    onState: renderState,
    onDiagnostic: renderDiagnostic,
    // task-0038: routes read_board_report/read_card/propose_board_action tool
    // calls to the Actions API and, for a proposed mutation, the human's
    // spoken reply to confirm/reject. `commands` closes over this same
    // `controller` binding, assigned right below.
    onToolCall: (call) => commands.handleToolCall(call),
    onResponseEvent: (event) => commands.handleResponseEvent(event),
  });
  const commands = createCommandRouter({
    controller,
    token,
    project: () => project,
    fetchFn: window.fetch.bind(window),
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
    // AC5: a missing local capability, a denied microphone, and a provider
    // the server has no configuration for must each leave a working way to
    // talk to the board — not just an explanation. The controller marks every
    // one of those diagnostics `fallback`, and it stays revealed afterwards:
    // whatever just failed is likely to fail the same way on the next try.
    if (detail?.fallback && ptt) ptt.hidden = false;
  }

  btn.addEventListener('click', () => {
    const state = controller.state;
    if (state === 'inactive' || state === 'error') controller.arm();
    else controller.goOffline(); // always-available off action while armed/active/confirming
  });

  if (ptt) {
    let pointerId = null;
    let keyboardHeld = false;
    const held = () => pointerId !== null || keyboardHeld;
    const release = () => {
      if (!held()) return;
      pointerId = null;
      keyboardHeld = false;
      controller.pushToTalkEnd();
    };
    ptt.addEventListener('pointerdown', (event) => {
      event.preventDefault();
      if (pointerId !== null) return;
      const wasHeld = held();
      pointerId = event.pointerId;
      try { ptt.setPointerCapture(event.pointerId); } catch { /* synthetic/unsupported capture */ }
      if (!wasHeld) controller.pushToTalkStart();
    });
    const releasePointer = (event) => {
      if (pointerId === null || event.pointerId !== pointerId) return;
      if (event.cancelable) event.preventDefault();
      pointerId = null;
      if (!keyboardHeld) controller.pushToTalkEnd();
    };
    window.addEventListener('pointerup', releasePointer);
    window.addEventListener('pointercancel', releasePointer);
    ptt.addEventListener('keydown', (event) => {
      if (![' ', 'Enter'].includes(event.key)) return;
      event.preventDefault();
      if (keyboardHeld || event.repeat) return;
      const wasHeld = held();
      keyboardHeld = true;
      if (!wasHeld) controller.pushToTalkStart();
    });
    ptt.addEventListener('keyup', (event) => {
      if (![' ', 'Enter'].includes(event.key)) return;
      event.preventDefault();
      if (!keyboardHeld) return;
      keyboardHeld = false;
      if (pointerId === null) controller.pushToTalkEnd();
    });
    // Releasing outside the browser may deliver neither pointerup nor
    // pointerleave. Focus loss is therefore a privacy boundary: always stop
    // the remote microphone regardless of which input mode began the hold.
    ptt.addEventListener('blur', release);
    window.addEventListener('blur', release);
  }

  // `null` until the first context arrives, so the very first dispatch never
  // itself counts as a "change" (nothing is armed yet to disarm).
  let lastContextKey = null;
  function applyContext(detail = {}) {
    const nextProject = detail.project || '';
    const nextAccess = detail.access || 'none';
    const nextPrimary = detail.primary === true;
    const key = `${nextProject} ${nextAccess} ${nextPrimary}`;
    const changed = lastContextKey !== null && key !== lastContextKey;
    lastContextKey = key;
    project = nextProject;
    widget.hidden = nextAccess !== 'full' || !nextPrimary;
    // A live session or an armed local recognizer must never outlive a
    // project switch, an access-tier downgrade, or the last project
    // disappearing — each of those changes `key`, but an ordinary board
    // poll re-dispatching the SAME project/access must not disarm voice.
    if (changed) controller.goOffline();
  }
  document.addEventListener('todomd:context', (event) => applyContext(event.detail));
  // app.js runs first, but its board fetch can settle before this module graph
  // loads. Ask it to replay the latest context after our listener exists.
  document.dispatchEvent(new CustomEvent('todomd:voice-ready'));

  // Read-only capability probe on load: no microphone permission requested,
  // no language pack installed. Decides whether the board leads with the
  // normal arm control or falls straight to push-to-talk (AC: missing local
  // capability must still leave the board usable).
  inspectLocalSpeech({ scope: window, install: false }).then((capability) => {
    if (!capability.supported && !['downloadable', 'downloading'].includes(capability.status)) {
      if (btn) btn.hidden = true;
      if (ptt) ptt.hidden = false;
      if (diagEl) diagEl.textContent = 'local wake unavailable — press and hold to talk';
    } else if (!capability.supported && diagEl) {
      // Installation is intentionally deferred to the explicit Arm gesture;
      // leaving the button visible is what makes that gesture reachable.
      diagEl.textContent = capability.status === 'downloading'
        ? 'local speech is downloading — click to finish arming'
        : 'local speech download available — click to arm';
    }
  }).catch(() => { /* capability probe never blocks board boot */ });

  renderState('inactive');
  window.addEventListener('pagehide', () => { controller.goOffline(); });
}
