// Production WakeWordEngine adapter (docs/voice.md, docs/voice-control-plan.md).
//
// This is the browser's on-device Chrome SpeechRecognition path, productionized
// from the scripts/voice-spike/ capability harness with the same strict
// contract: `processLocally` is required end to end and no code path may retry
// with remote recognition. Every browser API is dependency-injected via
// `scope` so this module has zero ambient globals and node --test can drive it
// with a fake SpeechRecognition class — no microphone, account, or network.
const DEFAULT_RESTART_DELAYS = Object.freeze([250, 500, 1000, 2000]);
const TERMINAL_ERRORS = new Set([
  'audio-capture',
  'language-not-supported',
  'network',
  'not-allowed',
  'phrases-not-supported',
  'service-not-allowed',
]);

export function normalizeWakePhrase(value) {
  return String(value || '')
    .normalize('NFKD')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
    .replace(/\s+/g, ' ');
}

export function isWakePhrase(value) {
  const normalized = normalizeWakePhrase(value);
  return normalized === 'hey to do' || normalized === 'hey todo';
}

function recognitionClass(scope) {
  return scope?.SpeechRecognition || scope?.webkitSpeechRecognition || null;
}

function boundedError(error) {
  if (!error) return null;
  const code = String(error.error || error.code || error.name || 'recognition_error').slice(0, 80);
  const message = String(error.message || '').replace(/\s+/g, ' ').trim().slice(0, 240);
  return { code, message };
}

async function availability(Recognition, options) {
  try {
    return { status: await Recognition.available({ ...options, quality: 'command' }), quality: 'command' };
  } catch (error) {
    if (!(error instanceof TypeError)) throw error;
    return { status: await Recognition.available(options), quality: 'browser-default' };
  }
}

// Read-only capability probe: never requests microphone permission, and only
// downloads the local language pack when `install` is explicitly true (the
// board calls this with install:false on load for diagnostics, and the wake
// engine itself calls it with install:true only from an explicit arm gesture).
export async function inspectLocalSpeech({ scope = globalThis, lang = 'en-US', install = false } = {}) {
  const Recognition = recognitionClass(scope);
  const browser = scope?.navigator?.userAgent || 'unknown';
  if (!Recognition) {
    return { supported: false, status: 'api-unavailable', lang, browser, quality: null };
  }

  let probe;
  try {
    probe = new Recognition();
  } catch (error) {
    return { supported: false, status: 'constructor-failed', lang, browser, quality: null, error: boundedError(error) };
  }
  if (!('processLocally' in probe)) {
    return { supported: false, status: 'local-only-unavailable', lang, browser, quality: null };
  }
  if (typeof Recognition.available !== 'function') {
    return { supported: false, status: 'availability-api-unavailable', lang, browser, quality: null };
  }

  const options = { langs: [lang], processLocally: true };
  try {
    let result = await availability(Recognition, options);
    if (install && (result.status === 'downloadable' || result.status === 'downloading')) {
      if (typeof Recognition.install !== 'function') {
        return { supported: false, status: 'install-api-unavailable', lang, browser, quality: result.quality };
      }
      const installOptions = result.quality === 'command' ? { ...options, quality: 'command' } : options;
      if (!await Recognition.install(installOptions)) {
        return { supported: false, status: 'install-failed', lang, browser, quality: result.quality };
      }
      result = await availability(Recognition, options);
    }
    return {
      supported: result.status === 'available',
      status: result.status,
      lang,
      browser,
      quality: result.quality,
    };
  } catch (error) {
    return {
      supported: false,
      status: 'availability-failed',
      lang,
      browser,
      quality: null,
      error: boundedError(error),
    };
  }
}

