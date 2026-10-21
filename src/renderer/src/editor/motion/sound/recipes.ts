/**
 * Sound recipes (docs/motion.md §9.3; [ours]): what an agent asks `generate_sound` for — a type (or a preset) and a few
 * musical / sound-design parameters — rendered by the local synthesiser (dsp.ts) into stereo PCM at 48 kHz. Every
 * recipe has a **sync point** (`sync`, seconds into the sound): the moment the ear takes as "the hit" — a whoosh's peak,
 * a riser's end, an impact's transient — which generate_sound puts on the timeline time it is given. Deterministic: the
 * same recipe and seed give the same samples. Levels: every sound is normalised to −1 dBFS peak; the mix level is the
 * clip's volume (`FAMILY_DB`).
 */
import {
  adsr,
  add,
  chordMidi,
  crush,
  curve,
  cut,
  dcBlock,
  degreeMidi,
  delay,
  drive,
  fade,
  fm,
  hitEnv,
  hzOf,
  keyOf,
  lengthOf,
  midiOf,
  mixInto,
  mul,
  noise,
  normalize,
  osc,
  pad,
  panInto,
  reverb,
  Rng,
  sampleAt,
  samples,
  SR,
  stereo,
  svf,
  sweep,
  trimTail,
  dbToGain,
  type Key,
  type Pcm,
} from "./dsp";

export const SOUND_TYPES = [
  "click",
  "tap",
  "pop",
  "tick",
  "typing",
  "whoosh",
  "swoosh",
  "riser",
  "downlifter",
  "impact",
  "thud",
  "boom",
  "shimmer",
  "sparkle",
  "chime",
  "notification",
  "glitch",
  "pad",
  "swell",
  "drone",
  "beat",
  "music",
  "stack",
] as const;
export type SoundType = (typeof SOUND_TYPES)[number];

export const MOODS = ["uplifting", "corporate", "calm", "dreamy", "tense", "dark", "epic", "playful", "lofi"] as const;
export type Mood = (typeof MOODS)[number];

export const MOTIFS = ["up", "down", "success", "error", "alert", "coin", "message"] as const;
export type Motif = (typeof MOTIFS)[number];

/** What generate_sound takes per sound (every field optional; a preset fills the rest). */
export interface SoundRecipe {
  type?: SoundType;
  preset?: string;
  /** The body's length (s); tails of reverb / delay come after */
  duration?: number;
  seed?: number;
  /** Hz or a note ("C5") */
  pitch?: number | string;
  /** "C", "Am", "F# minor", "D dorian" */
  key?: string;
  mood?: Mood;
  bpm?: number;
  /** 0–1: filters' openness, octaves */
  brightness?: number;
  /** 0–1: drive, density, punch */
  intensity?: number;
  /** −1 … 1 at the start, and at the end (movement) */
  pan?: number;
  panTo?: number;
  /** 0–1: stereo spread of scattered elements */
  width?: number;
  /** 0–1 wet amounts */
  reverb?: number;
  delay?: number;
  /** Seconds, or a note value at bpm: "1/8", "3/16" */
  delayTime?: number | string;
  attack?: number;
  release?: number;
  /** typing / tick: how many, how far apart (s), or exact times (s from the sound's start) */
  count?: number;
  interval?: number;
  times?: number[];
  /** chime / notification: notes ("C5", MIDI) or a motif */
  notes?: (string | number)[];
  motif?: Motif;
  /** beat: a preset name or 16-step rows per voice ("x...x...", X accent, o open hat) */
  pattern?: string | { kick?: string; snare?: string; clap?: string; hat?: string };
  swing?: number;
  bars?: number;
  /** music / pad: scale degrees (1 = tonic) or roman numerals ("I", "vi", "IV") */
  progression?: (number | string)[];
  /** music: which parts play (default by mood) */
  parts?: { pad?: boolean; bass?: boolean; arp?: boolean; drums?: boolean };
  fadeIn?: number;
  fadeOut?: number;
  /** music / beat / drone / pad: the end wraps into the start (a looping timeline) */
  loop?: boolean;
  /** Where the sound's moment is (s into it), overriding the type's */
  syncAt?: number;
  /** stack: sounds layered, each at `at` s with `gainDb` */
  layers?: (SoundRecipe & { at?: number; gainDb?: number })[];
}

export type SoundFamily = "ui" | "move" | "build" | "hit" | "magic" | "notify" | "glitch" | "ambience" | "beat" | "music";

/** The family's default mix level (the clip's volume, dB): beds low, hits forward. */
export const FAMILY_DB: Record<SoundFamily, number> = { ui: -10, move: -9, build: -10, hit: -6, magic: -12, notify: -8, glitch: -10, ambience: -18, beat: -14, music: -18 };

const FAMILY: Record<SoundType, SoundFamily> = {
  click: "ui", tap: "ui", pop: "ui", tick: "ui", typing: "ui",
  whoosh: "move", swoosh: "move",
  riser: "build", downlifter: "build",
  impact: "hit", thud: "hit", boom: "hit",
  shimmer: "magic", sparkle: "magic",
  chime: "notify", notification: "notify",
  glitch: "glitch",
  pad: "ambience", swell: "build", drone: "ambience",
  beat: "beat", music: "music", stack: "hit",
};

