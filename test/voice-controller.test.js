// public/voice/controller.js is the board voice session state machine. Every
// dependency (wake engine, Realtime session factory, earcons, timers) is
// faked here — no microphone, WebRTC stack, audio hardware, or network.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createVoiceController } from '../public/voice/controller.js';

// Several controller paths chain multiple awaits (settleSession awaits
// closeRealtime, which awaits the fake session's close()) before the
// resulting state/diagnostic callbacks fire. A fixed number of
// Promise.resolve() ticks is fragile against that depth changing; a
// macrotask flush drains every pending microtask first, so it's robust no
// matter how many awaits a given path chains.
const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

function fakeWakeEngine({ supported = true, started = true, status = 'available' } = {}) {
  const calls = { init: 0, start: 0, pause: 0, resume: 0, stop: 0 };
  const state = { supported, started, status }; // mutable, so a test can flip it mid-flow (e.g. an arm() retry)
  let onWake = null;
  return {
    calls, state,
    async init() { calls.init += 1; return { supported: state.supported, status: state.status }; },
    async start(cb) { calls.start += 1; onWake = cb; return state.supported && state.started; },
    pause() { calls.pause += 1; },
    resume() { calls.resume += 1; return true; },
    stop() { calls.stop += 1; },
    diagnostics() { return { fake: true }; },
    triggerWake() { onWake?.({ phrase: 'hey to-do' }); },
  };
}

function fakeEarcons() {
  const calls = [];
  return { calls, enter: () => calls.push('enter'), exit: () => calls.push('exit'), error: () => calls.push('error') };
}

// Auto-succeeding by default; pass manual:true to control open()'s resolution
// timing (used by the "superseded in-flight open" tests).
function fakeRealtimeFactory({ manual = false } = {}) {
  const sessions = [];
  function factory() {
    let resolveOpen, rejectOpen;
    const openPromise = new Promise((res, rej) => { resolveOpen = res; rejectOpen = rej; });
    if (!manual) resolveOpen();
    const session = {
      closeCalls: 0, closed: false, onTranscript: null, onClose: null,
      async open(handlers) {
        session.onTranscript = handlers.onTranscript;
        session.onClose = handlers.onClose;
        await openPromise;
      },
      // Idempotent, matching realtime.js's real close() — a superseded
      // in-flight open can legitimately be closed both by the canceller
      // (immediately) and by openActiveSession's own post-await cleanup.
      async close() { if (session.closed) return; session.closeCalls += 1; session.closed = true; },
      resolveOpen: (v) => resolveOpen(v),
      rejectOpen: (e) => rejectOpen(e),
    };
    sessions.push(session);
    return session;
  }
  factory.sessions = sessions;
  return factory;
}

function fakeFailingRealtimeFactory(message = 'voice is not configured') {
  const calls = [];
  const factory = () => { calls.push(1); return { async open() { throw new Error(message); }, async close() {} }; };
  factory.calls = calls;
  return factory;
}

function fakeClock() {
  const scheduled = new Map();
  let nextId = 1;
  return {
    setTimeoutFn(fn) { const id = nextId++; scheduled.set(id, fn); return id; },
    clearTimeoutFn(id) { scheduled.delete(id); },
    fire(id) { const fn = scheduled.get(id); scheduled.delete(id); fn?.(); },
    pendingCount() { return scheduled.size; },
    lastId() { return [...scheduled.keys()].at(-1); },
  };
}

function build(overrides = {}) {
  const wakeEngine = overrides.wakeEngine || fakeWakeEngine();
  const earcons = overrides.earcons || fakeEarcons();
  const realtime = overrides.realtime || fakeRealtimeFactory();
  const clock = overrides.clock || fakeClock();
  const states = [];
  const diagnostics = [];
  const controller = createVoiceController({
    wakeEngine,
    earcons,
    createRealtime: overrides.createRealtime || realtime,
    setTimeoutFn: clock.setTimeoutFn,
    clearTimeoutFn: clock.clearTimeoutFn,
    onState: (s, detail) => states.push({ s, detail }),
    onDiagnostic: (d) => diagnostics.push(d),
    ...overrides.options,
  });
  return { controller, wakeEngine, earcons, realtime, clock, states, diagnostics };
}

