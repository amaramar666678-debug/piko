// Generates the 28 WAVs the island plays, at SOUNDS_DIR (see vite.config.ts).
//
// The original set were the macOS app's own files and were never in the repo, so
// a Windows build shipped with no audio at all. These are synthesised instead:
// pure arithmetic into a WAV writer, no dependencies, no third-party licences, and
// every file is reproducible from this one script.
//
// Run with `npm run sounds`. Re-running overwrites in place.

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
// The shared folder is declared in vite.config.ts too; kept in step with it by
// hand rather than imported, because vite.config.ts pulls in all of vite.
const OUT_DIR = resolve(root, "../NotchBuddy/Resources/sounds");

const SR = 44100;
const BITS = 16;

// -- Oscillators ---------------------------------------------------------------

/** One-pole lowpass. `hz` may be a number or a per-sample function. */
function lowpass(sig, hz) {
  const out = new Float32Array(sig.length);
  let y = 0;
  for (let i = 0; i < sig.length; i++) {
    const f = typeof hz === "function" ? hz(i / sig.length) : hz;
    // A cutoff above Nyquist would fold back on itself; clamp so the coefficient
    // stays inside (0, 1).
    const fc = Math.min(Math.max(f, 10), SR * 0.45);
    const a = 1 - Math.exp((-2 * Math.PI * fc) / SR);
    y += a * (sig[i] - y);
    out[i] = y;
  }
  return out;
}

/** One-pole highpass, for taking the thump out of a click. */
function highpass(sig, hz) {
  const out = new Float32Array(sig.length);
  let y = 0;
  let prev = 0;
  for (let i = 0; i < sig.length; i++) {
    const f = typeof hz === "function" ? hz(i / sig.length) : hz;
    const fc = Math.min(Math.max(f, 10), SR * 0.45);
    const a = 1 - Math.exp((-2 * Math.PI * fc) / SR);
    y = a * (y + sig[i] - prev);
    prev = sig[i];
    out[i] = y;
  }
  return out;
}

/**
 * Oscillator, summing a few harmonics with a 1/k rolloff.
 *
 * A naive saw is a stack of aliased partials and sounds like a wasp at the size
 * these play at; rolling the top off keeps the blips soft, which is the whole
 * point at a default volume of 0.12.
 */
function osc(freq, seconds, harmonics = [1]) {
  const n = Math.max(1, Math.round(seconds * SR));
  const out = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const t = i / SR;
    const f = typeof freq === "function" ? freq(t) : freq;
    let s = 0;
    for (let k = 0; k < harmonics.length; k++) {
      s += (1 / (k + 1)) * Math.sin(2 * Math.PI * f * (k + 1) * t);
    }
    out[i] = s;
  }
  return out;
}

/** One harmonic. */
const sine = (freq, seconds) => osc(freq, seconds, [1]);
/** Two: a little body without the buzz. */
const soft = (freq, seconds) => osc(freq, seconds, [1, 0.22, 0.08]);
/** Four: the hollow one, used where a tone needs to read as a body. */
const triangle = (freq, seconds) => osc(freq, seconds, [1, 0.36, 0.14, 0.06]);

function noise(seconds) {
  const n = Math.max(1, Math.round(seconds * SR));
  const out = new Float32Array(n);
  for (let i = 0; i < n; i++) out[i] = Math.random() * 2 - 1;
  return out;
}

// -- Shaping -------------------------------------------------------------------

/** Attack/decay envelope, in seconds. `curve` 2 = exponential, 1 = linear. */
function env(seconds, { attack = 0.004, curve = 2, hold = 0 } = {}) {
  const n = Math.max(1, Math.round(seconds * SR));
  const out = new Float32Array(n);
  const a = Math.max(1, Math.round(attack * SR));
  const h = Math.max(0, Math.round(hold * SR));
  const d = Math.max(1, n - a - h);
  for (let i = 0; i < n; i++) {
    let v;
    if (i < a) {
      v = i / a;
    } else if (i < a + h) {
      v = 1;
    } else {
      const p = (i - a - h) / d;
      v = curve === 1 ? 1 - p : (1 - p) ** curve;
    }
    out[i] = v;
  }
  return out;
}

/**
 * Multiplies by a per-sample envelope.
 *
 * Separate from `scale` on purpose. `sig[i] * envelope` would coerce the whole
 * envelope to a number, which calls `Float32Array.prototype.toString` and builds
 * a comma-joined string of every sample -- once per sample, so quadratic, and
 * minutes instead of milliseconds for a one-second sound. The silent NaN output
 * was the smaller half of that bug.
 */