/** Named starting points: a type and its parameters (explicit fields win). */
export const SOUND_PRESETS: Record<string, SoundRecipe & { type: SoundType }> = {
  // UI
  click: { type: "click" },
  "click.soft": { type: "click", brightness: 0.25, intensity: 0.3, duration: 0.04 },
  "click.mechanical": { type: "click", brightness: 0.8, intensity: 0.8, duration: 0.025 },
  tap: { type: "tap" },
  "tap.wood": { type: "tap", pitch: 900, brightness: 0.6, intensity: 0.7 },
  pop: { type: "pop" },
  "pop.bubble": { type: "pop", pitch: 520, duration: 0.09, brightness: 0.6 },
  "pop.deep": { type: "pop", pitch: 220, duration: 0.16, brightness: 0.3 },
  toggle: { type: "click", pitch: 1400, duration: 0.05, brightness: 0.5 },
  tick: { type: "tick" },
  typing: { type: "typing" },
  "typing.fast": { type: "typing", interval: 0.045, brightness: 0.6 },
  // Moves
  whoosh: { type: "whoosh" },
  "whoosh.fast": { type: "whoosh", duration: 0.45, brightness: 0.65 },
  "whoosh.long": { type: "whoosh", duration: 1.4, brightness: 0.45, reverb: 0.2 },
  "whoosh.heavy": { type: "whoosh", duration: 0.9, brightness: 0.3, intensity: 0.9 },
  swoosh: { type: "swoosh" },
  "swish.air": { type: "swoosh", duration: 0.25, brightness: 0.85, intensity: 0.4 },
  "pass-by": { type: "whoosh", duration: 1.1, pan: -0.9, panTo: 0.9, brightness: 0.55 },
  // Builds
  riser: { type: "riser" },
  "riser.tension": { type: "riser", duration: 3, brightness: 0.4, intensity: 0.8 },
  "riser.short": { type: "riser", duration: 1, brightness: 0.7 },
  downlifter: { type: "downlifter" },
  "reverse-swell": { type: "swell", duration: 1.5, brightness: 0.6 },
  swell: { type: "swell" },
  // Hits
  impact: { type: "impact" },
  "impact.cinematic": { type: "impact", duration: 2.5, intensity: 0.9, reverb: 0.5, brightness: 0.35 },
  "hit.punch": { type: "impact", duration: 0.6, intensity: 0.8, reverb: 0.12, brightness: 0.6 },
  "logo-hit": { type: "stack", layers: [{ type: "impact", duration: 1.8, reverb: 0.4 }, { type: "shimmer", duration: 1.6, at: 0.02, gainDb: -8 }] },
  thud: { type: "thud" },
  boom: { type: "boom" },
  // Magic
  shimmer: { type: "shimmer" },
  sparkle: { type: "sparkle" },
  glint: { type: "sparkle", duration: 0.35, intensity: 0.3, brightness: 0.9 },
  magic: { type: "shimmer", duration: 2, intensity: 0.8, reverb: 0.6 },
  // Notifications
  chime: { type: "chime" },
  "chime.success": { type: "chime", motif: "success" },
  notification: { type: "notification" },
  message: { type: "notification", motif: "message" },
  error: { type: "notification", motif: "error" },
  alert: { type: "notification", motif: "alert" },
  coin: { type: "notification", motif: "coin" },
  // Glitch
  glitch: { type: "glitch" },
  "glitch.digital": { type: "glitch", duration: 0.8, intensity: 0.9, brightness: 0.8 },
  // Ambience
  pad: { type: "pad" },
  drone: { type: "drone" },
  // Beats
  "beat.four-on-floor": { type: "beat", pattern: "four-on-floor", bpm: 120 },
  "beat.hiphop": { type: "beat", pattern: "hiphop", bpm: 90, swing: 0.2 },
  "beat.halftime": { type: "beat", pattern: "halftime", bpm: 140 },
  "beat.breakbeat": { type: "beat", pattern: "breakbeat", bpm: 130 },
  "beat.minimal": { type: "beat", pattern: "minimal", bpm: 118 },
  // Music beds
  ...Object.fromEntries(MOODS.map((m) => [`music.${m}`, { type: "music" as const, mood: m }])),
};

// ---- Resolution ---------------------------------------------------------------------------------------------------

export class RecipeError extends Error {}

const clamp01 = (v: unknown, d: number) => (typeof v === "number" && Number.isFinite(v) ? Math.min(1, Math.max(0, v)) : d);
const lerp = (a: number, b: number, t: number) => a + (b - a) * t;
const lerpExp = (a: number, b: number, t: number) => a * Math.pow(b / a, t);

/** The type's natural length (s). */
const DEFAULT_DURATION: Record<SoundType, number> = {
  click: 0.03, tap: 0.07, pop: 0.12, tick: 0.02, typing: 1.2, whoosh: 0.8, swoosh: 0.35, riser: 2, downlifter: 1.5,
  impact: 1.6, thud: 0.45, boom: 3, shimmer: 1.4, sparkle: 0.6, chime: 1.2, notification: 0.9, glitch: 0.5, pad: 4, swell: 2.5,
  drone: 6, beat: 0, music: 8, stack: 0,
};

/** A recipe with its preset applied and its type known (throws RecipeError). */
export function resolveRecipe(r: SoundRecipe): SoundRecipe & { type: SoundType } {
  let base: SoundRecipe = {};
  if (r.preset !== undefined) {
    const p = SOUND_PRESETS[String(r.preset)];
    if (!p) throw new RecipeError(`preset: one of ${Object.keys(SOUND_PRESETS).join(", ")}`);
    base = p;
  }
  const type = (r.type ?? base.type) as SoundType | undefined;
  if (!type || !SOUND_TYPES.includes(type)) throw new RecipeError(`type: one of ${SOUND_TYPES.join(", ")} (or a preset)`);
  const out = { ...base, ...r, type };
  if (out.duration !== undefined && !(typeof out.duration === "number" && out.duration > 0 && out.duration <= 120)) throw new RecipeError("duration: seconds, more than 0, at most 120");
  if (out.mood !== undefined && !MOODS.includes(out.mood)) throw new RecipeError(`mood: one of ${MOODS.join(", ")}`);
  if (out.motif !== undefined && !MOTIFS.includes(out.motif)) throw new RecipeError(`motif: one of ${MOTIFS.join(", ")}`);
  if (out.pitch !== undefined && !Number.isFinite(pitchHz(out.pitch, 0))) throw new RecipeError('pitch: Hz or a note ("C5")');
  return out;
}

const pitchHz = (p: number | string | undefined, d: number) => (p === undefined ? d : typeof p === "number" ? p : hzOf(midiOf(p)));

/** Delay time: seconds, or a note value at bpm ("1/8", "3/16"). */
function delaySeconds(v: number | string | undefined, bpm: number, d: number): number {
  if (typeof v === "number" && v > 0) return Math.min(2, v);
  const m = typeof v === "string" ? /^(\d+)\/(\d+)$/.exec(v.trim()) : null;
  if (m) return Math.min(2, ((Number(m[1]) / Number(m[2])) * 4 * 60) / bpm);
  return d;
}

// ---- Rendering ----------------------------------------------------------------------------------------------------

export interface RenderedSound {
  pcm: Pcm;
  /** Seconds into the sound where its moment is */
  sync: number;
  type: SoundType;
  family: SoundFamily;
  /** The preset's or type's name, for the clip */
  label: string;
  /** The body's length (s), before tails */
  duration: number;
}

interface Ctx {
  r: SoundRecipe & { type: SoundType };
  rng: Rng;
  d: number;
  b: number;
  i: number;
  key: Key;
  bpm: number;
}

