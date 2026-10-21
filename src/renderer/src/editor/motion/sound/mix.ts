/**
 * The timeline's sound as numbers (docs/motion.md §9.3; [ours]) — an agent can't listen, so `get_sound_mix` mixes the
 * clips as the export does (volume × the row's gain, trims, offsets) and reports what an engineer would check: peak and
 * RMS per second, the overall peak, clipping, where many effects pile up, near-simultaneous starts (flams), how busy
 * each second is, the bed against the effects, and clips it couldn't hear (not decoded yet).
 */
import { SR, gainToDb, type Pcm } from "./dsp";

export interface MixClip {
  id: string;
  name: string;
  /** Timeline seconds */
  offset: number;
  /** Into the file (s) */
  trimStart: number;
  duration: number;
  /** Audible gain (volume × row gain; 0 when muted) */
  gain: number;
  /** The decoded samples (null: not available) */
  pcm: Pcm | null;
}

export interface MixReport {
  duration: number;
  peakDb: number;
  rmsDb: number;
  /** Per second: [start, peak dBFS, RMS dBFS, clips sounding] */
  seconds: { t: number; peakDb: number; rmsDb: number; clips: number }[];
  clipping: number[];
  beds: string[];
  /** Where three or more effects sound at once (their busiest 100 ms) */
  pileUps: { t: number; clips: string[] }[];
  /** Effect starts 1–40 ms apart: they smear */
  flams: { t: number; clips: string[] }[];
  /** Effects starting per second, where more than 4 */
  busy: { t: number; starts: number }[];
  /** The bed's RMS and the effects' peaks */
  balance: { bedRmsDb: number | null; sfxPeakDb: number | null };
  notHeard: string[];
  warnings: string[];
}

const r1 = (v: number) => Math.round(v * 10) / 10;
const db = (g: number) => r1(Math.max(-120, gainToDb(g)));

/** Whether a clip is a bed (music, pad, drone — or long against the timeline). */
export const isBed = (c: Pick<MixClip, "name" | "duration">, timeline: number) => /music|bed|pad|drone|ambience|beat|loop/i.test(c.name) || c.duration >= Math.max(3, timeline * 0.5);