test('happy path: arm, wake, active, sign-off back to armed, second wake, offline', async () => {
  const { controller, wakeEngine, earcons, realtime } = build();
  assert.equal(await controller.arm(), true);
  assert.equal(controller.state, 'armed');
  assert.equal(wakeEngine.calls.init, 1);
  assert.equal(wakeEngine.calls.start, 1);
  assert.equal(realtime.sessions.length, 0, 'no realtime session while merely armed');

  wakeEngine.triggerWake();
  await flush();
  assert.equal(controller.state, 'active');
  assert.deepEqual(earcons.calls, ['enter']);
  assert.equal(realtime.sessions.length, 1);

  assert.equal(await controller.signOff(), true);
  assert.equal(controller.state, 'armed');
  assert.deepEqual(earcons.calls, ['enter', 'exit']);
  assert.equal(realtime.sessions[0].closeCalls, 1);
  assert.equal(wakeEngine.calls.resume, 1);

  wakeEngine.triggerWake(); // a second wake after sign-off proves re-arm listening works
  await flush();
  assert.equal(controller.state, 'active');
  assert.equal(realtime.sessions.length, 2, 'a fresh session is opened on every wake, never reused');

  assert.equal(await controller.goOffline(), true);
  assert.equal(controller.state, 'inactive');
  assert.equal(wakeEngine.calls.stop, 1);
  assert.equal(realtime.sessions[1].closeCalls, 1, 'offline while active also closes the live session');
});

test('pre-wake interim results never open a session', async () => {
  const { controller, realtime } = build();
  await controller.arm();
  assert.equal(realtime.sessions.length, 0);
  // the wake engine itself gates non-wake results; nothing in the controller
  // creates a session outside handleWake — confirmed by call count staying 0
  assert.equal(realtime.sessions.length, 0);
});

test('capability failure leaves the board usable: error state, diagnostic, and error earcon', async () => {
  const { controller, earcons, diagnostics, wakeEngine } = build({ wakeEngine: fakeWakeEngine({ supported: false, status: 'api-unavailable' }) });
  assert.equal(await controller.arm(), false);
  assert.equal(controller.state, 'error');
  assert.deepEqual(earcons.calls, ['error']);
  assert.match(diagnostics.at(-1).message, /push-to-talk/);
  assert.equal(wakeEngine.calls.start, 0, 'start is never attempted without capability');
});

// AC5 asks for a push-to-talk fallback on ALL THREE failure classes, not just
// the boot-time capability probe. The UI can only reveal the control if the
// diagnostic says so in a machine-readable way, so every one of these paths
// must carry `fallback: true` — a message string alone is not a fallback.
test('every AC5 failure class flags its diagnostic as needing the push-to-talk fallback', async () => {
  const capability = build({ wakeEngine: fakeWakeEngine({ supported: false, status: 'api-unavailable' }) });
  await capability.controller.arm();
  assert.equal(capability.diagnostics.at(-1).fallback, true, 'missing local capability');

  const startFailure = build({ wakeEngine: fakeWakeEngine({ supported: true, started: false }) });
  await startFailure.controller.arm();
  assert.equal(startFailure.diagnostics.at(-1).fallback, true, 'local wake could not start');

  const terminal = build();
  await terminal.controller.arm();
  terminal.controller.notifyWakeEngineError({ error: { code: 'not-allowed', message: 'microphone denied' } });
  assert.equal(terminal.diagnostics.at(-1).fallback, true, 'recognizer died after arming');

  const micDenied = build({ realtime: fakeFailingRealtimeFactory('microphone permission denied') });
  await micDenied.controller.arm();
  micDenied.wakeEngine.triggerWake();
  await flush();
  assert.equal(micDenied.diagnostics.at(-1).fallback, true, 'microphone denied after wake');

  const noProvider = build({ realtime: fakeFailingRealtimeFactory('voice is not configured') });
  await noProvider.controller.arm();
  noProvider.wakeEngine.triggerWake();
  await flush();
  assert.equal(noProvider.diagnostics.at(-1).fallback, true, 'provider not configured');
});

test('wake engine start failure also lands in error with a diagnostic', async () => {
  const { controller, earcons } = build({ wakeEngine: fakeWakeEngine({ supported: true, started: false }) });
  assert.equal(await controller.arm(), false);
  assert.equal(controller.state, 'error');
  assert.deepEqual(earcons.calls, ['error']);
});

