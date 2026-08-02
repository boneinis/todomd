// Web Audio entry/exit/error earcons (docs/voice-control-plan.md § Earcons).
// No binary assets: every tone is a short synthesized two-tone envelope. The
// AudioContext constructor is dependency-injected so unit tests can supply a
// fake and assert exact tone sequences without real audio hardware; a browser
// that lacks Web Audio (or a closed engine) degrades to a silent no-op rather
// than throwing — the visible state text carries the same information for
// reduced-motion / no-audio contexts.
const TONES = {
  // rising two-tone: wake → active session opened
  enter: [[660, 0.09], [880, 0.11]],
  // falling two-tone: sign-off → back to local armed listening
  exit: [[880, 0.09], [660, 0.11]],
  // single low tone: capability failure, session-open failure, or an
  // unexpected close — deliberately never reused as the successful exit cue
  error: [[220, 0.16]],
};

export function createEarcons({ scope = globalThis, audioContextFactory, gain = 0.08 } = {}) {
  const factory = audioContextFactory || (() => {
    const Ctx = scope?.AudioContext || scope?.webkitAudioContext;
    return Ctx ? new Ctx() : null;
  });
  let ctx = null;
  let closed = false;

  function ensureContext() {
    if (closed) return null;
    if (!ctx) {
      try { ctx = factory(); } catch { ctx = null; }
    }
    return ctx;
  }

  function playSequence(steps) {
    const audio = ensureContext();
    if (!audio) return false;
    try {
      let t = audio.currentTime;
      for (const [freq, duration] of steps) {
        const osc = audio.createOscillator();
        const g = audio.createGain();
        osc.type = 'sine';
        osc.frequency.value = freq;
        g.gain.setValueAtTime(0, t);
        g.gain.linearRampToValueAtTime(gain, t + 0.015);
        g.gain.linearRampToValueAtTime(0, t + duration);
        osc.connect(g);
        g.connect(audio.destination);
        osc.start(t);
        osc.stop(t + duration + 0.02);
        t += duration;
      }
      return true;
    } catch {
      return false; // a hostile/broken AudioContext must never break the state machine
    }
  }

  return {
    enter: () => playSequence(TONES.enter),
    exit: () => playSequence(TONES.exit),
    error: () => playSequence(TONES.error),
    close() {
      closed = true;
      try { ctx?.close?.(); } catch { /* already closed */ }
      ctx = null;
    },
  };
}