function shape(sig, envelope) {
  const out = new Float32Array(sig.length);
  for (let i = 0; i < sig.length; i++) out[i] = sig[i] * envelope[i];
  return out;
}

/** Multiplies by a constant. `gain` must be a number, never an array. */
function scale(sig, gain) {
  const out = new Float32Array(sig.length);
  for (let i = 0; i < sig.length; i++) out[i] = sig[i] * gain;
  return out;
}

/** Sums buffers of different lengths, zero-padding to the longest. */
function mix(...parts) {
  const n = Math.max(...parts.map((p) => p.length));
  const out = new Float32Array(n);
  for (const p of parts) for (let i = 0; i < p.length; i++) out[i] += p[i];
  return out;
}

/** Places `sig` at `offset` seconds inside a buffer of `seconds`. */
function at(sig, seconds, offset) {
  const n = Math.max(1, Math.round(seconds * SR));
  const out = new Float32Array(n);
  const start = Math.round(offset * SR);
  for (let i = 0; i < sig.length; i++) {
    const j = start + i;
    if (j >= 0 && j < n) out[j] += sig[i];
  }
  return out;
}

/** Squashes the amplitude curve without touching the waveform much. */
function curve(sig, k) {
  const out = new Float32Array(sig.length);
  for (let i = 0; i < sig.length; i++) {
    out[i] = Math.sign(sig[i]) * Math.abs(sig[i]) ** k;
  }
  return out;
}

const lowpassSweep = (sig, from, to) => lowpass(sig, (t) => from + (to - from) * t);

// -- Recipes -------------------------------------------------------------------
//
// Grouped by what a sound is for, so one can be re-tuned by finding its kind
// rather than reading all 28.

// Navigation and interface. Short, dry, no tail.
const peek = () => shape(soft((t) => 520 + 180 * t, 0.075), env(0.075, { attack: 0.002, curve: 3 }));
const open = () =>
  mix(
    shape(soft((t) => 300 + 420 * t, 0.13), env(0.13, { attack: 0.003, curve: 2.4 })),
    shape(highpass(noise(0.05), 2600), env(0.05, { attack: 0.001, curve: 4 })),
  );
const close = () =>
  mix(
    shape(soft((t) => 640 - 280 * t, 0.12), env(0.12, { attack: 0.003, curve: 2.4 })),
    shape(highpass(noise(0.04), 2600), env(0.04, { attack: 0.001, curve: 4 })),
  );
const hover = () => shape(soft(880, 0.05), env(0.05, { attack: 0.002, curve: 3 }));
const blip = () => shape(soft((t) => 720 + 160 * t, 0.07), env(0.07, { attack: 0.002, curve: 2.6 }));

// Feedback. A consonant click plus a body, so it reads over the island's engine.
const tick = () => shape(highpass(noise(0.03), 3800), env(0.03, { attack: 0.0008, curve: 5 }));
const pop = () =>
  mix(
    shape(soft((t) => 420 + 900 * t, 0.055), env(0.055, { attack: 0.001, curve: 3 })),
    shape(highpass(noise(0.02), 4200), env(0.02, { attack: 0.0005, curve: 6 })),
  );
const gulp = () =>
  shape(
    lowpassSweep(triangle((t) => 150 + 90 * t, 0.2), 700, 240),
    env(0.2, { attack: 0.01, curve: 1.6 }),
  );
const slap = () =>
  mix(
    shape(noise(0.06), env(0.06, { attack: 0.0006, curve: 5 })),
    shape(lowpass(noise(0.12), (t) => 900 - 500 * t), env(0.12, { attack: 0.001, curve: 4 })),
  );

// Asking and answering. Distinct intervals, so they are told apart in a sequence.
const question = () =>
  mix(
    at(shape(soft(660, 0.11), env(0.11, { attack: 0.004, curve: 2.4 })), 0.28, 0),
    at(shape(soft(880, 0.16), env(0.16, { attack: 0.004, curve: 2.2 })), 0.28, 0.12),
  );
const approval = () =>
  mix(
    at(shape(soft(587.33, 0.1), env(0.1, { attack: 0.004, curve: 2.6 })), 0.32, 0),
    at(shape(soft(880, 0.22), env(0.22, { attack: 0.004, curve: 2.2 })), 0.32, 0.1),
  );
const approve = () =>
  mix(
    at(shape(soft(659.25, 0.09), env(0.09, { attack: 0.004, curve: 2.6 })), 0.34, 0),
    at(shape(soft(987.77, 0.24), env(0.24, { attack: 0.004, curve: 2 })), 0.34, 0.09),
  );