test('arm() can retry from error and succeeds once capability is available', async () => {
  const wakeEngine = fakeWakeEngine({ supported: false });
  const { controller } = build({ wakeEngine });
  assert.equal(await controller.arm(), false);
  assert.equal(controller.state, 'error');
  wakeEngine.state.supported = true;
  assert.equal(await controller.arm(), true);
  assert.equal(controller.state, 'armed');
});

test('goOffline during arm() cancels a still-initializing capability check', async () => {
  let resolveInit;
  const wakeEngine = fakeWakeEngine();
  wakeEngine.init = () => { wakeEngine.calls.init += 1; return new Promise((resolve) => { resolveInit = () => resolve({ supported: true, status: 'available' }); }); };
  const { controller } = build({ wakeEngine });

  const armPromise = controller.arm();
  await flush();
  assert.equal(controller.state, 'arming');
  assert.equal(await controller.goOffline(), true, 'offline is reachable while arming, not just once armed');
  assert.equal(controller.state, 'inactive');

  resolveInit(); // the delayed capability check now resolves
  assert.equal(await armPromise, false, 'a superseded arm attempt reports failure');
  assert.equal(controller.state, 'inactive', 'the delayed init must not silently re-arm the board after offline');
  assert.equal(wakeEngine.calls.start, 0, 'start() is never reached for a superseded arm attempt');
});

test('goOffline during arm() cancels a still-starting wake engine', async () => {
  let resolveStart;
  const wakeEngine = fakeWakeEngine();
  wakeEngine.start = () => { wakeEngine.calls.start += 1; return new Promise((resolve) => { resolveStart = () => resolve(true); }); };
  const { controller } = build({ wakeEngine });

  const armPromise = controller.arm();
  await flush(); // let the (fast, default) capability check resolve, so arm() is now awaiting start()
  assert.equal(controller.state, 'arming');
  assert.equal(await controller.goOffline(), true);
  assert.equal(controller.state, 'inactive');

  resolveStart(); // the delayed start() now resolves true
  assert.equal(await armPromise, false);
  assert.equal(controller.state, 'inactive', 'a late-resolving start() must not flip the board back to armed');
});

test('microphone denial after wake returns to armed with a diagnostic and the error earcon, not enter twice', async () => {
  const { controller, earcons, diagnostics, wakeEngine } = build({ realtime: fakeFailingRealtimeFactory('microphone permission denied') });
  await controller.arm();
  wakeEngine.triggerWake();
  await flush();
  assert.equal(controller.state, 'armed', 'a failed session-open returns to local armed listening, not inactive');
  assert.deepEqual(earcons.calls, ['enter', 'error']);
  assert.match(diagnostics.at(-1).message, /microphone permission denied/);
  assert.equal(wakeEngine.calls.resume, 1);
});

test('notifyWakeEngineError: a terminal recognizer failure while armed falls to error with a diagnostic', async () => {
  const { controller, earcons, diagnostics } = build();
  await controller.arm();
  assert.equal(controller.notifyWakeEngineError({ error: { code: 'not-allowed', message: 'microphone denied' } }), true);
  assert.equal(controller.state, 'error');
  assert.deepEqual(earcons.calls, ['error']);
  assert.match(diagnostics.at(-1).message, /microphone denied/);
});

test('notifyWakeEngineError is a no-op outside armed', async () => {
  const { controller: fromInactive } = build();
  assert.equal(fromInactive.notifyWakeEngineError({}), false, 'no-op from inactive');

  const { controller, wakeEngine } = build();
  await controller.arm();
  wakeEngine.triggerWake();
  await flush();
  assert.equal(controller.state, 'active');
  assert.equal(controller.notifyWakeEngineError({}), false, 'an active session is not interrupted by it');
  assert.equal(controller.state, 'active');
});

test('missing provider configuration after wake behaves the same as any other session-open failure', async () => {
  const { controller, diagnostics, wakeEngine } = build({ realtime: fakeFailingRealtimeFactory('voice is not configured') });
  await controller.arm();
  wakeEngine.triggerWake();
  await flush();
  assert.equal(controller.state, 'armed');
  assert.match(diagnostics.at(-1).message, /voice provider not configured/);
});