/** Renders a recipe (throws RecipeError on a bad one). */
export function renderSound(recipe: SoundRecipe): RenderedSound {
  const r = resolveRecipe(recipe);
  const seed = typeof r.seed === "number" && Number.isFinite(r.seed) ? Math.floor(r.seed) : 1;
  const mood = r.mood ?? "uplifting";
  const minorMood = mood === "tense" || mood === "dark" || mood === "epic" || mood === "lofi";
  const c: Ctx = {
    r,
    rng: new Rng(seed * 2654435761 + SOUND_TYPES.indexOf(r.type) * 97),
    d: r.duration ?? DEFAULT_DURATION[r.type],
    b: clamp01(r.brightness, 0.5),
    i: clamp01(r.intensity, 0.6),
    key: keyOf(r.key, minorMood ? "minor" : "major"),
    bpm: typeof r.bpm === "number" && r.bpm >= 40 && r.bpm <= 220 ? r.bpm : MOOD_STYLE[mood].bpm,
  };
  let out: { pcm: Pcm; sync: number; exact?: boolean };
  switch (r.type) {
    case "click": out = click(c); break;
    case "tap": out = tap(c); break;
    case "pop": out = popSound(c); break;
    case "tick": out = { pcm: one(tickVoice(c, 1, 1), c), sync: 0 }; break;
    case "typing": out = typing(c); break;
    case "whoosh": out = whoosh(c, 0.55, false); break;
    case "swoosh": out = whoosh(c, 0.4, true); break;
    case "riser": out = riser(c); break;
    case "downlifter": out = downlifter(c); break;
    case "impact": out = impact(c, "impact"); break;
    case "thud": out = impact(c, "thud"); break;
    case "boom": out = impact(c, "boom"); break;
    case "shimmer": out = shimmer(c, false); break;
    case "sparkle": out = shimmer(c, true); break;
    case "chime": out = chime(c, r.motif ?? "up"); break;
    case "notification": out = chime(c, r.motif ?? "message"); break;
    case "glitch": out = glitch(c); break;
    case "pad": out = padSound(c, "pad"); break;
    case "swell": out = padSound(c, "swell"); break;
    case "drone": out = drone(c); break;
    case "beat": out = beat(c); break;
    case "music": out = music(c, mood); break;
    case "stack": out = stack(c); break;
  }
  let pcm = out.pcm;
  if (r.type !== "stack" && !out.exact) {
    // Space: the delay and reverb on the whole sound (beds and beats have theirs inside).
    const dl = clamp01(r.delay, DEFAULT_DELAY[r.type]);
    const rv = clamp01(r.reverb, DEFAULT_REVERB[r.type]);
    if (dl > 0 || rv > 0) pcm = pad(pcm, rv * 3 + dl * 1.5);
    if (dl > 0) delay(pcm, delaySeconds(r.delayTime, c.bpm, 0.16), 0.35 + 0.3 * dl, dl * 0.6);
    if (rv > 0) reverb(pcm, rv * 0.5, r.type === "boom" || r.type === "impact" ? 0.9 : 0.7, 0.4);
  }
  dcBlock(pcm);
  if (out.exact) {
    const n = samples(c.d);
    if (r.loop) pcm = wrapLoop(pcm, n);
    else pcm = r.type === "music" ? fade(cut(pcm, n), 0, 0.005) : fade(cut(pcm, n), r.fadeIn ?? 0, r.fadeOut ?? 0.02);
  } else pcm = trimTail(pcm, out.sync + 0.01);
  normalize(pcm, -1);
  const sync = typeof r.syncAt === "number" && r.syncAt >= 0 ? Math.min(r.syncAt, lengthOf(pcm) / SR) : out.sync;
  return { pcm, sync, type: r.type, family: FAMILY[r.type], label: labelOf(recipe, r.type), duration: c.d };
}

const DEFAULT_REVERB: Record<SoundType, number> = {
  click: 0, tap: 0.05, pop: 0.05, tick: 0, typing: 0.05, whoosh: 0.12, swoosh: 0.08, riser: 0.3, downlifter: 0.3, impact: 0.35,
  thud: 0.05, boom: 0.5, shimmer: 0.5, sparkle: 0.35, chime: 0.3, notification: 0.2, glitch: 0.05, pad: 0.45, swell: 0.4,
  drone: 0.35, beat: 0, music: 0, stack: 0,
};
const DEFAULT_DELAY: Record<SoundType, number> = {
  click: 0, tap: 0, pop: 0, tick: 0, typing: 0, whoosh: 0, swoosh: 0, riser: 0, downlifter: 0.15, impact: 0, thud: 0, boom: 0,
  shimmer: 0.3, sparkle: 0.25, chime: 0.2, notification: 0.1, glitch: 0.1, pad: 0, swell: 0, drone: 0, beat: 0, music: 0, stack: 0,
};

function labelOf(r: SoundRecipe, type: SoundType): string {
  const raw = typeof r.preset === "string" ? r.preset : type === "music" && r.mood ? `music ${r.mood}` : type;
  const s = raw.replace(/[.\-_]+/g, " ").trim();
  return s.charAt(0).toUpperCase() + s.slice(1);
}

/** A mono voice as a centred (or panned) stereo sound. */
function one(mono: Float32Array, c: Ctx): Pcm {
  const p = stereo(mono.length);
  return panInto(p, mono, panCurve(c, mono.length, 0, 0));
}

/** The pan over `length` samples: `pan` → `panTo` (defaults per type). */
function panCurve(c: Ctx, length: number, from: number, to: number): number | Float32Array {
  const a = typeof c.r.pan === "number" ? Math.max(-1, Math.min(1, c.r.pan)) : from;
  const b = typeof c.r.panTo === "number" ? Math.max(-1, Math.min(1, c.r.panTo)) : typeof c.r.pan === "number" && from === to ? a : to;
  return a === b ? a : curve(length, [[0, a], [length / SR, b]]);
}

/** A sound rendered past `n` samples folded back onto its start, cut to `n` (a seamless loop). */
function wrapLoop(p: Pcm, n: number): Pcm {
  const out = cut(p, n);
  const len = lengthOf(p);
  for (let ch = 0; ch < 2; ch++) for (let i = n; i < len; i++) out.channels[ch][(i - n) % n] += p.channels[ch][i];
  return out;
}

// ---- UI -----------------------------------------------------------------------------------------------------------

function click(c: Ctx) {
  const n = samples(c.d + 0.01);
  const f = pitchHz(c.r.pitch, lerp(1600, 3600, c.b));
  const tone = mul(osc("sine", f, n), hitEnv(n, 0.0005, c.d * 0.7));
  const nz = mul(svf(noise(n, c.rng), "bandpass", lerp(2500, 8000, c.b), 1.2), hitEnv(n, 0.0002, c.d * 0.35));
  const body = mul(osc("sine", f * 0.25, n), hitEnv(n, 0.001, c.d * 0.5));
  const v = new Float32Array(n);
  add(v, tone, 0, 0.5);
  add(v, nz, 0, 0.4 + 0.6 * c.i);
  add(v, body, 0, 0.25 * c.i);
  return { pcm: one(v, c), sync: 0 };
}

