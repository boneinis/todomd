// public/voice/wake-word.js is the production port of the scripts/voice-spike/
// capability adapter (see test/voice-spike.test.js for the original harness
// coverage). These tests exercise the same strict-local contract against the
// production module every board mic control actually imports.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  createWakeWordEngine,
  inspectLocalSpeech,
  isWakePhrase,
  normalizeWakePhrase,
} from '../public/voice/wake-word.js';

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

test('capability inspection with install:false never installs the local pack', async () => {
  const Recognition = fakeRecognitionClass({ status: 'downloadable' });
  const result = await inspectLocalSpeech({ scope: { SpeechRecognition: Recognition }, lang: 'en-US', install: false });
  assert.equal(result.supported, false);
  assert.equal(result.status, 'downloadable');
  assert.equal(Recognition.installCalls.length, 0);
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

test('missing SpeechRecognition constructor reports api-unavailable, not a throw', async () => {
  const result = await inspectLocalSpeech({ scope: {} });
  assert.equal(result.supported, false);
  assert.equal(result.status, 'api-unavailable');
});

test('engine ignores interim and unrelated results, then pauses on a finalized exact wake', async () => {
  const Recognition = fakeRecognitionClass();
  const wakes = [];
  const engine = createWakeWordEngine({ scope: { SpeechRecognition: Recognition } });
  assert.equal(await engine.start((wake) => wakes.push(wake)), true);
  const active = Recognition.instances.at(-1);
  assert.equal(active.processLocally, true);
  active.result('Hey To-do', false);
  active.result('Hey To-do please', true);
  assert.deepEqual(wakes, [], 'interim results and near-miss phrases never wake');
  active.result('Hey To-do', true);
  assert.equal(wakes.length, 1);
  assert.equal(active.aborted, true, 'recognition is stopped before the wake handler runs');
  assert.equal(engine.diagnostics().state, 'paused');
});

test('the wake gate matches only the recognizer\'s top-ranked alternative, never a lower-ranked one', async () => {
  const Recognition = fakeRecognitionClass();
  const wakes = [];
  const engine = createWakeWordEngine({ scope: { SpeechRecognition: Recognition } });
  await engine.start((wake) => wakes.push(wake));
  const active = Recognition.instances.at(-1);
  assert.equal(active.maxAlternatives, 1, 'the engine requests only the top alternative — there is nothing else to match');

  // The recognizer's own best guess is ordinary conversation; a much less
  // likely second alternative happens to be the wake phrase. Only index 0
  // may ever open the gate.
  const result = Object.assign(
    [
      { transcript: 'anyway I think we should', confidence: 0.9 },
      { transcript: 'Hey To-do', confidence: 0.2 },
    ],
    { isFinal: true },
  );
  active.onresult({ resultIndex: 0, results: [result] });
  assert.deepEqual(wakes, [], 'a lower-ranked alternative must never open the gate');
  assert.equal(engine.diagnostics().state, 'armed', 'the engine keeps listening normally');
});

test('engine never arms without processLocally support', async () => {
  const NoLocal = fakeRecognitionClass({ local: false });
  const engine = createWakeWordEngine({ scope: { SpeechRecognition: NoLocal } });
  const started = await engine.start(() => {});
  assert.equal(started, false);
  assert.equal(engine.diagnostics().state, 'error');
  assert.equal(NoLocal.instances.length, 1, 'only the one-shot capability probe instance was ever created');
});

test('ordinary recognition end restarts, while a terminal local error does not', async () => {
  const Recognition = fakeRecognitionClass();
  const scheduled = [];
  const engine = createWakeWordEngine({
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

test('a stale recognizer\'s delayed end event never clobbers or duplicates the live one', async () => {
  const Recognition = fakeRecognitionClass();
  const scheduled = [];
  const engine = createWakeWordEngine({
    scope: { SpeechRecognition: Recognition },
    setTimeoutFn(fn, delay) { scheduled.push({ fn, delay }); return scheduled.length; },
    clearTimeoutFn() {},
  });
  await engine.start(() => {});
  const first = Recognition.instances.at(-1);

  // A finalized wake pauses the engine and aborts `first`. Chrome delivers
  // that instance's `end` event asynchronously — routinely after the session
  // has already ended and resume() installed a replacement.
  first.result('Hey To-do', true);
  assert.equal(engine.diagnostics().state, 'paused');
  assert.equal(engine.resume(), true);
  const second = Recognition.instances.at(-1);
  assert.notEqual(second, first, 'resume() installs a fresh recognizer');
  const liveCount = Recognition.instances.length;

  first.onend(); // the obsolete instance finally reports that it ended
  while (scheduled.length) scheduled.shift().fn(); // drain any restart it wrongly scheduled
  assert.equal(Recognition.instances.length, liveCount, 'a stale end must not start a third recognizer');
  assert.equal(Recognition.instances.at(-1), second, 'the resumed recognizer is still the live one');

  engine.stop();
  assert.equal(second.aborted, true, 'stop() aborts the recognizer that is actually listening');
  assert.equal(engine.diagnostics().state, 'inactive');
});

test('pause/resume/stop drive the diagnostics state without losing capability info', async () => {
  const Recognition = fakeRecognitionClass();
  const engine = createWakeWordEngine({ scope: { SpeechRecognition: Recognition } });
  await engine.start();
  assert.equal(engine.diagnostics().state, 'armed');

  engine.pause();
  assert.equal(engine.diagnostics().state, 'paused');
  assert.equal(Recognition.instances.at(-1).aborted, true);

  assert.equal(engine.resume(), true);
  assert.equal(engine.diagnostics().state, 'armed');

  engine.stop();
  assert.equal(engine.diagnostics().state, 'inactive');
  assert.equal(engine.resume(), false, 'a stopped engine requires a fresh arm, not resume');
});
