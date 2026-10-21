// The local sound engine (docs/motion.md §9.3): recipes render deterministically at 48 kHz stereo, never silent, peaks
// under 0 dBFS, sync points where the ear hears the moment; the WAV round trip; the cue sheet from a resolved timeline;
// the mix check's numbers and warnings.
import { describe, expect, it } from "vitest";
import type { ResolvedMotion } from "@shared/motion/types";
import { keyOf, midiOf, peakOf, SR, type Pcm } from "../sound/dsp";
import { RecipeError, renderSound, resolveRecipe, SOUND_PRESETS, SOUND_TYPES } from "../sound/recipes";
import { decodeWav, encodeWav } from "../sound/wav";
import { scoreMotion } from "../sound/score";
import { analyzeMix } from "../sound/mix";

const rms = (p: Pcm, from = 0, to = p.channels[0].length) => {
  let s = 0;
  for (const ch of p.channels) for (let i = from; i < to; i++) s += ch[i] * ch[i];
  return Math.sqrt(s / Math.max(1, (to - from) * 2));
};
/** The 20 ms window with the most energy (seconds). */
const loudestAt = (p: Pcm) => {
  const w = Math.round(SR * 0.02);
  let best = 0, at = 0;
  for (let i = 0; i + w <= p.channels[0].length; i += w) {
    const e = rms(p, i, i + w);
    if (e > best) (best = e), (at = (i + w / 2) / SR);
  }
  return at;
};

describe("sound recipes", () => {
  it("every preset renders: 48 kHz stereo, finite, not silent, peak at −1 dBFS", () => {
    for (const preset of Object.keys(SOUND_PRESETS)) {
      const s = renderSound({ preset, duration: preset.startsWith("music") ? 3 : undefined });
      expect(s.pcm.sampleRate, preset).toBe(48_000);
      expect(s.pcm.channels).toHaveLength(2);
      expect(s.pcm.channels[0].length, preset).toBe(s.pcm.channels[1].length);
      expect(s.pcm.channels[0].every(Number.isFinite), preset).toBe(true);
      expect(rms(s.pcm), preset).toBeGreaterThan(0.005);
      const peak = peakOf(s.pcm);
      expect(peak, preset).toBeLessThan(1);
      expect(20 * Math.log10(peak), preset).toBeCloseTo(-1, 1);
      expect(s.sync, preset).toBeGreaterThanOrEqual(0);
      expect(s.sync, preset).toBeLessThanOrEqual(s.pcm.channels[0].length / SR);
    }
  });

  it("covers every type", () => {
    const types = new Set(Object.values(SOUND_PRESETS).map((p) => p.type));
    for (const t of SOUND_TYPES) expect(types.has(t), t).toBe(true);
  });

  it("is deterministic: the same seed gives the same samples, another seed another take", () => {
    const a = renderSound({ type: "whoosh", seed: 7 });
    const b = renderSound({ type: "whoosh", seed: 7 });
    const c = renderSound({ type: "whoosh", seed: 8 });
    expect(encodeWav(a.pcm)).toEqual(encodeWav(b.pcm));
    expect(encodeWav(a.pcm)).not.toEqual(encodeWav(c.pcm));
  });

  it("puts the sync point where the moment is: a whoosh's peak, a riser's end, a hit's start", () => {
    const w = renderSound({ type: "whoosh", duration: 1, reverb: 0 });
    expect(w.sync).toBeCloseTo(0.55, 2);
    expect(Math.abs(loudestAt(w.pcm) - w.sync)).toBeLessThan(0.12);
    const r = renderSound({ type: "riser", duration: 2, reverb: 0 });
    expect(r.sync).toBe(2);
    expect(loudestAt(r.pcm)).toBeGreaterThan(1.6);
    const i = renderSound({ type: "impact" });
    expect(i.sync).toBeLessThan(0.01);
    expect(loudestAt(i.pcm)).toBeLessThan(0.1);
    // A pan movement: a pass-by is left early, right late.
    const p = renderSound({ preset: "pass-by", reverb: 0 });
    const n = p.pcm.channels[0].length;
    const side = (from: number, to: number) => rms({ ...p.pcm, channels: [p.pcm.channels[1], p.pcm.channels[1]] }, from, to) - rms({ ...p.pcm, channels: [p.pcm.channels[0], p.pcm.channels[0]] }, from, to);
    expect(side(0, Math.round(n * 0.3))).toBeLessThan(0);
    expect(side(Math.round(n * 0.55), Math.round(n * 0.75))).toBeGreaterThan(0);
  });

  it("music beds and beats keep their exact length (a loop folds its tail onto its start)", () => {
    const bed = renderSound({ type: "music", mood: "calm", duration: 5, key: "D minor" });
    expect(bed.pcm.channels[0].length).toBe(5 * SR);
    const loop = renderSound({ type: "music", mood: "uplifting", duration: 4, loop: true });
    expect(loop.pcm.channels[0].length).toBe(4 * SR);
    // A loop's start isn't a fade from silence.
    expect(rms(loop.pcm, 0, SR / 10)).toBeGreaterThan(0.01);
    const beat = renderSound({ type: "beat", pattern: "hiphop", bpm: 90, bars: 2 });
    expect(beat.pcm.channels[0].length).toBe(Math.round(((60 / 90) * 8) * SR));
  });

  it("typing follows given times", () => {
    const s = renderSound({ type: "typing", times: [0, 0.1, 0.25], reverb: 0 });
    const at = (t: number) => rms(s.pcm, Math.round(t * SR), Math.round((t + 0.015) * SR));
    const gap = (t: number) => rms(s.pcm, Math.round(t * SR), Math.round((t + 0.015) * SR));
    expect(at(0.1)).toBeGreaterThan(gap(0.06) * 3);
    expect(at(0.25)).toBeGreaterThan(gap(0.18) * 3);
  });

  it("reads notes and keys; refuses what it can't make", () => {
    expect(midiOf("A4")).toBe(69);
    expect(midiOf("C#5")).toBe(73);
    expect(keyOf("F# minor")).toMatchObject({ root: 6, mode: "minor" });
    expect(keyOf("Eb")).toMatchObject({ root: 3, mode: "major" });
    expect(() => resolveRecipe({ type: "laser" as never })).toThrow(RecipeError);
    expect(() => resolveRecipe({ preset: "nope" })).toThrow(/preset: one of/);
    expect(() => resolveRecipe({ type: "music", mood: "sad" as never })).toThrow(/mood/);
    expect(() => renderSound({ type: "stack" })).toThrow(/layers/);
    expect(() => renderSound({ type: "beat", pattern: "polka" })).toThrow(/pattern/);
  });

  it("writes and reads a 16-bit WAV", () => {
    const s = renderSound({ type: "pop", seed: 3 });
    const wav = encodeWav(s.pcm);
    expect(String.fromCharCode(...wav.slice(0, 4))).toBe("RIFF");
    expect(wav.length).toBe(44 + s.pcm.channels[0].length * 4);
    const back = decodeWav(wav)!;
    expect(back.sampleRate).toBe(48_000);
    expect(back.channels[0].length).toBe(s.pcm.channels[0].length);
    expect(Math.abs(back.channels[0][100] - s.pcm.channels[0][100])).toBeLessThan(1e-4);
  });
});