export function analyzeMix(clips: readonly MixClip[], timeline: number): MixReport {
  const n = Math.max(1, Math.ceil(timeline * SR));
  const L = new Float32Array(n);
  const R = new Float32Array(n);
  const bedL = new Float32Array(n);
  const notHeard: string[] = [];
  const audible = clips.filter((c) => c.gain > 0);
  const beds = audible.filter((c) => isBed(c, timeline));
  const sfx = audible.filter((c) => !beds.includes(c));
  for (const c of audible) {
    if (!c.pcm) {
      notHeard.push(c.name);
      continue;
    }
    const ratio = c.pcm.sampleRate / SR;
    const [cl, cr] = c.pcm.channels;
    const start = Math.round(c.offset * SR);
    const len = Math.min(n - start, Math.round(c.duration * SR));
    const from = c.trimStart * c.pcm.sampleRate;
    const bed = beds.includes(c);
    for (let i = Math.max(0, -start); i < len; i++) {
      const j = Math.floor(from + i * ratio);
      if (j >= cl.length) break;
      L[start + i] += cl[j] * c.gain;
      R[start + i] += cr[j] * c.gain;
      if (bed) bedL[start + i] += cl[j] * c.gain;
    }
  }
  const seconds: MixReport["seconds"] = [];
  const clipping: number[] = [];
  let peak = 0, sum = 0;
  for (let s = 0; s * SR < n; s++) {
    let p = 0, q = 0;
    const end = Math.min(n, (s + 1) * SR);
    for (let i = s * SR; i < end; i++) {
      const a = Math.max(Math.abs(L[i]), Math.abs(R[i]));
      if (a > p) p = a;
      q += (L[i] * L[i] + R[i] * R[i]) / 2;
    }
    sum += q;
    peak = Math.max(peak, p);
    const sounding = audible.filter((c) => c.offset < s + 1 && c.offset + c.duration > s).length;
    seconds.push({ t: s, peakDb: db(p), rmsDb: db(Math.sqrt(q / Math.max(1, end - s * SR))), clips: sounding });
    if (p > 1) clipping.push(s);
  }

  // Pile-ups: three or more effects sounding in the same 100 ms (an effect "sounds" for its first 0.6 s or its length).
  const pileUps: MixReport["pileUps"] = [];
  const active = (c: MixClip) => [c.offset, c.offset + Math.min(c.duration, 0.6)] as const;
  for (let t = 0; t < timeline; t += 0.1) {
    const on = sfx.filter((c) => active(c)[0] < t + 0.1 && active(c)[1] > t);
    if (on.length >= 3 && !pileUps.some((p) => Math.abs(p.t - t) < 0.5)) pileUps.push({ t: Math.round(t * 10) / 10, clips: on.map((c) => c.name) });
  }
  const flams: MixReport["flams"] = [];
  const starts = [...sfx].sort((a, b) => a.offset - b.offset);
  for (let k = 1; k < starts.length; k++) {
    const gap = starts[k].offset - starts[k - 1].offset;
    if (gap > 0.001 && gap < 0.04) flams.push({ t: Math.round(starts[k - 1].offset * 1000) / 1000, clips: [starts[k - 1].name, starts[k].name] });
  }
  const busy: MixReport["busy"] = [];
  for (let s = 0; s < timeline; s++) {
    const count = sfx.filter((c) => c.offset >= s && c.offset < s + 1).length;
    if (count > 4) busy.push({ t: s, starts: count });
  }

  let bedSum = 0, bedN = 0;
  for (let i = 0; i < n; i++)
    if (bedL[i] !== 0) {
      bedSum += bedL[i] * bedL[i];
      bedN++;
    }
  const bedRmsDb = bedN ? db(Math.sqrt(bedSum / bedN)) : null;
  let sfxPeak = 0;
  for (const c of sfx) {
    if (!c.pcm) continue;
    const from = Math.floor(c.trimStart * c.pcm.sampleRate);
    const to = Math.min(c.pcm.channels[0].length, from + Math.round(c.duration * c.pcm.sampleRate));
    for (const ch of c.pcm.channels) for (let i = from; i < to; i++) sfxPeak = Math.max(sfxPeak, Math.abs(ch[i]) * c.gain);
  }
  const sfxPeakDb = sfx.some((c) => c.pcm) ? db(sfxPeak) : null;

  const warnings: string[] = [];
  if (clipping.length) warnings.push(`Clipping (over 0 dBFS) at ${clipping.map((s) => `${s} s`).join(", ")} — lower the loudest clips' volume there.`);
  else if (peak > 0.89) warnings.push("The peak is above −1 dBFS: lower the loudest clip a little for headroom.");
  if (pileUps.length) warnings.push(`${pileUps.length} pile-up(s) of 3+ effects — keep one hero sound per moment, drop or lower the rest.`);
  if (flams.length) warnings.push("Effects starting a few ms apart smear (flams): put them on the same time or ≥ 60 ms apart.");
  if (busy.length) warnings.push("More than 4 effects start in a second: it reads as clutter unless they are one stagger's ticks.");
  if (bedRmsDb !== null && sfxPeakDb !== null && sfxPeakDb - bedRmsDb < 10) warnings.push("The bed is close to the effects' level: keep it about 12 dB under them (bed volume ≈ 0.12–0.2).");
  if (bedRmsDb !== null && bedRmsDb > -14) warnings.push("The bed is loud: around −20 dBFS RMS sits under effects and voice.");
  if (notHeard.length) warnings.push(`Not analysed (not decoded yet): ${notHeard.join(", ")}.`);
  if (!audible.length) warnings.push("The timeline has no audible sound.");

  return {
    duration: Math.round(timeline * 1000) / 1000,
    peakDb: db(peak),
    rmsDb: db(Math.sqrt(sum / n)),
    seconds,
    clipping,
    beds: beds.map((c) => c.name),
    pileUps,
    flams,
    busy,
    balance: { bedRmsDb, sfxPeakDb },
    notHeard,
    warnings,
  };
}