function tap(c: Ctx) {
  const n = samples(c.d + 0.02);
  const f = pitchHz(c.r.pitch, lerp(380, 900, c.b));
  const tone = mul(osc("sine", sweep(n, f * 1.6, f, 0.3), n), hitEnv(n, 0.001, c.d));
  const res = mul(svf(noise(n, c.rng), "bandpass", f * 2, 4 + 6 * c.i), hitEnv(n, 0.0005, c.d * 0.6));
  const nz = mul(svf(noise(n, c.rng), "lowpass", lerp(1500, 6000, c.b)), hitEnv(n, 0.0003, 0.012));
  const v = new Float32Array(n);
  add(v, tone, 0, 0.7);
  add(v, res, 0, 0.5 * c.i);
  add(v, nz, 0, 0.35);
  return { pcm: one(drive(v, c.i * 0.3), c), sync: 0 };
}

function popSound(c: Ctx) {
  const n = samples(c.d + 0.02);
  const f = pitchHz(c.r.pitch, lerp(260, 640, c.b));
  // A mouth / bubble pop: the pitch jumps up through the attack.
  const fr = curve(n, [[0, f * 0.55], [c.d * 0.35, f * 1.5, 0.6], [c.d, f * 1.6]]);
  const tone = mul(osc("sine", fr, n), hitEnv(n, 0.002, c.d * 0.9));
  const harm = mul(osc("triangle", fr, n), hitEnv(n, 0.002, c.d * 0.4));
  const clk = mul(svf(noise(n, c.rng), "highpass", 3000), hitEnv(n, 0.0002, 0.006));
  const v = new Float32Array(n);
  add(v, tone, 0, 0.8);
  add(v, harm, 0, 0.25 * c.b);
  add(v, clk, 0, 0.2 + 0.2 * c.i);
  return { pcm: one(v, c), sync: 0.002 };
}

/** A keystroke: `vary` (0–1) is this one's variation, `level` its loudness. */
function tickVoice(c: Ctx, vary: number, level: number): Float32Array {
  const d = c.r.type === "tick" ? c.d : 0.03;
  const n = samples(d + 0.01);
  const f = pitchHz(c.r.pitch, lerp(2500, 6000, c.b)) * (0.85 + 0.3 * vary);
  const v = mul(svf(noise(n, c.rng), "bandpass", f, 2 + 3 * c.i), hitEnv(n, 0.0002, d * 0.5));
  add(v, mul(osc("square", f * 0.5, n), hitEnv(n, 0.0002, d * 0.15)), 0, 0.15);
  const thock = mul(osc("sine", 180 + 120 * vary, n), hitEnv(n, 0.0005, 0.02));
  add(v, thock, 0, 0.5 * c.i);
  return mul(v, level);
}

function typing(c: Ctx) {
  const given = Array.isArray(c.r.times) ? c.r.times.filter((t) => typeof t === "number" && t >= 0).sort((a, b) => a - b).slice(0, 2000) : null;
  const interval = typeof c.r.interval === "number" && c.r.interval > 0.005 ? c.r.interval : 0.075;
  const count = given ? given.length : Math.max(1, Math.min(2000, Math.round(typeof c.r.count === "number" ? c.r.count : c.d / interval)));
  const times = given ?? Array.from({ length: count }, (_, k) => Math.max(0, k * interval + (k ? c.rng.bi() * interval * 0.18 : 0)));
  const end = (times[times.length - 1] ?? 0) + 0.06;
  const p = stereo(samples(end));
  const width = clamp01(c.r.width, 0.25);
  times.forEach((t, k) => {
    const heavy = k % 7 === 6 || c.rng.next() < 0.08;
    const v = tickVoice(c, c.rng.next(), heavy ? 1 : 0.55 + 0.35 * c.rng.next());
    panInto(p, v, (typeof c.r.pan === "number" ? c.r.pan : 0) + c.rng.bi() * width * 0.5, sampleAt(t));
  });
  return { pcm: p, sync: times[0] ?? 0 };
}

// ---- Moves --------------------------------------------------------------------------------------------------------

function whoosh(c: Ctx, peakAt: number, fast: boolean) {
  const n = samples(c.d);
  const peak = c.d * peakAt;
  const lo = lerp(220, 600, c.b);
  const hi = lerpExp(1800, fast ? 11000 : 8000, c.b);
  const cutoff = curve(n, [[0, lo], [peak, hi, 1.6], [c.d, lo * 1.4, 0.7]]);
  const amp = curve(n, [[0, 0], [peak, 1, 2.2], [c.d, 0, 0.55]]);
  const body = mul(svf(noise(n, c.rng, "pink"), "bandpass", cutoff, 0.8 + 1.5 * c.i), amp);
  // Air: the same sweep an octave and a half up, thinner.
  const air = mul(svf(noise(n, c.rng), "bandpass", curve(n, [[0, lo * 3], [peak, Math.min(16000, hi * 1.8), 1.6], [c.d, lo * 3, 0.7]]), 1.5), amp);
  const v = new Float32Array(n);
  add(v, body, 0, 1);
  add(v, air, 0, 0.25 + 0.3 * c.b);
  if (c.i > 0.75) add(v, mul(osc("sine", curve(n, [[0, 60], [peak, 90], [c.d, 50]]), n), amp), 0, (c.i - 0.75) * 2);
  const p = stereo(n);
  panInto(p, v, panCurve(c, n, -0.5, 0.5));
  return { pcm: p, sync: peak };
}

// ---- Builds -------------------------------------------------------------------------------------------------------

function riser(c: Ctx) {
  const n = samples(c.d);
  const f0 = pitchHz(c.r.pitch, 110);
  const amp = curve(n, [[0, 0], [c.d - 0.015, 1, 2.2], [c.d, 0]]);
  const nz = mul(svf(noise(n, c.rng), "bandpass", sweep(n, 300, lerpExp(4000, 12000, c.b), 1.5), 0.9), amp);
  const fr = sweep(n, f0, f0 * 4, 1.6);
  const tone = new Float32Array(n);
  for (const det of [-0.012, 0, 0.011]) add(tone, osc("saw", fr.map((f) => f * (1 + det)), n, c.rng.next()), 0, 0.33);
  const toned = mul(svf(tone, "lowpass", sweep(n, 400, lerpExp(3000, 10000, c.b), 1.4), 1.2), amp);
  // A tremolo that speeds up with the tension.
  const rate = sweep(n, 4, 18, 1.2);
  const trem = new Float32Array(n);
  let ph = 0;
  for (let k = 0; k < n; k++) {
    trem[k] = 1 - c.i * 0.45 * (0.5 + 0.5 * Math.sin(2 * Math.PI * ph));
    ph += rate[k] / SR;
  }
  const v = new Float32Array(n);
  add(v, nz, 0, 0.8);
  add(v, mul(toned, trem), 0, 0.45 + 0.35 * c.i);
  const p = stereo(n);
  panInto(p, drive(v, c.i * 0.4), panCurve(c, n, 0, 0));
  return { pcm: p, sync: c.d };
}

