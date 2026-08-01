import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  createLocalSpeechWakeEngine,
  inspectLocalSpeech,
  isWakePhrase,
  normalizeWakePhrase,
} from '../scripts/voice-spike/local-speech-wake.js';

function fakeRecognitionClass({ status = 'available', local = true, rejectQuality = false } = {}) {
  return class FakeRecognition {
    static instances = [];
    static availableCalls = [];
    static installCalls = [];
    static status = status;

    static async available(options) {
      this.availableCalls.push(options);
      if (rejectQuality && 'quality' in options) throw new TypeError('quality is not supported');
      return this.status;
    }

    static async install(options) {
      this.installCalls.push(options);
      this.status = 'available';
      return true;
    }

    constructor() {
      if (local) this.processLocally = false;
      this.started = false;
      this.aborted = false;
      this.constructor.instances.push(this);
    }

    start() {
      this.started = true;
      this.onstart?.();
    }

    abort() {
      this.aborted = true;
    }

    result(transcript, isFinal = true) {
      const alternative = { transcript, confidence: 0.99 };
      const result = Object.assign([alternative], { isFinal });
      this.onresult?.({ resultIndex: 0, results: [result] });
    }
  };
}

test('wake phrase normalization accepts only the intended command', () => {
  assert.equal(normalizeWakePhrase('  HEY, To-Do! '), 'hey to do');
  for (const phrase of ['Hey To-do', 'hey to do', 'HEY TODO']) assert.equal(isWakePhrase(phrase), true);
  for (const phrase of ['okay todo', 'hey do', 'move task twenty', 'hey todo please']) assert.equal(isWakePhrase(phrase), false);
});

test('capability inspection requires processLocally and never probes remote recognition', async () => {
  const NoLocal = fakeRecognitionClass({ local: false });
  const result = await inspectLocalSpeech({ scope: { SpeechRecognition: NoLocal }, lang: 'en-US' });
  assert.equal(result.supported, false);
  assert.equal(result.status, 'local-only-unavailable');
  assert.deepEqual(NoLocal.availableCalls, []);
});

test('capability inspection installs only a strictly local language pack', async () => {
  const Recognition = fakeRecognitionClass({ status: 'downloadable' });
  const result = await inspectLocalSpeech({ scope: { SpeechRecognition: Recognition }, lang: 'en-US', install: true });
  assert.equal(result.supported, true);
  assert.equal(result.status, 'available');
  assert.equal(Recognition.availableCalls.every((call) => call.processLocally === true), true);
  assert.equal(Recognition.installCalls.length, 1);
  assert.deepEqual(Recognition.installCalls[0].langs, ['en-US']);
  assert.equal(Recognition.installCalls[0].quality, 'command');
});

test('older local API falls back from the quality option without allowing remote processing', async () => {
  const Recognition = fakeRecognitionClass({ rejectQuality: true });
  const result = await inspectLocalSpeech({ scope: { SpeechRecognition: Recognition } });
  assert.equal(result.supported, true);
  assert.equal(result.quality, 'browser-default');
  assert.equal(Recognition.availableCalls.length, 2);
  assert.equal(Recognition.availableCalls[1].processLocally, true);
  assert.equal('quality' in Recognition.availableCalls[1], false);
});

test('engine ignores interim and unrelated results, then pauses on a finalized exact wake', async () => {
  const Recognition = fakeRecognitionClass();
  const wakes = [];
  const engine = createLocalSpeechWakeEngine({ scope: { SpeechRecognition: Recognition } });
  assert.equal(await engine.start((wake) => wakes.push(wake)), true);
  const active = Recognition.instances.at(-1);
  assert.equal(active.processLocally, true);
  active.result('Hey To-do', false);
  active.result('Hey To-do please', true);
  assert.deepEqual(wakes, []);
  active.result('Hey To-do', true);
  assert.equal(wakes.length, 1);
  assert.equal(active.aborted, true);
  assert.equal(engine.diagnostics().state, 'paused');
});

test('ordinary recognition end restarts, while a terminal local error does not', async () => {
  const Recognition = fakeRecognitionClass();
  const scheduled = [];
  const engine = createLocalSpeechWakeEngine({
    scope: { SpeechRecognition: Recognition },
    setTimeoutFn(fn, delay) { scheduled.push({ fn, delay }); return scheduled.length; },
    clearTimeoutFn() {},
  });
  await engine.start();
  Recognition.instances.at(-1).onend();
  assert.equal(scheduled.length, 1);
  assert.equal(scheduled[0].delay, 250);
  scheduled.shift().fn();
  assert.equal(Recognition.instances.length >= 3, true); // capability probe plus two live instances
  const active = Recognition.instances.at(-1);
  active.onerror({ error: 'not-allowed', message: 'microphone denied' });
  assert.equal(active.aborted, true);
  active.onend();
  assert.equal(engine.diagnostics().state, 'error');
  assert.equal(scheduled.length, 0);
});
