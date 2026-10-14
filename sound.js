// Small synthesized sounds (no audio files to download, works offline).
let ctx = null;
let enabled = true;

export function setSoundEnabled(on) { enabled = on; }

// Browsers only allow audio after a user gesture: create/resume on the first tap.
function unlock() {
  try {
    if (!ctx) ctx = new (window.AudioContext || window.webkitAudioContext)();
    if (ctx.state === 'suspended') ctx.resume();
  } catch { /* no audio support */ }
}
addEventListener('pointerdown', unlock, { capture: true });
addEventListener('keydown', unlock, { capture: true });

function tone({ freq = 440, type = 'sine', dur = 0.08, gain = 0.2, at = 0, slide = 0 }) {
  const t = ctx.currentTime + at;
  const o = ctx.createOscillator();
  const g = ctx.createGain();
  o.type = type;
  o.frequency.setValueAtTime(freq, t);
  if (slide) o.frequency.exponentialRampToValueAtTime(freq * slide, t + dur);
  g.gain.setValueAtTime(0.0001, t);
  g.gain.exponentialRampToValueAtTime(gain, t + 0.005);
  g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
  o.connect(g).connect(ctx.destination);
  o.start(t);
  o.stop(t + dur + 0.02);
}

// A short wooden "knock": filtered noise burst.
function knock({ at = 0, gain = 0.5, freq = 900, dur = 0.06 }) {
  const t = ctx.currentTime + at;
  const len = Math.ceil(ctx.sampleRate * dur);
  const buf = ctx.createBuffer(1, len, ctx.sampleRate);
  const d = buf.getChannelData(0);
  for (let i = 0; i < len; i++) d[i] = (Math.random() * 2 - 1) * Math.pow(1 - i / len, 4);
  const src = ctx.createBufferSource();
  src.buffer = buf;
  const f = ctx.createBiquadFilter();
  f.type = 'bandpass'; f.frequency.value = freq; f.Q.value = 1.2;
  const g = ctx.createGain();
  g.gain.value = gain;
  src.connect(f).connect(g).connect(ctx.destination);
  src.start(t);
}

const SOUNDS = {
  move: () => knock({ freq: 800 }),
  capture: () => { knock({ freq: 600, gain: 0.7 }); knock({ freq: 1100, gain: 0.4, at: 0.05 }); },
  castle: () => { knock({ freq: 800 }); knock({ freq: 800, at: 0.11 }); },
  check: () => { knock({ freq: 800 }); tone({ freq: 880, type: 'triangle', dur: 0.12, gain: 0.12, at: 0.02 }); },
  start: () => { tone({ freq: 523, dur: 0.12, gain: 0.1 }); tone({ freq: 784, dur: 0.18, gain: 0.1, at: 0.1 }); },
  win: () => [523, 659, 784, 1047].forEach((f, i) => tone({ freq: f, type: 'triangle', dur: 0.2, gain: 0.12, at: i * 0.1 })),
  lose: () => [392, 330, 262].forEach((f, i) => tone({ freq: f, type: 'triangle', dur: 0.25, gain: 0.12, at: i * 0.14 })),
  draw: () => { tone({ freq: 523, type: 'triangle', dur: 0.2, gain: 0.1 }); tone({ freq: 523, type: 'triangle', dur: 0.25, gain: 0.1, at: 0.18 }); },
  tick: () => tone({ freq: 1500, type: 'square', dur: 0.025, gain: 0.04 }),
  error: () => tone({ freq: 200, type: 'sawtooth', dur: 0.12, gain: 0.06 }),
};

export function play(name) {
  if (!enabled || !ctx || ctx.state !== 'running') return;
  try { SOUNDS[name]?.(); } catch { /* ignore */ }
}

// Which sound fits a chess.js verbose move.
export function soundFor(m, inCheck) {
  if (!m) return 'move';
  if (inCheck) return 'check';
  if (/[kq]/.test(m.flags)) return 'castle';
  if (m.captured) return 'capture';
  return 'move';
}