// Work. Long enough to be heard over the engine, with enough body to sit under it.
const work = () =>
  mix(
    at(shape(soft(392, 0.13), env(0.13, { attack: 0.006, curve: 2.6 })), 0.46, 0),
    at(shape(soft(523.25, 0.13), env(0.13, { attack: 0.006, curve: 2.6 })), 0.46, 0.11),
    at(shape(soft(659.25, 0.3), env(0.3, { attack: 0.006, curve: 2.2 })), 0.46, 0.22),
  );
const finish = () =>
  // A major triad, rolled: the "it worked" chord.
  [523.25, 659.25, 783.99].reduce((acc, f, i) => {
    const len = 0.42 - i * 0.04;
    const v = shape(soft(f, len), env(len, { attack: 0.005, curve: 2.2 }));
    return mix(acc, at(v, 0.62, i * 0.075));
  }, new Float32Array(0));
const error = () =>
  // Two descending steps with a buzz under them; deliberately not harsh, since
  // the island shows the message too.
  mix(
    at(shape(curve(triangle(233.08, 0.16), 1.6), env(0.16, { attack: 0.005, curve: 1.8 })), 0.4, 0),
    at(shape(curve(triangle(174.61, 0.34), 1.6), env(0.34, { attack: 0.005, curve: 1.6 })), 0.4, 0.14),
  );
const send = () => shape(soft((t) => 500 + 700 * t, 0.16), env(0.16, { attack: 0.004, curve: 2.2 }));
const search = () =>
  mix(
    at(shape(highpass(noise(0.05), 3000), env(0.05, { attack: 0.001, curve: 4 })), 0.3, 0),
    at(shape(highpass(noise(0.05), 3400), env(0.05, { attack: 0.001, curve: 4 })), 0.3, 0.13),
  );
const think = () => {
  // A held tone with a slow wobble: the "hmm" of the room.
  const base = soft((t) => 300 + 26 * Math.sin(2 * Math.PI * 5.5 * t), 0.5);
  return shape(lowpassSweep(base, 1200, 600), env(0.5, { attack: 0.05, curve: 1.2 }));
};
const attach = () =>
  mix(
    at(shape(soft(440, 0.09), env(0.09, { attack: 0.003, curve: 2.8 })), 0.3, 0),
    at(shape(soft(659.25, 0.2), env(0.2, { attack: 0.003, curve: 2.4 })), 0.3, 0.09),
  );

// Character. The expressive set: longer, more shaped.
const greet = () =>
  mix(
    at(shape(soft((t) => 392 + 160 * t, 0.16), env(0.16, { attack: 0.01, curve: 2 })), 0.5, 0),
    at(shape(soft(659.25, 0.3), env(0.3, { attack: 0.01, curve: 1.8 })), 0.5, 0.14),
  );
const love = () =>
  // A slow major sixth, opening: warm rather than sweet.
  mix(
    at(shape(soft(440, 0.34), env(0.34, { attack: 0.06, curve: 1.4 })), 0.62, 0),
    at(shape(soft(659.25, 0.52), env(0.52, { attack: 0.09, curve: 1.3 })), 0.62, 0.1),
  );
const proud = () =>
  mix(
    at(shape(soft(587.33, 0.12), env(0.12, { attack: 0.004, curve: 2.6 })), 0.48, 0),
    at(shape(soft(739.99, 0.12), env(0.12, { attack: 0.004, curve: 2.6 })), 0.48, 0.1),
    at(shape(soft(987.77, 0.34), env(0.34, { attack: 0.004, curve: 2 })), 0.48, 0.2),
  );
const wink = () =>
  mix(
    at(shape(soft((t) => 700 + 500 * t, 0.1), env(0.1, { attack: 0.003, curve: 3 })), 0.24, 0),
    at(shape(soft(1600, 0.12), env(0.12, { attack: 0.003, curve: 3.2 })), 0.24, 0.09),
  );
const yawn = () => {
  // Noise under a falling formant, with a slow attack. A yawn is mostly its onset:
  // a plain envelope reads as a hiccup.
  const voice = soft((t) => 260 - 130 * t, 0.85);
  const breath = scale(lowpassSweep(noise(0.85), 1400, 500), 0.35);
  return shape(
    lowpassSweep(mix(scale(voice, 0.8), breath), 1800, 700),
    env(0.85, { attack: 0.22, curve: 1.2 }),
  );
};
const sleep = () =>
  mix(
    at(shape(soft(329.63, 0.5), env(0.5, { attack: 0.12, curve: 1.1 })), 1.0, 0),
    at(shape(soft(246.94, 0.8), env(0.8, { attack: 0.18, curve: 1 })), 1.0, 0.18),
  );