// { init(), start(onWake), pause(), resume(), stop(), diagnostics() } —
// docs/voice.md's replaceable WakeWordEngine contract.
export function createWakeWordEngine({
  scope = globalThis,
  lang = 'en-US',
  restartDelays = DEFAULT_RESTART_DELAYS,
  setTimeoutFn = globalThis.setTimeout?.bind(globalThis),
  clearTimeoutFn = globalThis.clearTimeout?.bind(globalThis),
  onStatus = () => {},
  onResult = () => {},
} = {}) {
  const Recognition = recognitionClass(scope);
  let recognition = null;
  let availabilityResult = null;
  let state = 'inactive';
  let wakeCount = 0;
  let restartCount = 0;
  let startFailureCount = 0;
  let restartTimer = null;
  let lastError = null;
  let wakeHandler = () => {};

  const emitStatus = (event, extra = {}) => onStatus({ event, state, ...extra });

  function cancelRestart() {
    if (restartTimer !== null && clearTimeoutFn) clearTimeoutFn(restartTimer);
    restartTimer = null;
  }

  function terminal(error, event = 'error') {
    cancelRestart();
    state = 'error';
    lastError = boundedError(error);
    const active = recognition;
    recognition = null;
    try { active?.abort(); } catch { /* already stopped */ }
    emitStatus(event, { error: lastError });
  }

  function scheduleStart() {
    if (state !== 'armed') return;
    if (startFailureCount >= restartDelays.length) {
      terminal({ code: 'repeated-start-failure', message: 'Local recognition could not restart.' }, 'restart-exhausted');
      return;
    }
    const delay = restartDelays[Math.min(startFailureCount, restartDelays.length - 1)] ?? 0;
    restartCount += 1;
    emitStatus('restart-scheduled', { delay, restartCount });
    restartTimer = setTimeoutFn(() => {
      restartTimer = null;
      startRecognition();
    }, delay);
  }

  function startRecognition() {
    if (state !== 'armed') return;
    try {
      recognition = new Recognition();
      recognition.lang = lang;
      recognition.continuous = true;
      recognition.interimResults = true;
      // The wake gate matches only the recognizer's own top-ranked guess (see
      // onresult below); requesting more than one alternative would let a
      // lower-confidence guess of "hey to-do" wake the board even while the
      // recognizer's actual best guess was ordinary conversation.
      recognition.maxAlternatives = 1;
      recognition.processLocally = true;
    } catch (error) {
      recognition = null;
      startFailureCount += 1;
      lastError = boundedError(error);
      emitStatus('start-failed', { error: lastError, startFailureCount });
      scheduleStart();
      return;
    }

    // SpeechRecognition delivers `end` (and a trailing `error`) asynchronously
    // after abort(), so an obsolete recognizer's events routinely arrive once
    // pause/resume, stop(), or terminal() has already installed — or cleared —
    // a different one. Every handler below is fenced to the instance it was
    // attached to: a stale event must never null out, abort, or schedule a
    // restart for the recognizer that is actually listening.
    const instance = recognition;
    const isCurrent = () => recognition === instance;

    recognition.onstart = () => {
      if (!isCurrent()) return;
      startFailureCount = 0;
      emitStatus('started');
    };
    recognition.onresult = (event) => {
      if (!isCurrent()) return;
      for (let index = event.resultIndex || 0; index < event.results.length; index += 1) {
        const result = event.results[index];
        // Only the recognizer's own top-ranked (index 0) transcript may open
        // the gate. A lower-ranked alternative is the recognizer itself
        // saying that guess was less likely than what it actually heard, so
        // it must never be treated as an exact finalized "Hey To-do".
        const transcript = String(result[0]?.transcript || '');
        onResult({ transcript, final: Boolean(result.isFinal) });
        if (!result.isFinal || !isWakePhrase(transcript) || state !== 'armed') continue;
        wakeCount += 1;
        state = 'paused';
        emitStatus('wake', { wakeCount });
        try { instance.abort(); } catch { /* already stopped */ }
        wakeHandler({ phrase: 'hey to-do', wakeCount });
        return;
      }
    };
    recognition.onerror = (event) => {
      if (!isCurrent()) return;
      const code = String(event?.error || 'recognition-error');
      if (code === 'aborted' && state !== 'armed') return;
      lastError = boundedError(event);
      emitStatus('recognition-error', { error: lastError });
      if (TERMINAL_ERRORS.has(code)) terminal(event);
    };
    recognition.onend = () => {
      if (!isCurrent()) return;
      recognition = null;
      emitStatus('ended');
      if (state === 'armed') scheduleStart();
    };

    try {
      recognition.start();
    } catch (error) {
      recognition = null;
      startFailureCount += 1;
      lastError = boundedError(error);
      emitStatus('start-failed', { error: lastError, startFailureCount });
      scheduleStart();
    }
  }

  return {
    async init({ install = true } = {}) {
      availabilityResult = await inspectLocalSpeech({ scope, lang, install });
      emitStatus('capability', { capability: availabilityResult });
      return availabilityResult;
    },

    async start(onWake = () => {}) {
      cancelRestart();
      wakeHandler = onWake;
      if (!availabilityResult?.supported) availabilityResult = await this.init({ install: true });
      if (!availabilityResult.supported) {
        terminal({ code: availabilityResult.status, message: 'Strictly local speech recognition is unavailable.' });
        return false;
      }
      state = 'armed';
      startFailureCount = 0;
      emitStatus('arming');
      startRecognition();
      return true;
    },

    pause() {
      cancelRestart();
      if (state === 'armed') state = 'paused';
      try { recognition?.abort(); } catch { /* already stopped */ }
      emitStatus('paused');
    },

    resume() {
      if (!availabilityResult?.supported || state === 'inactive') return false;
      cancelRestart();
      state = 'armed';
      emitStatus('resuming');
      startRecognition();
      return true;
    },

    stop() {
      cancelRestart();
      state = 'inactive';
      try { recognition?.abort(); } catch { /* already stopped */ }
      recognition = null;
      emitStatus('stopped');
    },

    diagnostics() {
      return {
        state,
        availability: availabilityResult,
        wakeCount,
        restartCount,
        startFailureCount,
        lastError,
      };
    },
  };
}
