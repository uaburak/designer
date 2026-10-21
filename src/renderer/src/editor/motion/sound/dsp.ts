/**
 * The local sound engine's building blocks (docs/motion.md §9.3; [ours]): a small deterministic synthesiser in plain
 * TypeScript — no Web Audio, so the same recipe gives the same samples in the view, in a worker and in node's tests.
 * Mono signals are Float32Arrays at `SR`; a sound is stereo `Pcm`. Oscillators (polyBLEP saw / square, sine, triangle,
 * per-sample frequency), coloured noise from a seeded generator, envelopes, a TPT state-variable filter with a moving
 * cutoff, equal-power panning, a ping-pong delay, Freeverb, a soft limiter and normalisation.
 */

/** The synth's rate (the export's mix rate, audio.ts MIX_SAMPLE_RATE). */
export const SR = 48_000;

export interface Pcm {
  sampleRate: number;
  channels: [Float32Array, Float32Array];
}

/** A curve over a signal: a constant, or one value per sample. */
export type Curve = number | Float32Array;
const at = (c: Curve, i: number) => (typeof c === "number" ? c : c[i]);

export const samples = (seconds: number) => Math.max(1, Math.round(seconds * SR));
/** A time as a sample offset (0 at 0). */
export const sampleAt = (seconds: number) => Math.max(0, Math.round(seconds * SR));
export const dbToGain = (db: number) => Math.pow(10, db / 20);
export const gainToDb = (g: number) => (g > 1e-9 ? 20 * Math.log10(g) : -180);

/** mulberry32: a seeded generator — the same seed, the same sound. */
export class Rng {
  private s: number;
  constructor(seed: number) {
    this.s = seed >>> 0 || 0x9e3779b9;
  }
  /** [0, 1) */
  next(): number {
    let t = (this.s = (this.s + 0x6d2b79f5) >>> 0);
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  }
  /** [-1, 1) */
  bi(): number {
    return this.next() * 2 - 1;
  }
  range(a: number, b: number): number {
    return a + (b - a) * this.next();
  }
  pick<T>(list: readonly T[]): T {
    return list[Math.floor(this.next() * list.length) % list.length];
  }
}

// ---- Notes and keys -----------------------------------------------------------------------------------------------

const NOTE_INDEX: Record<string, number> = { C: 0, D: 2, E: 4, F: 5, G: 7, A: 9, B: 11 };