const f = (v: number) => ({ type: "FLOAT" as const, value: v });
const key = (t: number, v: number, type = "EASE_OUT") => ({ timeUs: t * 1e6, value: f(v), easing: { type } as never });
const prop = (name: string, keys: ReturnType<typeof key>[], stagger?: { grouping: string; order: string; delayMs: number; elements: number }) => ({ field: { type: "PROPERTY", name } as never, kind: "absolute" as const, keyframes: keys, ...(stagger ? { stagger } : {}) });
const layer = (node: string, name: string, w: number, h: number, properties: ReturnType<typeof prop>[]) => ({ node, path: node, name, anchor: { x: 50, y: 50 }, size: { width: w, height: h }, properties });

describe("score_motion's cue sheet", () => {
  const resolved: ResolvedMotion = {
    root: "1:1",
    durationUs: 4e6,
    playback: "ONCE",
    layers: [
      // A card slides in 300 px from the left and fades in, 0.2–0.8 s.
      layer("1:2", "Card", 600, 400, [prop("TRANSLATION_X", [key(0.2, -300), key(0.8, 0)]), prop("OPACITY", [key(0.2, 0), key(0.5, 1)])]),
      // Three dots appear in turn, 0.1 s apart.
      ...[0, 1, 2].map((k) => layer(`1:${3 + k}`, `Dot ${k + 1}`, 20, 20, [prop("OPACITY", [key(1 + k * 0.1, 0), key(1.2 + k * 0.1, 1)])])),
      // The logo pops (scale with a back ease) at 2–2.5 s and lands with the title.
      layer("1:6", "Logo", 300, 300, [prop("SCALE_XY", [key(2, 0.5), key(2.5, 1, "EASE_OUT_BACK")])]),
      // A title by characters: 5 elements 40 ms apart.
      layer("1:7", "Title", 400, 80, [prop("OPACITY", [key(2.2, 0), key(2.5, 1)], { grouping: "CHARACTER", order: "LEFT_RIGHT", delayMs: 40, elements: 5 })]),
    ],
  };
  const score = scoreMotion({ resolved, rootSize: { width: 1920, height: 1080 } });
  const ev = (type: string, layerName?: string) => score.events.filter((e) => e.type === type && (layerName === undefined || e.layer === layerName));

  it("finds appearances, moves with their peak, arrivals and pops at their times", () => {
    expect(ev("appear", "Card")[0]).toMatchObject({ t: 0.2, end: 0.5 });
    const move = ev("move", "Card")[0];
    expect(move).toMatchObject({ t: 0.2, end: 0.8, props: ["position"], ease: "EASE_OUT" });
    // Ease out: fastest at its start.
    expect(move.peak!).toBeLessThan(0.3);
    expect(ev("arrive", "Card")[0].t).toBe(0.8);
    const pop = ev("pop", "Logo")[0];
    expect(pop.t).toBeGreaterThan(2.1);
    expect(pop.t).toBeLessThan(2.5);
    expect(ev("arrive", "Logo")[0].t).toBe(2.5);
  });

  it("finds a text's per-character times and a group stagger", () => {
    expect(ev("stagger", "Title")[0]).toMatchObject({ t: 2.2, step: 0.04, count: 5, times: [2.2, 2.24, 2.28, 2.32, 2.36], grouping: "CHARACTER" });
    const group = score.events.find((e) => e.type === "stagger" && e.grouping === "LAYERS")!;
    expect(group).toMatchObject({ t: 1, step: 0.1, count: 3, layers: ["Dot 1", "Dot 2", "Dot 3"] });
  });

  it("ranks accents, picks the climax, knows the rest and the end, and suggests cues", () => {
    expect(score.duration).toBe(4);
    expect(score.rest).toBeCloseTo(2.5, 2);
    expect(ev("end")[0].t).toBe(4);
    // The logo's pop (its overshoot's top) or its landing: the strongest moment.
    expect(score.climax!.what).toMatch(/Logo/);
    expect(score.climax!.t).toBeGreaterThan(2.25);
    expect(score.climax!.t).toBeLessThanOrEqual(2.5);
    expect(score.energy.values.length).toBe(16);
    expect(Math.max(...score.energy.values)).toBe(1);
    const sounds = score.cues.map((c) => c.sound);
    expect(sounds).toContain("whoosh");
    expect(sounds).toContain("riser");
    // A whoosh 30 % into the card's ease-out slide; no hit on a fade-in.
    expect(score.cues.find((c) => c.sound === "whoosh")!.t).toBeCloseTo(0.38, 2);
    expect(score.cues.some((c) => (c.sound === "thud" || c.sound === "impact") && c.t < 0.5)).toBe(false);
    // The logo's moment gets a hit (the riser ends on it).
    expect(score.cues.some((c) => ["impact", "thud", "pop"].includes(c.sound) && c.t === score.climax!.t)).toBe(true);
    expect(score.cues.find((c) => c.sound === "riser")!.t).toBe(score.climax!.t);
    expect(score.cues.find((c) => c.sound === "typing")!.times).toEqual([2.2, 2.24, 2.28, 2.32, 2.36]);
  });
});

