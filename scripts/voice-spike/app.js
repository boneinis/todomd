import { createLocalSpeechWakeEngine, inspectLocalSpeech } from './local-speech-wake.js';

const $ = (id) => document.getElementById(id);
const capability = $('capability');
const state = $('state');
const interim = $('interim');
const log = $('log');
const arm = $('arm');
const stop = $('stop');
const mark = $('mark');
const download = $('download');

const metrics = {
  startedAt: null,
  endedAt: null,
  userAgent: navigator.userAgent,
  language: 'en-US',
  intendedAttempts: 0,
  intendedDetected: 0,
  falseWakes: 0,
  recognitionEnds: 0,
  restartSchedules: 0,
  events: [],
};
let intendedPending = false;
let clearInterim = null;

function addEvent(type, details = {}) {
  const event = { at: new Date().toISOString(), type, ...details };
  metrics.events.push(event);
  if (metrics.events.length > 500) metrics.events.shift();
  const row = document.createElement('li');
  row.textContent = `${event.at.slice(11, 19)}  ${type}${details.message ? ` — ${details.message}` : ''}`;
  log.prepend(row);
}

function refreshMetrics() {
  $('attempts').textContent = String(metrics.intendedAttempts);
  $('detected').textContent = String(metrics.intendedDetected);
  $('false-wakes').textContent = String(metrics.falseWakes);
  $('recognition-ends').textContent = String(metrics.recognitionEnds);
}

const engine = createLocalSpeechWakeEngine({
  scope: window,
  onStatus(event) {
    state.textContent = event.state;
    state.dataset.state = event.state;
    if (event.event === 'ended') metrics.recognitionEnds += 1;
    if (event.event === 'restart-scheduled') metrics.restartSchedules += 1;
    if (event.event === 'error' || event.event === 'restart-exhausted') {
      addEvent(event.event, { message: event.error?.message || event.error?.code || 'recognition stopped' });
    } else if (['started', 'ended', 'restart-scheduled', 'wake'].includes(event.event)) {
      addEvent(event.event);
    }
    refreshMetrics();
  },
  onResult(result) {
    interim.textContent = result.transcript;
    interim.dataset.final = String(result.final);
    window.clearTimeout(clearInterim);
    clearInterim = window.setTimeout(() => { interim.textContent = '—'; }, 5000);
  },
});

async function checkCapability({ install = false } = {}) {
  capability.textContent = install ? 'checking / installing local model…' : 'checking…';
  const result = await inspectLocalSpeech({ scope: window, lang: metrics.language, install });
  capability.textContent = `${result.status} · ${result.quality || 'no quality'} · ${result.lang}`;
  capability.dataset.supported = String(result.supported);
  addEvent('capability', { message: capability.textContent });
  return result;
}

arm.addEventListener('click', async () => {
  arm.disabled = true;
  const result = await engine.init({ install: true });
  capability.textContent = `${result.status} · ${result.quality || 'no quality'} · ${result.lang}`;
  capability.dataset.supported = String(result.supported);
  if (!result.supported) {
    addEvent('arm-refused', { message: result.error?.message || result.status });
    arm.disabled = false;
    return;
  }
  metrics.startedAt ||= new Date().toISOString();
  await engine.start(() => {
    if (intendedPending) {
      intendedPending = false;
      metrics.intendedDetected += 1;
      mark.dataset.pending = 'false';
      mark.textContent = 'Mark next wake as intentional';
      addEvent('intended-wake-detected');
    } else {
      metrics.falseWakes += 1;
      addEvent('false-wake-detected');
    }
    refreshMetrics();
    window.setTimeout(() => engine.resume(), 800);
  });
  stop.disabled = false;
  mark.disabled = false;
  download.disabled = false;
});

stop.addEventListener('click', () => {
  engine.stop();
  metrics.endedAt = new Date().toISOString();
  arm.disabled = false;
  stop.disabled = true;
  mark.disabled = true;
  intendedPending = false;
  mark.dataset.pending = 'false';
  mark.textContent = 'Mark next wake as intentional';
  addEvent('stopped');
});

mark.addEventListener('click', () => {
  intendedPending = true;
  metrics.intendedAttempts += 1;
  mark.dataset.pending = 'true';
  mark.textContent = 'Now say “Hey To-do”';
  addEvent('intended-wake-marked');
  refreshMetrics();
});

download.addEventListener('click', () => {
  const report = {
    ...metrics,
    endedAt: metrics.endedAt || new Date().toISOString(),
    diagnostics: engine.diagnostics(),
  };
  const link = document.createElement('a');
  link.href = URL.createObjectURL(new Blob([`${JSON.stringify(report, null, 2)}\n`], { type: 'application/json' }));
  link.download = `todomd-voice-spike-${new Date().toISOString().replace(/[:.]/g, '-')}.json`;
  link.click();
  URL.revokeObjectURL(link.href);
});

window.addEventListener('pagehide', () => engine.stop());
checkCapability();
