// The board voice session state machine (docs/voice-control-plan.md §
// Experience and state machine). Six states are visible to the UI — inactive,
// arming, armed, active, confirming, error — plus the internal bookkeeping to
// enforce the privacy contract: no remote transport exists before an exact
// finalized wake, sign-off returns to local armed listening, offline always
// stops every microphone track and returns to inactive.
//
// Every browser dependency (the wake engine, the Realtime session factory,
// earcons, timers, clock) is injected, so this module is testable with plain
// fakes — no microphone, WebRTC stack, audio hardware, or network required.
const DEFAULT_ARMED_LIFETIME_MS = 30 * 60 * 1000;
const DEFAULT_IDLE_TIMEOUT_MS = 15_000;
const DEFAULT_CONFIRM_TIMEOUT_MS = 10_000;

// Only the two exit phrases this chunk owns (docs/voice.md). Confirmation
// phrase matching against a live proposal is task-0038's command-routing
// layer; this controller only ever recognizes these two control phrases from
// a finalized post-wake transcript, in `active` or `confirming`.
const SIGNOFF_PHRASES = new Set(['that is all to do']);
const OFFLINE_PHRASES = new Set(['go offline to do']);

function normalize(value) {
  return String(value || '')
    .normalize('NFKD')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
    .replace(/\s+/g, ' ');
}

function boundedMessage(value, max = 200) {
  const text = typeof value === 'string' ? value : (value?.message || value?.error || String(value ?? ''));
  return String(text).replace(/\s+/g, ' ').trim().slice(0, max);
}