const rate = () =>
  mix(
    at(shape(soft(880, 0.07), env(0.07, { attack: 0.002, curve: 3 })), 0.28, 0),
    at(shape(soft(1318.5, 0.2), env(0.2, { attack: 0.003, curve: 2.4 })), 0.28, 0.08),
  );
const annoyed = () =>
  // Two clipped tones a semitone apart: irritation without a buzzer.
  mix(
    at(shape(curve(soft(220, 0.13), 1.4), env(0.13, { attack: 0.004, curve: 2 })), 0.26, 0),
    at(shape(curve(soft(233.08, 0.2), 1.4), env(0.2, { attack: 0.004, curve: 1.8 })), 0.26, 0.1),
  );
const dizzy = () => {
  // A wobbling tone that sags at the end, like something settling.
  const wobble = soft((t) => 520 + 90 * Math.sin(2 * Math.PI * 7 * t) - 120 * t, 0.6);
  return shape(lowpassSweep(wobble, 2400, 900), env(0.6, { attack: 0.01, curve: 1.4 }));
};

const RECIPES = {
  peek, open, close, hover, blip, slap, annoyed, dizzy, greet,
  work, finish, error, approval, question, approve, gulp, tick,
  send, love, pop, proud, wink, yawn, attach, think, search,
  rate, sleep,
};

// -- WAV writer -----------------------------------------------------------------

/** Peak-normalises, then fades the last few ms so nothing clicks on stop. */
function finalize(sig, targetPeak = 0.72) {
  let peak = 0;
  for (let i = 0; i < sig.length; i++) peak = Math.max(peak, Math.abs(sig[i]));
  const g = peak > 0 ? targetPeak / peak : 1;
  const out = new Float32Array(sig.length);
  for (let i = 0; i < sig.length; i++) out[i] = sig[i] * g;
  const fade = Math.min(Math.round(0.006 * SR), Math.floor(out.length / 2));
  for (let i = 0; i < fade; i++) out[out.length - fade + i] *= 1 - i / fade;
  return out;
}

function wav(samples) {
  const n = samples.length;
  const data = n * 2;
  const buf = Buffer.alloc(44 + data);
  buf.write("RIFF", 0);
  buf.writeUInt32LE(36 + data, 4);
  buf.write("WAVE", 8);
  buf.write("fmt ", 12);
  buf.writeUInt32LE(16, 16); // fmt chunk size
  buf.writeUInt16LE(1, 20); // PCM
  buf.writeUInt16LE(1, 22); // mono
  buf.writeUInt32LE(SR, 24);
  buf.writeUInt32LE(SR * (BITS / 8), 28); // byte rate
  buf.writeUInt16LE(BITS / 8, 32); // block align
  buf.writeUInt16LE(BITS, 34);
  buf.write("data", 36);
  buf.writeUInt32LE(data, 40);
  for (let i = 0; i < n; i++) {
    const v = Math.max(-1, Math.min(1, samples[i]));
    buf.writeInt16LE(Math.round(v * 32767), 44 + i * 2);
  }
  return buf;
}

// -- Main -----------------------------------------------------------------------

// Read out of the player, so a renamed sound is a loud failure here rather than
// silence in the app. Parsed rather than imported: sound.ts is TypeScript and this
// script is run by plain node.
const player = readFileSync(join(root, "src/core/sound.ts"), "utf8");
const block = player.match(/SOUND_NAMES\s*=\s*\[([\s\S]*?)\]/);
const names = [...(block?.[1] ?? "").matchAll(/"([^"]+)"/g)].map((m) => m[1]);
if (names.length === 0) {
  console.error("could not read SOUND_NAMES out of src/core/sound.ts");
  process.exit(1);
}

const missing = names.filter((n) => typeof RECIPES[n] !== "function");
if (missing.length) {
  console.error(`no recipe for: ${missing.join(", ")}`);
  process.exit(1);
}
const unused = Object.keys(RECIPES).filter((n) => !names.includes(n));
if (unused.length) console.warn(`unused recipes: ${unused.join(", ")}`);

mkdirSync(OUT_DIR, { recursive: true });
let total = 0;
for (const name of names) {
  const sig = finalize(RECIPES[name]());
  writeFileSync(join(OUT_DIR, `${name}.wav`), wav(sig));
  total += sig.length;
  console.log(`${name.padEnd(10)} ${(sig.length / SR).toFixed(2)}s`);
}
console.log(`\n${names.length} sounds -> ${OUT_DIR}  (${(total / SR).toFixed(1)}s of audio)`);