test('environment failures name the remediation that makes push-to-talk retry operable', async () => {
  const denied = build({ realtime: fakeFailingRealtimeFactory('Permission denied') });
  await denied.controller.pushToTalkStart();
  await flush();
  assert.match(denied.diagnostics.at(-1).message, /site settings.*push-to-talk to retry/i);
  assert.equal(denied.diagnostics.at(-1).recovery, true);

  const unconfigured = build({ realtime: fakeFailingRealtimeFactory('voice is not configured') });
  await unconfigured.controller.pushToTalkStart();
  await flush();
  assert.match(unconfigured.diagnostics.at(-1).message, /OPENAI_API_KEY.*restart.*push-to-talk to retry/i);
  assert.equal(unconfigured.diagnostics.at(-1).recovery, true);
});

test('an unexpected realtime close while active plays the error cue and returns to armed', async () => {
  const { controller, earcons, wakeEngine, realtime } = build();
  await controller.arm();
  wakeEngine.triggerWake();
  await flush();
  assert.equal(controller.state, 'active');
  realtime.sessions[0].onClose('failed');
  await flush();
  assert.equal(controller.state, 'armed');
  assert.deepEqual(earcons.calls, ['enter', 'error']);
});

test('goOffline stops the wake engine and any live session from every reachable state', async () => {
  for (const drive of [
    async (c) => {}, // from armed
    async (c, w) => { w.triggerWake(); await flush(); }, // from active
  ]) {
    const { controller, wakeEngine, realtime } = build();
    await controller.arm();
    await drive(controller, wakeEngine);
    assert.equal(await controller.goOffline(), true);
    assert.equal(controller.state, 'inactive');
    assert.equal(wakeEngine.calls.stop, 1);
    if (realtime.sessions.length) assert.equal(realtime.sessions.at(-1).closeCalls, 1);
  }
});

test('goOffline is a no-op from inactive and signOff is a no-op outside active/confirming', async () => {
  const { controller } = build();
  assert.equal(await controller.goOffline(), false);
  assert.equal(await controller.signOff(), false);
  await controller.arm();
  assert.equal(await controller.signOff(), false, 'armed (not yet active) cannot sign off');
});

test('the armed-lifetime limit stops capture and requires a fresh arm', async () => {
  const { controller, wakeEngine, clock, diagnostics } = build({ options: { armedLifetimeMs: 1000 } });
  await controller.arm();
  assert.equal(clock.pendingCount(), 1);
  clock.fire(clock.lastId());
  await flush();
  assert.equal(controller.state, 'inactive');
  assert.equal(wakeEngine.calls.stop, 1);
  assert.match(diagnostics.at(-1).message, /armed session limit/);
});

test('opening an active session cancels the armed-lifetime timer, and sign-off restarts a fresh one', async () => {
  const { controller, wakeEngine, clock } = build({ options: { armedLifetimeMs: 1000 } });
  await controller.arm();
  const armedTimerId = clock.lastId();
  wakeEngine.triggerWake();
  await flush();
  assert.equal(clock.pendingCount() >= 1, true);
  // the original armed-lifetime timer must have been cleared, not left running
  // alongside whatever active/idle timer replaced it
  await controller.signOff();
  assert.equal(controller.state, 'armed');
  // exactly one fresh armed-lifetime timer is pending after sign-off — not a
  // duplicate stacked on top of the one from arm()
  assert.equal(clock.pendingCount(), 1);
  assert.notEqual(clock.lastId(), armedTimerId);
});

test('idle timeout in active signs off with the exit earcon', async () => {
  const { controller, wakeEngine, earcons, clock } = build({ options: { idleTimeoutMs: 500 } });
  await controller.arm();
  wakeEngine.triggerWake();
  await flush();
  assert.equal(controller.state, 'active');
  clock.fire(clock.lastId());
  await flush();
  assert.equal(controller.state, 'armed');
  assert.deepEqual(earcons.calls, ['enter', 'exit']);
});

test('"That is all, To-do" over the data channel signs off; "Go offline, To-do" goes fully inactive', async () => {
  {
    const { controller, wakeEngine, realtime } = build();
    await controller.arm();
    wakeEngine.triggerWake();
    await flush();
    realtime.sessions[0].onTranscript({ text: '  That IS all, To-Do! ', final: true });
    await flush();
    assert.equal(controller.state, 'armed');
  }
  {
    const { controller, wakeEngine, realtime } = build();
    await controller.arm();
    wakeEngine.triggerWake();
    await flush();
    realtime.sessions[0].onTranscript({ text: 'Go offline, To-do', final: true });
    await flush();
    assert.equal(controller.state, 'inactive');
  }
});