function downlifter(c: Ctx) {
  const n = samples(c.d);
  const f0 = pitchHz(c.r.pitch, 110);
  const amp = hitEnv(n, 0.004, c.d);
  const nz = mul(svf(noise(n, c.rng), "bandpass", sweep(n, lerpExp(4000, 12000, c.b), 200, 0.7), 0.9), amp);
  const tone = mul(svf(osc("saw", sweep(n, f0 * 4, f0 * 0.75, 0.6), n), "lowpass", sweep(n, 6000, 300, 0.6)), amp);
  const sub = mul(osc("sine", sweep(n, 90, 35, 0.8), n), hitEnv(n, 0.003, c.d * 0.6));
  const v = new Float32Array(n);
  add(v, nz, 0, 0.7);
  add(v, tone, 0, 0.4);
  add(v, sub, 0, 0.6 * c.i);
  const p = stereo(n);
  panInto(p, v, panCurve(c, n, 0, 0));
  return { pcm: p, sync: 0 };
}

// ---- Hits ---------------------------------------------------------------------------------------------------------

function impact(c: Ctx, kind: "impact" | "thud" | "boom") {
  const n = samples(c.d);
  const big = kind === "boom" ? 1 : kind === "impact" ? 0.6 : 0.2;
  const f = pitchHz(c.r.pitch, kind === "boom" ? 38 : kind === "thud" ? 52 : 45);
  const sub = mul(osc("sine", curve(n, [[0, f * 3.2], [0.03 + 0.12 * big, f, 0.4], [c.d, f * 0.9]]), n), hitEnv(n, 0.001, c.d * (0.5 + 0.3 * big)));
  const bodyCut = kind === "boom" ? sweep(n, lerpExp(1200, 4000, c.b), 150, 0.5) : lerpExp(500, 3500, c.b);
  const body = mul(svf(noise(n, c.rng, "pink"), "lowpass", bodyCut, 0.9), hitEnv(n, 0.0005, kind === "thud" ? 0.08 : 0.25 + 0.9 * big));
  const crack = mul(svf(noise(n, c.rng), "highpass", lerpExp(1500, 6000, c.b)), hitEnv(n, 0.0001, 0.008 + 0.02 * c.i));
  const v = new Float32Array(n);
  add(v, sub, 0, 1);
  add(v, body, 0, 0.55 + 0.3 * big);
  add(v, crack, 0, (kind === "thud" ? 0.15 : 0.4) * (0.5 + c.i));
  const p = stereo(n);
  panInto(p, drive(v, c.i * 0.6), panCurve(c, n, 0, 0));
  return { pcm: p, sync: 0.001 };
}

// ---- Magic --------------------------------------------------------------------------------------------------------

/** A bell (FM, inharmonic ratio) of `f` Hz decaying over `decay` s. */
function bell(f: number, decay: number, ratio: number, index: number): Float32Array {
  const n = samples(decay + 0.02);
  const env = hitEnv(n, 0.002, decay);
  return mul(fm(f, ratio, env.map((e) => e * index), n), env);
}

function shimmer(c: Ctx, sparkle: boolean) {
  const n = samples(c.d + 1.2);
  const p = stereo(n);
  const count = Math.round((sparkle ? 14 : 10) + c.i * (sparkle ? 30 : 26));
  const span = c.d * (sparkle ? 0.5 : 0.7);
  const width = clamp01(c.r.width, 0.8);
  const oct = sparkle ? 6 + Math.round(c.b) : 5 + Math.round(c.b * 1.5);
  for (let k = 0; k < count; k++) {
    // Rising through the scale: early notes low, late notes high (a shimmer's lift).
    const x = Math.pow(c.rng.next(), sparkle ? 1.4 : 1.1);
    const t = x * span;
    const deg = Math.floor(x * 9 + c.rng.next() * 4);
    const f = hzOf(degreeMidi(c.key, deg, oct));
    const v = bell(f, (sparkle ? 0.25 : 0.6) + c.rng.next() * (sparkle ? 0.35 : 0.8), sparkle ? 3.5 : 1.41, sparkle ? 1.6 : 2.2);
    panInto(p, v, (typeof c.r.pan === "number" ? c.r.pan : 0) + c.rng.bi() * width, sampleAt(t), (0.3 + 0.7 * c.rng.next()) * (1 - 0.3 * x));
  }
  return { pcm: p, sync: 0 };
}

// ---- Notifications ------------------------------------------------------------------------------------------------

/** Motifs as semitones from the key's tonic (octave 5), the gap between notes (s) and the voice. */
const MOTIF: Record<Motif, { notes: number[]; gap: number; voice: "bell" | "soft" | "square" }> = {
  up: { notes: [0, 4, 7, 12], gap: 0.085, voice: "bell" },
  down: { notes: [12, 7, 4, 0], gap: 0.085, voice: "bell" },
  success: { notes: [0, 7, 12], gap: 0.1, voice: "bell" },
  error: { notes: [0, -1], gap: 0.14, voice: "square" },
  alert: { notes: [12, 7, 12, 7], gap: 0.12, voice: "soft" },
  coin: { notes: [11, 16], gap: 0.07, voice: "square" },
  message: { notes: [7, 12], gap: 0.11, voice: "soft" },
};

function chime(c: Ctx, motif: Motif) {
  const m = MOTIF[motif];
  const tonic = 12 * 6 + c.key.root + Math.round((c.b - 0.5) * 2) * 12;
  const notes = Array.isArray(c.r.notes) && c.r.notes.length ? c.r.notes.map((x) => midiOf(x)).filter((x) => Number.isFinite(x)) : m.notes.map((s) => tonic + s);
  const gap = typeof c.r.interval === "number" && c.r.interval > 0 ? c.r.interval : m.gap;
  const decay = Math.max(0.15, c.d - gap * (notes.length - 1));
  const n = samples(gap * notes.length + decay + 0.1);
  const p = stereo(n);
  notes.forEach((midi, k) => {
    const f = hzOf(midi);
    let v: Float32Array;
    if (m.voice === "square") {
      const len = samples(motif === "coin" ? (k ? decay * 0.6 : gap) : gap * 0.9);
      v = mul(svf(osc("square", f * (motif === "error" ? 0.5 : 1), len), "lowpass", lerpExp(1500, 6000, c.b)), adsr(len, 0.003, 0.05, 0.6, 0.03));
    } else if (m.voice === "soft") {
      const len = samples(decay);
      v = mul(osc("sine", f, len), hitEnv(len, 0.004, decay * 0.8));
      add(v, mul(osc("sine", f * 2, len), hitEnv(len, 0.002, decay * 0.3)), 0, 0.2 * c.b);
    } else {
      v = bell(f, decay, 2, 0.6 + c.b);
      add(v, mul(osc("sine", f, v.length), hitEnv(v.length, 0.003, decay)), 0, 0.6);
    }
    panInto(p, v, typeof c.r.pan === "number" ? c.r.pan : (k - (notes.length - 1) / 2) * 0.12 * clamp01(c.r.width, 1), sampleAt(k * gap), 0.8);
  });
  return { pcm: p, sync: 0 };
}