describe("get_sound_mix's numbers", () => {
  const tone = (seconds: number, amp: number): Pcm => {
    const n = Math.round(seconds * SR);
    const ch = new Float32Array(n).map((_, i) => amp * Math.sin((2 * Math.PI * 440 * i) / SR));
    return { sampleRate: SR, channels: [ch, ch.slice()] };
  };
  it("measures peaks per second and warns about clipping, pile-ups, flams and a loud bed", () => {
    const clips = [
      { id: "b", name: "Music uplifting", offset: 0, trimStart: 0, duration: 3, gain: 1, pcm: tone(3, 0.5) },
      { id: "1", name: "Whoosh", offset: 1, trimStart: 0, duration: 0.5, gain: 1, pcm: tone(0.5, 0.6) },
      { id: "2", name: "Pop", offset: 1.01, trimStart: 0, duration: 0.5, gain: 1, pcm: tone(0.5, 0.6) },
      { id: "3", name: "Impact", offset: 1.05, trimStart: 0, duration: 0.5, gain: 1, pcm: tone(0.5, 0.6) },
      { id: "4", name: "Later", offset: 2.5, trimStart: 0, duration: 0.5, gain: 1, pcm: null },
    ];
    const r = analyzeMix(clips, 3);
    expect(r.seconds).toHaveLength(3);
    expect(r.seconds[0].peakDb).toBeCloseTo(-6, 0);
    expect(r.clipping).toEqual([1]);
    expect(r.beds).toEqual(["Music uplifting"]);
    expect(r.pileUps[0].clips).toEqual(["Whoosh", "Pop", "Impact"]);
    expect(r.flams[0]).toMatchObject({ t: 1, clips: ["Whoosh", "Pop"] });
    expect(r.notHeard).toEqual(["Later"]);
    expect(r.warnings.join(" ")).toMatch(/Clipping.*1 s/);
    expect(r.warnings.join(" ")).toMatch(/pile-up/);
    expect(r.warnings.join(" ")).toMatch(/bed/);
  });

  it("a clean mix has no warnings", () => {
    const r = analyzeMix([{ id: "b", name: "Music calm", offset: 0, trimStart: 0, duration: 2, gain: 0.1, pcm: tone(2, 0.9) }, { id: "1", name: "Pop", offset: 0.5, trimStart: 0, duration: 0.3, gain: 0.7, pcm: tone(0.3, 0.9) }], 2);
    expect(r.warnings).toEqual([]);
    expect(r.peakDb).toBeLessThan(-1);
  });
});