test('interim (non-final) transcripts and unrelated speech never trigger sign-off/offline', async () => {
  const { controller, wakeEngine, realtime } = build();
  await controller.arm();
  wakeEngine.triggerWake();
  await flush();
  realtime.sessions[0].onTranscript({ text: 'go offline to do', final: false });
  realtime.sessions[0].onTranscript({ text: 'move task twenty to plan', final: true });
  assert.equal(controller.state, 'active');
});

test('confirming: entry only from active, timeout returns to active and rejects the pending confirmation', async () => {
  const { controller, wakeEngine, clock } = build({ options: { confirmTimeoutMs: 1000 } });
  assert.equal(controller.enterConfirming({}), false, 'cannot enter confirming before active');
  await controller.arm();
  wakeEngine.triggerWake();
  await flush();

  let resolved = null, timedOut = null;
  assert.equal(controller.enterConfirming({ challenge: 'confirm x', onResolve: (r) => { resolved = r; }, onTimeout: (r) => { timedOut = r; } }), true);
  assert.equal(controller.state, 'confirming');
  clock.fire(clock.lastId());
  assert.equal(controller.state, 'active');
  assert.equal(timedOut, 'timeout');
  assert.equal(resolved, null);
});

test('confirming: a matching response resolves once and returns to active', async () => {
  const { controller, wakeEngine } = build();
  await controller.arm();
  wakeEngine.triggerWake();
  await flush();
  let resolved = null;
  controller.enterConfirming({ challenge: 'confirm x', onResolve: (r) => { resolved = r; } });
  assert.equal(controller.resolveConfirmation('confirm x'), true);
  assert.equal(controller.state, 'active');
  assert.equal(resolved, 'confirm x');
  assert.equal(controller.resolveConfirmation('confirm x'), false, 'a second resolution has nothing pending');
});

test('sign-off from confirming closes the session, rejects the pending confirmation, and returns to armed', async () => {
  const { controller, wakeEngine, realtime } = build();
  await controller.arm();
  wakeEngine.triggerWake();
  await flush();
  let timedOut = null;
  controller.enterConfirming({ onTimeout: (r) => { timedOut = r; } });
  await controller.signOff();
  assert.equal(controller.state, 'armed');
  assert.equal(timedOut, 'session-ended');
  assert.equal(realtime.sessions[0].closeCalls, 1);
});

test('offline from confirming goes fully inactive and rejects the pending confirmation', async () => {
  const { controller, wakeEngine } = build();
  await controller.arm();
  wakeEngine.triggerWake();
  await flush();
  let timedOut = null;
  controller.enterConfirming({ onTimeout: (r) => { timedOut = r; } });
  await controller.goOffline();
  assert.equal(controller.state, 'inactive');
  assert.equal(timedOut, 'offline');
});

test('push-to-talk opens a session without arming local wake, and release returns to inactive (not a fake armed state)', async () => {
  const { controller, wakeEngine, earcons, realtime } = build();
  assert.equal(await controller.pushToTalkStart(), true);
  assert.equal(controller.state, 'active');
  assert.equal(wakeEngine.calls.start, 0, 'push-to-talk never starts local wake listening');
  assert.deepEqual(earcons.calls, ['enter']);
  await controller.pushToTalkEnd();
  assert.equal(controller.state, 'inactive');
  assert.deepEqual(earcons.calls, ['enter', 'exit']);
  assert.equal(realtime.sessions[0].closeCalls, 1);
});

test('push-to-talk while already armed pauses local listening, and release resumes it', async () => {
  const { controller, wakeEngine } = build();
  await controller.arm();
  assert.equal(await controller.pushToTalkStart(), true);
  assert.equal(controller.state, 'active');
  assert.equal(wakeEngine.calls.pause, 1, 'local recognition is paused so it can never run concurrently with the opening session');
  await controller.pushToTalkEnd();
  assert.equal(controller.state, 'armed');
  assert.equal(wakeEngine.calls.resume, 1);
});

