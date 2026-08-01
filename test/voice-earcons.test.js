import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createEarcons } from '../public/voice/earcons.js';

function fakeAudioContext() {
  const oscillators = [];
  class FakeOscillator {
    constructor() { this.frequency = { value: null }; this.type = null; this.started = null; this.stopped = null; oscillators.push(this); }
    connect() { return this; }
    start(t) { this.started = t; }
    stop(t) { this.stopped = t; }
  }
  class FakeGain {
    constructor() { this.calls = []; }
    connect() { return this; }
    get gain() {
      return {
        setValueAtTime: (v, t) => this.calls.push(['set', v, t]),
        linearRampToValueAtTime: (v, t) => this.calls.push(['ramp', v, t]),
      };
    }
  }
  return {
    oscillators,
    currentTime: 0,
    closeCalls: 0,
    createOscillator() { return new FakeOscillator(); },
    createGain() { return new FakeGain(); },
    destination: {},
    close() { this.closeCalls += 1; },
  };
}

test('enter and exit play distinct two-tone sequences in opposite frequency order', () => {
  const audio = fakeAudioContext();
  const earcons = createEarcons({ audioContextFactory: () => audio });
  assert.equal(earcons.enter(), true);
  const enterFreqs = audio.oscillators.map((o) => o.frequency.value);
  audio.oscillators.length = 0;
  assert.equal(earcons.exit(), true);
  const exitFreqs = audio.oscillators.map((o) => o.frequency.value);

  assert.equal(enterFreqs.length, 2);
  assert.equal(exitFreqs.length, 2);
  assert.deepEqual(exitFreqs, [...enterFreqs].reverse(), 'exit is the falling mirror of the rising enter tone');
  assert.notDeepEqual(enterFreqs, exitFreqs);
});

test('error plays a single low tone, distinct from enter and exit, never reused as the success cue', () => {
  const audio = fakeAudioContext();
  const earcons = createEarcons({ audioContextFactory: () => audio });
  earcons.error();
  assert.equal(audio.oscillators.length, 1);
  const [errorFreq] = audio.oscillators.map((o) => o.frequency.value);

  audio.oscillators.length = 0;
  earcons.enter();
  const enterFreqs = audio.oscillators.map((o) => o.frequency.value);
  audio.oscillators.length = 0;
  earcons.exit();
  const exitFreqs = audio.oscillators.map((o) => o.frequency.value);

  assert.equal(enterFreqs.includes(errorFreq), false);
  assert.equal(exitFreqs.includes(errorFreq), false);
});

test('each call reuses one lazily-created AudioContext, not one per tone', () => {
  let created = 0;
  const audio = fakeAudioContext();
  const earcons = createEarcons({ audioContextFactory: () => { created += 1; return audio; } });
  assert.equal(created, 0, 'no context until the first tone plays');
  earcons.enter();
  earcons.exit();
  earcons.error();
  assert.equal(created, 1);
});

test('no AudioContext available degrades to a silent no-op, never throws', () => {
  const earcons = createEarcons({ scope: {} });
  assert.equal(earcons.enter(), false);
  assert.equal(earcons.exit(), false);
  assert.equal(earcons.error(), false);
});

test('a hostile AudioContext factory cannot break the state machine', () => {
  const earcons = createEarcons({ audioContextFactory: () => { throw new Error('nope'); } });
  assert.equal(earcons.enter(), false);
});

test('close() stops future tones from opening a fresh context', () => {
  let created = 0;
  const earcons = createEarcons({ audioContextFactory: () => { created += 1; return fakeAudioContext(); } });
  earcons.enter();
  assert.equal(created, 1);
  earcons.close();
  assert.equal(earcons.enter(), false);
  assert.equal(created, 1, 'close() must not be followed by a silent re-open');
});