// ---- Glitch -------------------------------------------------------------------------------------------------------

function glitch(c: Ctx) {
  const n = samples(c.d);
  const p = stereo(n);
  let t = 0;
  let last: Float32Array | null = null;
  while (t < c.d) {
    const len = c.rng.range(0.012, 0.07);
    const m = samples(len);
    const kind = c.rng.next();
    let v: Float32Array;
    if (kind < 0.18) v = new Float32Array(m);
    else if (kind < 0.36 && last) v = last.slice(0, m);
    else if (kind < 0.6) v = mul(osc("square", c.rng.range(150, 600) * (1 + 6 * c.b * c.rng.next()), m), 0.6);
    else if (kind < 0.8) v = crush(svf(noise(m, c.rng), "highpass", lerpExp(500, 5000, c.b)), 4 + Math.round(4 * (1 - c.i)), 2 + c.rng.next() * 12);
    else v = mul(osc("sine", sweep(m, c.rng.range(2000, 6000), c.rng.range(100, 400)), m), 0.8);
    mul(v, adsr(m, 0.001, 0.005, 0.9, 0.002));
    panInto(p, v, c.rng.bi() * clamp01(c.r.width, 0.7), sampleAt(t));
    last = v;
    t += len;
  }
  for (const ch of p.channels) crush(ch, 8 + Math.round(4 * (1 - c.i)), 1);
  return { pcm: p, sync: 0 };
}

// ---- Ambience -----------------------------------------------------------------------------------------------------

/** Scale degrees (0-based) from "I" / "vi" / 1 … 7. */
function degreesOf(prog: (number | string)[] | undefined, fallback: number[]): number[] {
  if (!Array.isArray(prog) || !prog.length) return fallback;
  const ROMAN = ["i", "ii", "iii", "iv", "v", "vi", "vii"];
  const out = prog
    .map((p) => (typeof p === "number" ? p - 1 : ROMAN.indexOf(String(p).replace(/[^ivIV]/g, "").toLowerCase())))
    .filter((d) => Number.isInteger(d) && d >= 0 && d < 7);
  return out.length ? out.slice(0, 32) : fallback;
}

/** A pad voice: detuned saws through a low-pass with a slow sweep. */
function padVoice(c: Ctx, midi: number, len: number, cutoff: number | Float32Array): Float32Array {
  const f = hzOf(midi);
  const v = new Float32Array(len);
  for (const det of [-0.006, 0.0045, 0.0]) add(v, osc("saw", f * (1 + det), len, c.rng.next()), 0, 0.33);
  return svf(v, "lowpass", cutoff, 0.8);
}

function padSound(c: Ctx, kind: "pad" | "swell") {
  const n = samples(c.d);
  const p = stereo(n);
  const degs = degreesOf(c.r.progression, [0]);
  const seg = c.d / degs.length;
  const width = clamp01(c.r.width, 0.6);
  degs.forEach((deg, k) => {
    const len = samples(seg + (k < degs.length - 1 ? 0.3 : 0));
    const lfo = curve(len, [[0, 0.7], [len / SR / 2, 1.1], [len / SR, 0.8]]);
    const base = lerpExp(500, 3500, c.b);
    const cutoff = kind === "swell" ? curve(len, [[0, base * 0.3], [len / SR, base * 2, 2]]) : lfo.map((x) => x * base);
    const att = typeof c.r.attack === "number" ? c.r.attack : kind === "swell" ? seg * 0.9 : Math.min(1.2, seg * 0.3);
    const rel = typeof c.r.release === "number" ? c.r.release : kind === "swell" ? 0.03 : Math.min(1.5, seg * 0.35);
    const env = kind === "swell" ? curve(len, [[0, 0], [Math.max(0.01, len / SR - rel), 1, 2.4], [len / SR, 0]]) : adsr(len, att, 0.2, 0.85, rel);
    chordMidi(c.key, deg, 3, 4).forEach((midi, j) => panInto(p, mul(padVoice(c, midi, len, cutoff), env), (j - 1.5) * 0.35 * width, sampleAt(k * seg), 0.28));
    panInto(p, mul(osc("sine", hzOf(degreeMidi(c.key, deg, 2)), len), env), 0, sampleAt(k * seg), 0.3);
  });
  return { pcm: p, sync: kind === "swell" ? c.d : 0 };
}

function drone(c: Ctx) {
  const n = samples(c.d);
  const p = stereo(n);
  const root = degreeMidi(c.key, 0, 1 + Math.round(c.b));
  const env = adsr(n, Math.min(2, c.d * 0.25), 0.1, 1, Math.min(2, c.d * 0.25));
  const lfo = new Float32Array(n);
  for (let k = 0; k < n; k++) lfo[k] = lerpExp(200, 1100, c.b) * (1 + 0.4 * Math.sin((2 * Math.PI * 0.11 * k) / SR));
  [root, root + 7, root + 12].forEach((m, j) => panInto(p, mul(padVoice(c, m, n, lfo), env), (j - 1) * 0.4, 0, j === 2 ? 0.25 : 0.5));
  panInto(p, mul(svf(noise(n, c.rng, "pink"), "bandpass", 900, 0.6), env), 0, 0, 0.08 * c.i);
  return { pcm: p, sync: 0 };
}

// ---- Beats --------------------------------------------------------------------------------------------------------

const BEATS: Record<string, { kick: string; snare?: string; clap?: string; hat: string }> = {
  "four-on-floor": { kick: "x...x...x...x...", clap: "....x.......x...", hat: "..o...o...o...o." },
  hiphop: { kick: "x.....x...x.....", snare: "....x.......x...", hat: "x.x.x.x.x.x.x.x." },
  halftime: { kick: "x.........x.....", snare: "........x.......", hat: "x.x.x.x.x.x.x.x." },
  breakbeat: { kick: "x.........x.x...", snare: "....x..x.x..x..x", hat: "x.x.x.x.x.x.x.x." },
  minimal: { kick: "x...x...x...x...", hat: "..x...x...x...x." },
  light: { kick: "x.......x.......", hat: "..x...x...x...x." },
  pulse: { kick: "x...x...x...x...", hat: "xxxxxxxxxxxxxxxx" },
};

type Drum = "kick" | "snare" | "clap" | "hat" | "open";