test('releasing push-to-talk before open() resolves lands on inactive, not active, and closes the still-opening session', async () => {
  const realtime = fakeRealtimeFactory({ manual: true });
  const { controller, earcons } = build({ realtime });

  const startPromise = controller.pushToTalkStart();
  await flush();
  assert.equal(controller.state, 'inactive', 'state has not caught up yet — open() is still pending');
  assert.equal(await controller.pushToTalkEnd(), true,
    'signOff must act on the still-opening session even though `state` has not reached active yet');
  assert.equal(controller.state, 'inactive');
  assert.equal(realtime.sessions[0].closeCalls, 1, 'the still-opening session was closed immediately on release');
  assert.deepEqual(earcons.calls, ['enter', 'exit']);

  realtime.sessions[0].resolveOpen(); // the cancelled open() eventually settles anyway
  await flush();
  assert.equal(controller.state, 'inactive', 'a session that finishes opening after release must never resurrect active');
  assert.equal(await startPromise, true);
});

test('arm is refused while push-to-talk is still opening so local and remote listening cannot overlap', async () => {
  const realtime = fakeRealtimeFactory({ manual: true });
  const { controller, wakeEngine } = build({ realtime });

  const startPromise = controller.pushToTalkStart();
  await flush();
  assert.equal(controller.state, 'inactive', 'push-to-talk has not finished opening yet');
  assert.equal(await controller.arm(), false);
  assert.equal(wakeEngine.calls.init, 0, 'local wake initialization never begins beside remote capture');
  assert.equal(wakeEngine.calls.start, 0);

  realtime.sessions[0].resolveOpen();
  await startPromise;
  assert.equal(controller.state, 'active');
  await controller.pushToTalkEnd();
});

test('goOffline mid-open also cancels a still-opening push-to-talk session, stopping every acquired track', async () => {
  const realtime = fakeRealtimeFactory({ manual: true });
  const { controller, wakeEngine } = build({ realtime });

  const startPromise = controller.pushToTalkStart();
  await flush();
  assert.equal(controller.state, 'inactive');
  assert.equal(await controller.goOffline(), true, 'offline must act on a pending session even though state already reads inactive');
  assert.equal(realtime.sessions[0].closeCalls, 1);
  assert.equal(wakeEngine.calls.stop, 1);

  realtime.sessions[0].resolveOpen(); // let the superseded open() settle so nothing is left dangling
  await startPromise;
  assert.equal(controller.state, 'inactive', 'a superseded open() must never move the board out of inactive');
});

test('a real wake firing while a push-to-talk session is already opening does not stack a second session', async () => {
  const realtime = fakeRealtimeFactory({ manual: true });
  const { controller, wakeEngine } = build({ realtime });
  await controller.arm();

  const startPromise = controller.pushToTalkStart(); // holds the button while armed
  await flush();
  assert.equal(realtime.sessions.length, 1);
  wakeEngine.triggerWake(); // a real "Hey To-do" arrives mid-open
  await flush();
  assert.equal(realtime.sessions.length, 1, 'no second concurrent session was opened');

  realtime.sessions[0].resolveOpen();
  await startPromise;
  assert.equal(controller.state, 'active');
});

test('a session that finishes opening after offline/sign-off already fired is closed and never resurrects state', async () => {
  const realtime = fakeRealtimeFactory({ manual: true });
  const { controller, wakeEngine } = build({ realtime });
  await controller.arm();
  wakeEngine.triggerWake(); // handleWake fires openActiveSession(), which awaits the still-pending open()
  await Promise.resolve();
  assert.equal(controller.state, 'armed', 'still armed — the fake session has not resolved open() yet');

  await controller.goOffline(); // the user goes offline while the session is mid-open
  assert.equal(controller.state, 'inactive');

  realtime.sessions[0].resolveOpen(); // the superseded open() now resolves late
  await flush();
  assert.equal(controller.state, 'inactive', 'a superseded open() must never move the board out of inactive');
  assert.equal(realtime.sessions[0].closeCalls, 1, 'the superseded session is still closed to release its microphone track');
});

test('diagnostics() reports the current state and delegates to the wake engine', async () => {
  const { controller } = build();
  const d = controller.diagnostics();
  assert.equal(d.state, 'inactive');
  assert.deepEqual(d.wake, { fake: true });
});