export function createVoiceController({
  wakeEngine,
  earcons = null,
  createRealtime,
  setTimeoutFn = (...args) => setTimeout(...args),
  clearTimeoutFn = (...args) => clearTimeout(...args),
  armedLifetimeMs = DEFAULT_ARMED_LIFETIME_MS,
  idleTimeoutMs = DEFAULT_IDLE_TIMEOUT_MS,
  confirmTimeoutMs = DEFAULT_CONFIRM_TIMEOUT_MS,
  onState = () => {},
  onDiagnostic = () => {},
} = {}) {
  let state = 'inactive';
  let realtime = null;
  let pendingSession = null; // the session object while open() is still in flight — not yet committed to `realtime`
  let armedByWake = false; // false for a push-to-talk-only session: there is no local armed loop to return to
  let sessionEpoch = 0;    // bumped on every teardown so a stale in-flight open() can be discarded
  let armGeneration = 0;   // bumped on every teardown so a stale in-flight arm() can be discarded
  let armedLifetimeTimer = null;
  let idleTimer = null;
  let confirmTimer = null;
  let pendingConfirmation = null; // { challenge, onResolve, onTimeout }

  function setState(next, detail = {}) {
    state = next;
    onState(next, detail);
  }
  function diag(message, extra = {}) {
    onDiagnostic({ message, state, ...extra });
  }

  function stopArmedLifetime() { if (armedLifetimeTimer !== null) clearTimeoutFn(armedLifetimeTimer); armedLifetimeTimer = null; }
  function startArmedLifetime() {
    stopArmedLifetime();
    armedLifetimeTimer = setTimeoutFn(() => {
      goOffline('lifetime').then(() => diag('armed session limit reached — arm again to keep listening'));
    }, armedLifetimeMs);
  }
  function stopIdle() { if (idleTimer !== null) clearTimeoutFn(idleTimer); idleTimer = null; }
  function startIdle() {
    stopIdle();
    idleTimer = setTimeoutFn(() => signOff('idle'), idleTimeoutMs);
  }
  function stopConfirmTimer() { if (confirmTimer !== null) clearTimeoutFn(confirmTimer); confirmTimer = null; }

  function rejectPendingConfirmation(reason = 'session-ended') {
    const pending = pendingConfirmation;
    pendingConfirmation = null;
    pending?.onTimeout?.(reason);
  }

  async function closeRealtime() {
    const active = realtime;
    realtime = null;
    if (!active) return;
    try { await active.close(); } catch { /* best effort */ }
  }

  // Common teardown for both a clean sign-off and an unexpected session end.
  // Push-to-talk-only sessions (armedByWake === false) have no local armed
  // loop to return to, so they land in `inactive` instead of `armed`.
  async function settleSession({ earcon } = {}) {
    stopIdle();
    stopConfirmTimer();
    rejectPendingConfirmation();
    await closeRealtime();
    if (earcon === 'exit') earcons?.exit?.();
    else if (earcon === 'error') earcons?.error?.();
    if (armedByWake) {
      wakeEngine.resume();
      setState('armed');
      startArmedLifetime();
    } else {
      try { wakeEngine.stop(); } catch { /* already stopped, or never armed */ }
      setState('inactive');
    }
  }

  async function arm() {
    if (state !== 'inactive' && state !== 'error') return false;
    const myGeneration = ++armGeneration;
    setState('arming');
    let capability;
    try {
      capability = await wakeEngine.init({ install: true });
    } catch (error) {
      capability = { supported: false, status: 'init-failed', error: boundedMessage(error) };
    }
    // goOffline() may have run while init() was in flight (it bumps
    // armGeneration) — an arm attempt that lost the race must never touch the
    // wake engine or the state the offline call already settled on.
    if (myGeneration !== armGeneration) { try { wakeEngine.stop(); } catch { /* already stopped */ } return false; }
    if (!capability?.supported) {
      earcons?.error?.();
      setState('error');
      // reported after the state settles: a UI that mirrors state text into
      // the same status line must not have this overwritten a moment later
      diag('local wake unavailable — use push-to-talk instead', { capability });
      return false;
    }
    const started = await wakeEngine.start(() => handleWake());
    if (myGeneration !== armGeneration) { try { wakeEngine.stop(); } catch { /* already stopped */ } return false; }
    if (!started) {
      earcons?.error?.();
      setState('error');
      diag('local wake could not start — use push-to-talk instead', {});
      return false;
    }
    armedByWake = true;
    setState('armed');
    startArmedLifetime();
    return true;
  }

  // A terminal wake-engine failure (permission revoked, audio-capture error,
  // repeated restart exhaustion) fires asynchronously through the engine's
  // own onStatus callback, well after start() already resolved `armed`.
  // Without this, the controller stays falsely `armed` with a dead recognizer
  // and no diagnostic or push-to-talk fallback.
  function notifyWakeEngineError(detail = {}) {
    if (state !== 'armed') return false;
    earcons?.error?.();
    setState('error');
    diag(`local wake stopped: ${boundedMessage(detail?.error || detail)} — use push-to-talk instead`, { detail });
    return true;
  }

  function handleWake() {
    // The wake engine already gates this to a finalized exact match and
    // pauses itself before calling back; the state check here is defense in
    // depth so a stray callback can never open transport outside `armed`.
    if (state !== 'armed') return;
    openActiveSession();
  }

  async function openActiveSession() {
    if (pendingSession) return; // already opening one (e.g. a real wake during a held push-to-talk press)
    const myEpoch = ++sessionEpoch;
    stopArmedLifetime();
    earcons?.enter?.();
    const session = createRealtime();
    // Visible to signOff()/goOffline() the instant it exists — before this,
    // release/offline mid-open had nothing to close and no state to act on
    // (the state machine was still `armed`/`inactive` until open() settled),
    // so a press-and-quick-release left a live microphone/provider request
    // running to completion with no way to cancel it.
    pendingSession = session;
    try {
      await session.open({
        onTranscript: (t) => { if (realtime === session) handleTranscript(t); },
        onClose: (reason) => { if (realtime === session) handleRealtimeClosed(reason); },
      });
    } catch (error) {
      pendingSession = null;
      if (myEpoch !== sessionEpoch) return; // superseded — the canceller already closed this session
      await settleSession({ earcon: 'error' });
      diag(`voice session unavailable: ${boundedMessage(error)}`);
      return;
    }
    if (myEpoch !== sessionEpoch) { // offline/sign-off landed while the open() above was in flight
      pendingSession = null;
      try { await session.close(); } catch { /* best effort, possibly already closed by the canceller */ }
      return;
    }
    pendingSession = null;
    realtime = session;
    setState('active');
    startIdle();
  }

  // Closes an in-flight open() immediately instead of waiting for it to
  // settle. Idempotent with openActiveSession()'s own post-await cleanup —
  // realtime.js's close() is safe to call twice.
  async function closePendingSession() {
    const p = pendingSession;
    pendingSession = null;
    if (!p) return;
    try { await p.close(); } catch { /* best effort */ }
  }

  function handleTranscript({ text, final } = {}) {
    if (!final) return;
    const normalized = normalize(text);
    const isOffline = OFFLINE_PHRASES.has(normalized);
    const isSignoff = SIGNOFF_PHRASES.has(normalized);
    if (state === 'confirming') {
      if (isOffline) { goOffline('phrase'); return; }
      if (isSignoff) { signOff('phrase'); return; }
      return; // matching an outstanding proposal's response is task-0038's concern
    }
    if (state !== 'active') return;
    if (isOffline) { goOffline('phrase'); return; }
    if (isSignoff) { signOff('phrase'); return; }
    startIdle(); // any other finalized speech resets the active-idle window
  }

  async function handleRealtimeClosed(reason) {
    if (!['active', 'confirming'].includes(state)) return;
    sessionEpoch += 1;
    await settleSession({ earcon: 'error' });
    diag(`voice session ended: ${boundedMessage(reason)}`);
  }

  async function signOff(reason = 'manual') {
    // A push-to-talk press that hasn't finished opening yet leaves `state`
    // unchanged (still `inactive`/`armed`) until open() settles, so the
    // active/confirming check alone would silently ignore a release that
    // lands during that window — pendingSession is the tell that there is
    // still something to cancel even though `state` hasn't caught up.
    if (!['active', 'confirming'].includes(state) && !pendingSession) return false;
    sessionEpoch += 1;
    await closePendingSession();
    await settleSession({ earcon: 'exit' });
    return true;
  }

  async function goOffline(reason = 'manual') {
    if (state === 'inactive' && !pendingSession) return false;
    sessionEpoch += 1;
    armGeneration += 1; // also fences a still-initializing arm() (see arm()'s post-init/post-start checks)
    stopArmedLifetime();
    stopIdle();
    stopConfirmTimer();
    rejectPendingConfirmation('offline');
    await closePendingSession();
    await closeRealtime();
    try { wakeEngine.stop(); } catch { /* already stopped, or never armed */ }
    armedByWake = false;
    setState('inactive', { reason });
    return true;
  }

  // Push-to-talk: the AC-5 fallback when local wake is unavailable (or as a
  // manual override while armed). Each press is its own deliberate gesture —
  // when there was no local armed loop to begin with, releasing it returns to
  // `inactive`, not a synthetic `armed` state the board can't actually reach.
  async function pushToTalkStart() {
    if (!['inactive', 'error', 'armed'].includes(state)) return false;
    // Mirrors what a real wake already does to itself: pause local listening
    // before opening remote transport, so a held press-while-armed can never
    // run a second concurrent recognizer alongside the opening session.
    if (state === 'armed') wakeEngine.pause(); else armedByWake = false;
    await openActiveSession();
    return true;
  }
  function pushToTalkEnd() {
    return signOff('push-to-talk');
  }

  // Proposal confirmation scaffolding used by task-0038's command routing.
  // Kept here so the state machine's `confirming` state, its earcons, and its
  // timeout are complete and independently testable in this chunk.
  function enterConfirming({ challenge, onResolve = () => {}, onTimeout = () => {} } = {}) {
    if (state !== 'active') return false;
    stopIdle();
    pendingConfirmation = { challenge, onResolve, onTimeout };
    setState('confirming');
    confirmTimer = setTimeoutFn(() => {
      const pending = pendingConfirmation;
      pendingConfirmation = null;
      confirmTimer = null;
      pending?.onTimeout?.('timeout');
      if (state === 'confirming') { setState('active'); startIdle(); }
    }, confirmTimeoutMs);
    return true;
  }

  function resolveConfirmation(response) {
    if (state !== 'confirming' || !pendingConfirmation) return false;
    const pending = pendingConfirmation;
    pendingConfirmation = null;
    stopConfirmTimer();
    pending.onResolve(response);
    setState('active');
    startIdle();
    return true;
  }

  function diagnostics() {
    return { state, armedByWake, wake: wakeEngine?.diagnostics?.() ?? null };
  }

  return {
    arm,
    signOff,
    goOffline,
    pushToTalkStart,
    pushToTalkEnd,
    enterConfirming,
    resolveConfirmation,
    notifyWakeEngineError,
    diagnostics,
    get state() { return state; },
  };
}