function drumVoice(drum: Drum, c: Ctx, accent: number): Float32Array {
  switch (drum) {
    case "kick": {
      const n = samples(0.4);
      const v = mul(osc("sine", curve(n, [[0, 160], [0.06, 48, 0.4], [0.4, 42]]), n), hitEnv(n, 0.001, 0.38));
      add(v, mul(svf(noise(n, c.rng), "highpass", 3000), hitEnv(n, 0.0001, 0.006)), 0, 0.3);
      return mul(drive(v, 0.3), accent);
    }
    case "snare": {
      const n = samples(0.25);
      const v = mul(osc("triangle", curve(n, [[0, 240], [0.03, 185]]), n), hitEnv(n, 0.001, 0.1));
      add(v, mul(svf(noise(n, c.rng), "bandpass", lerpExp(1200, 3500, c.b), 0.7), hitEnv(n, 0.0005, 0.2)), 0, 0.9);
      return mul(v, 0.8 * accent);
    }
    case "clap": {
      const n = samples(0.3);
      const v = new Float32Array(n);
      const nz = svf(noise(n, c.rng), "bandpass", 1300, 1.2);
      for (const [t, g] of [[0, 0.7], [0.011, 0.8], [0.022, 1]] as const) add(v, mul(nz.slice(0, n - sampleAt(t)), hitEnv(n - sampleAt(t), 0.0005, t === 0.022 ? 0.2 : 0.012)), sampleAt(t), g);
      return mul(v, 0.8 * accent);
    }
    default: {
      const d = drum === "open" ? 0.22 : 0.04;
      const n = samples(d + 0.01);
      return mul(svf(noise(n, c.rng), "highpass", lerpExp(6000, 10000, c.b)), hitEnv(n, 0.0005, d)).map((x) => x * 0.45 * accent);
    }
  }
}

/** A drum pattern at `bpm` over `seconds` into `p` (from `startAt` s), swung by `swing` 0–1. */
function drumsInto(p: Pcm, c: Ctx, pattern: { kick?: string; snare?: string; clap?: string; hat?: string }, seconds: number, gain: number, swing: number) {
  const step = 60 / c.bpm / 4;
  const steps = Math.ceil(seconds / step);
  const rows: [Drum, string | undefined][] = [["kick", pattern.kick], ["snare", pattern.snare], ["clap", pattern.clap], ["hat", pattern.hat]];
  for (let s = 0; s < steps; s++) {
    const t = s * step + (s % 2 === 1 ? swing * step * 0.5 : 0);
    for (const [drum, row] of rows) {
      if (!row) continue;
      const ch = row[s % row.length];
      if (ch !== "x" && ch !== "X" && ch !== "o") continue;
      const accent = ch === "X" ? 1.2 : drum === "hat" && s % 4 !== 0 ? 0.7 + 0.2 * c.rng.next() : 1;
      const voice = drumVoice(drum === "hat" && ch === "o" ? "open" : drum, c, accent);
      panInto(p, voice, drum === "hat" ? 0.18 : 0, sampleAt(t), gain);
    }
  }
}

function patternOf(v: SoundRecipe["pattern"], fallback: string) {
  if (v && typeof v === "object") return v;
  const named = BEATS[typeof v === "string" ? v : fallback];
  if (!named) throw new RecipeError(`pattern: one of ${Object.keys(BEATS).join(", ")}, or rows {kick, snare, clap, hat} of "x" / "." steps`);
  return named;
}

function beat(c: Ctx) {
  const bar = (60 / c.bpm) * 4;
  if (!(c.r.duration && c.r.duration > 0)) c.d = bar * (typeof c.r.bars === "number" && c.r.bars > 0 ? Math.min(64, Math.round(c.r.bars)) : 2);
  const p = stereo(samples(c.d + 0.5));
  drumsInto(p, c, patternOf(c.r.pattern, "four-on-floor"), c.d, 0.9, clamp01(c.r.swing, 0));
  return { pcm: p, sync: 0, exact: true };
}

// ---- Music beds ---------------------------------------------------------------------------------------------------

interface MoodStyle {
  bpm: number;
  prog: number[];
  sevenths: boolean;
  bass: "eighths" | "quarters" | "whole" | "pulse" | "bounce";
  arp: "up16" | "up8" | "updown16" | "slow" | "none";
  arpVoice: "pluck" | "bell";
  drums: string | null;
  reverb: number;
  swing: number;
  lofi?: boolean;
}

export const MOOD_STYLE: Record<Mood, MoodStyle> = {
  uplifting: { bpm: 112, prog: [0, 4, 5, 3], sevenths: false, bass: "eighths", arp: "up16", arpVoice: "pluck", drums: "four-on-floor", reverb: 0.25, swing: 0 },
  corporate: { bpm: 100, prog: [0, 5, 3, 4], sevenths: false, bass: "quarters", arp: "up8", arpVoice: "pluck", drums: "light", reverb: 0.22, swing: 0 },
  calm: { bpm: 72, prog: [0, 3, 5, 4], sevenths: true, bass: "whole", arp: "slow", arpVoice: "bell", drums: null, reverb: 0.4, swing: 0 },
  dreamy: { bpm: 70, prog: [0, 3], sevenths: true, bass: "whole", arp: "up8", arpVoice: "bell", drums: null, reverb: 0.5, swing: 0 },
  tense: { bpm: 96, prog: [0, 5, 2, 6], sevenths: false, bass: "pulse", arp: "up16", arpVoice: "pluck", drums: null, reverb: 0.3, swing: 0 },
  dark: { bpm: 80, prog: [0, 3, 0, 4], sevenths: false, bass: "whole", arp: "slow", arpVoice: "bell", drums: null, reverb: 0.45, swing: 0 },
  epic: { bpm: 120, prog: [0, 5, 2, 6], sevenths: false, bass: "eighths", arp: "updown16", arpVoice: "pluck", drums: "halftime", reverb: 0.35, swing: 0 },
  playful: { bpm: 124, prog: [0, 5, 1, 4], sevenths: false, bass: "bounce", arp: "up8", arpVoice: "bell", drums: "hiphop", reverb: 0.18, swing: 0.15 },
  lofi: { bpm: 80, prog: [3, 2, 1, 4], sevenths: true, bass: "quarters", arp: "slow", arpVoice: "bell", drums: "hiphop", reverb: 0.3, swing: 0.35, lofi: true },
};

function pluck(c: Ctx, f: number, len: number, bright: number): Float32Array {
  const env = hitEnv(len, 0.002, len / SR);
  const v = osc("saw", f, len, c.rng.next());
  add(v, osc("square", f * 1.003, len, c.rng.next()), 0, 0.4);
  return mul(svf(v, "lowpass", env.map((e) => 200 + e * bright), 1.1), env);
}