/** "A4", "C#5", "Eb3" → MIDI (A4 = 69); a number passes. NaN when unreadable. */
export function midiOf(note: string | number): number {
  if (typeof note === "number") return note;
  const m = /^\s*([A-Ga-g])([#b♯♭]?)(-?\d)?\s*$/.exec(note);
  if (!m) return NaN;
  const base = NOTE_INDEX[m[1].toUpperCase()] + (m[2] === "#" || m[2] === "♯" ? 1 : m[2] === "b" || m[2] === "♭" ? -1 : 0);
  return base + 12 * ((m[3] !== undefined ? Number(m[3]) : 4) + 1);
}
export const hzOf = (midi: number) => 440 * Math.pow(2, (midi - 69) / 12);

const MODES: Record<string, readonly number[]> = {
  major: [0, 2, 4, 5, 7, 9, 11],
  minor: [0, 2, 3, 5, 7, 8, 10],
  dorian: [0, 2, 3, 5, 7, 9, 10],
  mixolydian: [0, 2, 4, 5, 7, 9, 10],
  lydian: [0, 2, 4, 6, 7, 9, 11],
  phrygian: [0, 1, 3, 5, 7, 8, 10],
  harmonicminor: [0, 2, 3, 5, 7, 8, 11],
};
export type ModeName = keyof typeof MODES;

export interface Key {
  /** The tonic's pitch class (0 = C) */
  root: number;
  mode: ModeName;
  scale: readonly number[];
}

/** "C", "Am", "F# minor", "Eb major", "D dorian" → a key (default C major). */
export function keyOf(spec: string | undefined, fallbackMode: ModeName = "major"): Key {
  const m = /^\s*([A-Ga-g])([#b♯♭]?)\s*(m(?![a-z])|maj(?:or)?|min(?:or)?|dorian|mixolydian|lydian|phrygian|harmonic\s*minor)?\s*$/i.exec(spec ?? "");
  if (!m) return { root: 0, mode: fallbackMode, scale: MODES[fallbackMode] };
  const root = (((NOTE_INDEX[m[1].toUpperCase()] + (m[2] === "#" || m[2] === "♯" ? 1 : m[2] === "b" || m[2] === "♭" ? -1 : 0)) % 12) + 12) % 12;
  const w = (m[3] ?? "").toLowerCase().replace(/\s+/g, "");
  const mode: ModeName = w === "m" || w.startsWith("min") ? "minor" : w.startsWith("maj") ? "major" : w in MODES ? (w as ModeName) : fallbackMode;
  return { root, mode, scale: MODES[mode] };
}

/** The MIDI note of scale degree `degree` (0-based, may run past 7 into the next octaves) from octave `octave`. */
export function degreeMidi(key: Key, degree: number, octave: number): number {
  const n = key.scale.length;
  const oct = Math.floor(degree / n);
  const d = ((degree % n) + n) % n;
  return 12 * (octave + 1 + oct) + key.root + key.scale[d];
}

/** A chord on scale degree `degree` (0-based): stacked thirds of the scale, `size` notes. */
export function chordMidi(key: Key, degree: number, octave: number, size = 3): number[] {
  return Array.from({ length: size }, (_, i) => degreeMidi(key, degree + 2 * i, octave));
}

// ---- Signals ------------------------------------------------------------------------------------------------------

export type Wave = "sine" | "saw" | "square" | "triangle";

const polyBlep = (t: number, dt: number) => {
  if (t < dt) {
    const x = t / dt;
    return x + x - x * x - 1;
  }
  if (t > 1 - dt) {
    const x = (t - 1) / dt;
    return x * x + x + x + 1;
  }
  return 0;
};

/** An oscillator at `freq` Hz (per sample allowed) from `phase` (0–1). */
export function osc(wave: Wave, freq: Curve, length: number, phase = 0): Float32Array {
  const out = new Float32Array(length);
  let p = phase % 1;
  let tri = 0;
  for (let i = 0; i < length; i++) {
    const dt = Math.min(0.5, Math.max(0, at(freq, i)) / SR);
    let v: number;
    switch (wave) {
      case "sine":
        v = Math.sin(2 * Math.PI * p);
        break;
      case "saw":
        v = 2 * p - 1 - polyBlep(p, dt);
        break;
      case "square":
        v = (p < 0.5 ? 1 : -1) + polyBlep(p, dt) - polyBlep((p + 0.5) % 1, dt);
        break;
      default: {
        // Integrated band-limited square.
        const sq = (p < 0.5 ? 1 : -1) + polyBlep(p, dt) - polyBlep((p + 0.5) % 1, dt);
        tri = dt * sq * 4 + (1 - dt * 0.5) * tri;
        v = tri;
      }
    }
    out[i] = v;
    p += dt;
    if (p >= 1) p -= 1;
  }
  return out;
}

/** FM: a sine carrier at `freq` modulated by a sine at `freq × ratio` with index `index` (per sample allowed). */
export function fm(freq: Curve, ratio: number, index: Curve, length: number): Float32Array {
  const out = new Float32Array(length);
  let pc = 0;
  let pm = 0;
  for (let i = 0; i < length; i++) {
    const f = at(freq, i);
    const mod = Math.sin(2 * Math.PI * pm) * at(index, i);
    out[i] = Math.sin(2 * Math.PI * pc + mod);
    pc += f / SR;
    pm += (f * ratio) / SR;
    if (pc >= 1) pc -= 1;
    if (pm >= 1) pm -= 1;
  }
  return out;
}

export type NoiseColor = "white" | "pink" | "brown";

/** Noise of a colour, from `rng`. */
export function noise(length: number, rng: Rng, color: NoiseColor = "white"): Float32Array {
  const out = new Float32Array(length);
  let b0 = 0, b1 = 0, b2 = 0, b3 = 0, b4 = 0, b5 = 0, b6 = 0, last = 0;
  for (let i = 0; i < length; i++) {
    const w = rng.bi();
    if (color === "white") out[i] = w;
    else if (color === "pink") {
      // Paul Kellet's filter.
      b0 = 0.99886 * b0 + w * 0.0555179;
      b1 = 0.99332 * b1 + w * 0.0750759;
      b2 = 0.969 * b2 + w * 0.153852;
      b3 = 0.8665 * b3 + w * 0.3104856;
      b4 = 0.55 * b4 + w * 0.5329522;
      b5 = -0.7616 * b5 - w * 0.016898;
      out[i] = (b0 + b1 + b2 + b3 + b4 + b5 + b6 + w * 0.5362) * 0.11;
      b6 = w * 0.115926;
    } else {
      last = (last + 0.02 * w) / 1.02;
      out[i] = last * 3.5;
    }
  }
  return out;
}

// ---- Envelopes and curves -----------------------------------------------------------------------------------------

/** A curve through points [time (s), value] with a shape per segment (1 linear, > 1 slow start, < 1 fast start). */
export function curve(length: number, points: readonly (readonly [number, number, number?])[]): Float32Array {
  const out = new Float32Array(length);
  if (!points.length) return out;
  let k = 0;
  for (let i = 0; i < length; i++) {
    const t = i / SR;
    while (k < points.length - 1 && t > points[k + 1][0]) k++;
    const [t0, v0] = points[k];
    if (t <= points[0][0]) {
      out[i] = points[0][1];
      continue;
    }
    if (k >= points.length - 1) {
      out[i] = points[points.length - 1][1];
      continue;
    }
    const [t1, v1, shape = 1] = points[k + 1];
    const x = t1 > t0 ? (t - t0) / (t1 - t0) : 1;
    out[i] = v0 + (v1 - v0) * Math.pow(x, shape);
  }
  return out;
}

/** An exponential frequency sweep from `a` to `b` Hz over the signal (a riser's, a pitch drop's). */
export function sweep(length: number, a: number, b: number, shape = 1): Float32Array {
  const out = new Float32Array(length);
  const la = Math.log(Math.max(1, a));
  const lb = Math.log(Math.max(1, b));
  for (let i = 0; i < length; i++) out[i] = Math.exp(la + (lb - la) * Math.pow(i / Math.max(1, length - 1), shape));
  return out;
}

/** Attack (linear) then an exponential decay to −60 dB over `decay` s. */
export function hitEnv(length: number, attack: number, decay: number): Float32Array {
  const out = new Float32Array(length);
  const a = Math.max(1, Math.round(attack * SR));
  const k = Math.log(1000) / Math.max(1e-4, decay);
  for (let i = 0; i < length; i++) out[i] = i < a ? i / a : Math.exp(-k * ((i - a) / SR));
  return out;
}

/** Attack, decay to sustain, held, released over the last `release` s (ADSR fitted to the length). */
export function adsr(length: number, attack: number, decay: number, sustain: number, release: number): Float32Array {
  const d = length / SR;
  const r = Math.min(release, d * 0.9);
  return curve(length, [
    [0, 0],
    [Math.min(attack, d - r), 1],
    [Math.min(attack + decay, d - r), sustain],
    [d - r, sustain],
    [d, 0],
  ]);
}

export function mul(a: Float32Array, b: Curve): Float32Array {
  for (let i = 0; i < a.length; i++) a[i] *= at(b, i);
  return a;
}
export function add(dst: Float32Array, src: Float32Array, offset = 0, gain = 1): Float32Array {
  const n = Math.min(src.length, dst.length - offset);
  for (let i = Math.max(0, -offset); i < n; i++) dst[i + offset] += src[i] * gain;
  return dst;
}

// ---- Filters ------------------------------------------------------------------------------------------------------

export type FilterMode = "lowpass" | "highpass" | "bandpass" | "notch";

/** A TPT state-variable filter (Simper's), cutoff (Hz) per sample allowed, coefficients every 8 samples. */
export function svf(input: Float32Array, mode: FilterMode, cutoff: Curve, q = 0.707): Float32Array {
  const out = new Float32Array(input.length);
  const k = 1 / Math.max(0.05, q);
  let ic1 = 0, ic2 = 0, a1 = 0, a2 = 0, a3 = 0;
  for (let i = 0; i < input.length; i++) {
    if ((i & 7) === 0) {
      const fc = Math.min(SR * 0.45, Math.max(10, at(cutoff, i)));
      const g = Math.tan((Math.PI * fc) / SR);
      a1 = 1 / (1 + g * (g + k));
      a2 = g * a1;
      a3 = g * a2;
    }
    const v0 = input[i];
    const v3 = v0 - ic2;
    const v1 = a1 * ic1 + a2 * v3;
    const v2 = ic2 + a2 * ic1 + a3 * v3;
    ic1 = 2 * v1 - ic1;
    ic2 = 2 * v2 - ic2;
    out[i] = mode === "lowpass" ? v2 : mode === "bandpass" ? v1 : mode === "highpass" ? v0 - k * v1 - v2 : v0 - k * v1;
  }
  return out;
}

/** Soft saturation (tanh) by `drive` ≥ 0, level kept for small signals. */
export function drive(input: Float32Array, amount: number): Float32Array {
  if (amount <= 0) return input;
  const g = 1 + amount * 6;
  const n = Math.tanh(g);
  for (let i = 0; i < input.length; i++) input[i] = Math.tanh(input[i] * g) / n;
  return input;
}

/** Bit depth and sample-rate reduction (glitch / lo-fi). */
export function crush(input: Float32Array, bits: number, hold: number): Float32Array {
  const q = Math.pow(2, Math.max(1, bits) - 1);
  let v = 0;
  const h = Math.max(1, Math.round(hold));
  for (let i = 0; i < input.length; i++) {
    if (i % h === 0) v = Math.round(input[i] * q) / q;
    input[i] = v;
  }
  return input;
}

// ---- Stereo -------------------------------------------------------------------------------------------------------

export const stereo = (length: number): Pcm => ({ sampleRate: SR, channels: [new Float32Array(length), new Float32Array(length)] });
export const lengthOf = (p: Pcm) => p.channels[0].length;

/** A mono signal placed in stereo at `pan` (−1 left … 1 right, per sample allowed; equal power), added at `offset`. */
export function panInto(dst: Pcm, mono: Float32Array, pan: Curve = 0, offset = 0, gain = 1): Pcm {
  const [l, r] = dst.channels;
  const n = Math.min(mono.length, l.length - offset);
  for (let i = Math.max(0, -offset); i < n; i++) {
    const p = Math.max(-1, Math.min(1, at(pan, i)));
    const a = ((p + 1) * Math.PI) / 4;
    l[i + offset] += mono[i] * Math.cos(a) * gain * Math.SQRT2;
    r[i + offset] += mono[i] * Math.sin(a) * gain * Math.SQRT2;
  }
  return dst;
}

/** `src` added into `dst` at `offset` samples. */
export function mixInto(dst: Pcm, src: Pcm, offset = 0, gain = 1): Pcm {
  add(dst.channels[0], src.channels[0], offset, gain);
  add(dst.channels[1], src.channels[1], offset, gain);
  return dst;
}

/** A stereo ping-pong delay: `time` s, `feedback` 0–0.9, `mix` 0–1 (wet added). */
export function delay(p: Pcm, time: number, feedback: number, mix: number): Pcm {
  if (mix <= 0) return p;
  const d = Math.max(1, Math.round(time * SR));
  const [l, r] = p.channels;
  const bl = new Float32Array(d);
  const br = new Float32Array(d);
  const fb = Math.min(0.9, Math.max(0, feedback));
  let lp1 = 0, lp2 = 0;
  for (let i = 0; i < l.length; i++) {
    const j = i % d;
    const dl = bl[j];
    const dr = br[j];
    // A gentle low-pass in the loop: repeats darken.
    lp1 += 0.35 * (dl - lp1);
    lp2 += 0.35 * (dr - lp2);
    bl[j] = l[i] + lp2 * fb;
    br[j] = lp1 * fb;
    l[i] += lp1 * mix;
    r[i] += lp2 * mix;
  }
  return p;
}

const COMBS = [1116, 1188, 1277, 1356, 1422, 1491, 1557, 1617];
const ALLPASSES = [556, 441, 341, 225];

/** Freeverb (Jezar's), the wet added: `mix` 0–1, `size` 0–1 (room), `damp` 0–1, the tunings scaled to 48 kHz. */
export function reverb(p: Pcm, mix: number, size = 0.7, damp = 0.4): Pcm {
  if (mix <= 0) return p;
  const scale = SR / 44_100;
  const room = 0.7 + 0.28 * Math.min(1, Math.max(0, size));
  const dmp = Math.min(1, Math.max(0, damp)) * 0.4;
  const wet = [new Float32Array(lengthOf(p)), new Float32Array(lengthOf(p))];
  for (let ch = 0; ch < 2; ch++) {
    const spread = ch ? 23 : 0;
    const input = p.channels[0].map((v, i) => (v + p.channels[1][i]) * 0.015);
    const acc = wet[ch];
    for (const c of COMBS) {
      const len = Math.round((c + spread) * scale);
      const buf = new Float32Array(len);
      let idx = 0, store = 0;
      for (let i = 0; i < input.length; i++) {
        const o = buf[idx];
        store = o * (1 - dmp) + store * dmp;
        buf[idx] = input[i] + store * room;
        acc[i] += o;
        if (++idx >= len) idx = 0;
      }
    }
    for (const a of ALLPASSES) {
      const len = Math.round((a + spread) * scale);
      const buf = new Float32Array(len);
      let idx = 0;
      for (let i = 0; i < acc.length; i++) {
        const b = buf[idx];
        const x = acc[i];
        buf[idx] = x + b * 0.5;
        acc[i] = b - x;
        if (++idx >= len) idx = 0;
      }
    }
  }
  const g = mix * 3;
  for (let ch = 0; ch < 2; ch++) add(p.channels[ch], wet[ch], 0, g);
  return p;
}

/** The sound padded with `seconds` of silence (room for a tail). */
export function pad(p: Pcm, seconds: number): Pcm {
  const out = stereo(lengthOf(p) + samples(seconds));
  return mixInto(out, p);
}

/** The first `length` samples. */
export function cut(p: Pcm, length: number): Pcm {
  return { sampleRate: p.sampleRate, channels: [p.channels[0].slice(0, length), p.channels[1].slice(0, length)] };
}

/** Linear fades in / out (s). */
export function fade(p: Pcm, fadeIn: number, fadeOut: number): Pcm {
  const n = lengthOf(p);
  const a = Math.min(n, Math.round(fadeIn * SR));
  const b = Math.min(n, Math.round(fadeOut * SR));
  for (const ch of p.channels) {
    for (let i = 0; i < a; i++) ch[i] *= i / a;
    for (let i = 0; i < b; i++) ch[n - 1 - i] *= i / b;
  }
  return p;
}

/** A one-pole high-pass at 20 Hz on both channels (no DC offset). */
export function dcBlock(p: Pcm): Pcm {
  const r = 1 - (2 * Math.PI * 20) / SR;
  for (const ch of p.channels) {
    let x1 = 0, y1 = 0;
    for (let i = 0; i < ch.length; i++) {
      const y = ch[i] - x1 + r * y1;
      x1 = ch[i];
      ch[i] = y1 = y;
    }
  }
  return p;
}

export function peakOf(p: Pcm): number {
  let m = 0;
  for (const ch of p.channels) for (let i = 0; i < ch.length; i++) m = Math.max(m, Math.abs(ch[i]));
  return m;
}

/** Scaled so its peak is `peakDb` dBFS (silence stays silent). */
export function normalize(p: Pcm, peakDb = -1): Pcm {
  const m = peakOf(p);
  if (m < 1e-9) return p;
  const g = dbToGain(peakDb) / m;
  for (const ch of p.channels) for (let i = 0; i < ch.length; i++) ch[i] *= g;
  return p;
}

/** Trailing near-silence (below −70 dB of the peak) cut off, a short fade kept at the end. */
export function trimTail(p: Pcm, minSeconds = 0): Pcm {
  const thr = peakOf(p) * dbToGain(-70);
  const n = lengthOf(p);
  let end = n;
  while (end > samples(minSeconds) && Math.abs(p.channels[0][end - 1]) < thr && Math.abs(p.channels[1][end - 1]) < thr) end--;
  return end >= n ? p : fade(cut(p, Math.min(n, end + samples(0.01))), 0, 0.01);
}