function music(c: Ctx, mood: Mood) {
  const st = MOOD_STYLE[mood];
  const beat = 60 / c.bpm;
  const prog = degreesOf(c.r.progression, st.prog);
  const chordBeats = c.d < 6 ? 2 : 4;
  const chordLen = chordBeats * beat;
  // Notes start before `until`; their tails run on (a loop folds them onto its start).
  const until = c.r.loop ? c.d : c.d + 0.5;
  const total = c.d + 2.5;
  const parts = { pad: true, bass: true, arp: st.arp !== "none", drums: st.drums !== null, ...(c.r.parts ?? {}) };
  const p = stereo(samples(total));
  const pads = stereo(lengthOf(p));
  const swing = typeof c.r.swing === "number" ? clamp01(c.r.swing, 0) : st.swing;
  const bright = lerpExp(900, 5000, c.b);
  const chords = Math.ceil(until / chordLen);
  for (let k = 0; k < chords; k++) {
    const deg = prog[k % prog.length];
    const t0 = k * chordLen;
    const notes = chordMidi(c.key, deg, 4, st.sevenths ? 4 : 3);
    if (parts.pad) {
      const len = samples(chordLen + 0.25);
      const env = adsr(len, Math.min(0.4, chordLen * 0.2), 0.3, 0.8, 0.3);
      notes.forEach((m, j) => panInto(pads, mul(padVoice(c, m - 12, len, bright * 0.6), env), (j - 1.5) * 0.3, sampleAt(t0), 0.22));
    }
    if (parts.bass) {
      const root = degreeMidi(c.key, deg, 2);
      const f = hzOf(root);
      const hits: [number, number, number][] =
        st.bass === "whole" ? [[0, chordBeats, 1]]
        : st.bass === "quarters" ? Array.from({ length: chordBeats }, (_, b) => [b, 0.9, b === 0 ? 1 : 0.8] as [number, number, number])
        : st.bass === "pulse" ? Array.from({ length: chordBeats * 4 }, (_, b) => [b / 4, 0.22, b % 4 === 0 ? 1 : 0.7] as [number, number, number])
        : st.bass === "bounce" ? Array.from({ length: chordBeats * 2 }, (_, b) => [b / 2, 0.3, b % 2 ? 0.7 : 1] as [number, number, number])
        : Array.from({ length: chordBeats * 2 }, (_, b) => [b / 2, 0.45, b % 2 ? 0.75 : 1] as [number, number, number]);
      for (const [b, len, g] of hits) {
        if (t0 + b * beat >= until) continue;
        const n = samples(len * beat);
        const v = mul(svf(osc("saw", st.bass === "bounce" && b % 1 ? f * 2 : f, n), "lowpass", 300 + 500 * c.b, 0.9), adsr(n, 0.005, 0.1, 0.8, Math.min(0.08, (len * beat) / 3)));
        add(v, mul(osc("sine", f, n), adsr(n, 0.005, 0.1, 0.8, 0.05)), 0, 0.8);
        panInto(p, v, 0, sampleAt(t0 + b * beat), 0.42 * g);
      }
    }
    if (parts.arp && st.arp !== "none") {
      const step = st.arp === "up16" || st.arp === "updown16" ? beat / 4 : st.arp === "up8" ? beat / 2 : beat;
      const tones = [...notes, ...notes.map((m) => m + 12)];
      const order = st.arp === "updown16" ? [...tones, ...tones.slice(1, -1).reverse()] : tones;
      const count = Math.round(chordLen / step);
      for (let s = 0; s < count; s++) {
        const m = order[s % order.length] + (c.b > 0.7 ? 12 : 0);
        const len = samples(Math.min(0.6, step * (st.arpVoice === "bell" ? 3 : 1.6)));
        const v = st.arpVoice === "bell" ? bell(hzOf(m), len / SR, 2, 0.8) : pluck(c, hzOf(m), len, bright * 1.5);
        const t = t0 + s * step + (s % 2 === 1 ? swing * step * 0.5 : 0);
        if (t >= until) continue;
        panInto(p, v, Math.sin(s * 0.9) * 0.35, sampleAt(t), (s % 4 === 0 ? 0.2 : 0.14) * (st.arpVoice === "bell" ? 1.2 : 1));
      }
    }
  }
  mixInto(p, pads);
  if (parts.drums) drumsInto(p, c, patternOf(c.r.pattern, st.drums ?? "light"), until, mood === "calm" || mood === "dreamy" ? 0.35 : 0.5, swing);
  delay(p, delaySeconds(c.r.delayTime, c.bpm, (beat * 3) / 4), 0.35, clamp01(c.r.delay, 0.18));
  reverb(p, clamp01(c.r.reverb, st.reverb) * 0.5, 0.75, 0.5);
  if (st.lofi) for (const ch of p.channels) crush(ch, 12, 2);
  const faded = c.r.loop ? p : fadeInOut(p, c.d, c.r.fadeIn ?? 0.4, c.r.fadeOut ?? Math.min(1.5, c.d * 0.2));
  return { pcm: faded, sync: 0, exact: true };
}

/** Fades in from 0 and out to `d` (the bed's end), whatever comes after left for the cut. */
function fadeInOut(p: Pcm, d: number, fadeIn: number, fadeOut: number): Pcm {
  const n = samples(d);
  const a = samples(Math.max(0.001, fadeIn));
  const b = samples(Math.max(0.001, fadeOut));
  for (const ch of p.channels)
    for (let i = 0; i < ch.length; i++) {
      if (i < a) ch[i] *= i / a;
      if (i >= n) ch[i] = 0;
      else if (i > n - b) ch[i] *= (n - i) / b;
    }
  return p;
}

// ---- Stacks -------------------------------------------------------------------------------------------------------

function stack(c: Ctx) {
  const layers = Array.isArray(c.r.layers) ? c.r.layers.slice(0, 12) : [];
  if (!layers.length) throw new RecipeError("stack: layers — sounds to layer, each {type | preset, …, at (s), gainDb}");
  const parts = layers.map((l, k) => {
    if (l.type === "stack" || (l.preset && SOUND_PRESETS[l.preset]?.type === "stack")) throw new RecipeError("stack: layers can't be stacks");
    return { s: renderSound({ seed: (c.r.seed ?? 1) * 31 + k, ...l }), at: typeof l.at === "number" && l.at >= 0 ? l.at : 0, g: dbToGain(typeof l.gainDb === "number" ? Math.min(0, l.gainDb) : 0) };
  });
  const end = Math.max(...parts.map((x) => x.at + lengthOf(x.s.pcm) / SR));
  const p = stereo(samples(end));
  for (const x of parts) mixInto(p, x.s.pcm, sampleAt(x.at), x.g);
  return { pcm: p, sync: parts[0].at + parts[0].s.sync };
}
