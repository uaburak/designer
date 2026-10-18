// The vector exports' keyed layers (docs/motion.md §7.5, §7.6; round 8i) on a fixed scene: a layer moved, turned and
// faded by manual keyframes is written with those keyframes — Lottie's anchor at its anchor point, each key's curve as
// `o` / `i`, Hold as `h`, the motion path's handles as `to` / `ti`; the SVG's individual transforms with per-segment
// timing functions — and played back it lands on the samples; a spring, a clip, a Hold in Ping-pong or samples the keys
// don't reproduce keep the samples; round 8j: Ping-pong keyed there and back.
import { describe, expect, it } from "vitest";
import { cubicBezierAt } from "@shared/motion/easing";
import type { MotionSample, MotionShapeLayer, TimelineLayer, TimelineModel } from "@shared/motion/types";
import { channelAt, keyedLayers, motionPart } from "../export/keyframed";
import { writeLottie } from "../export/lottie/lottie";
import { writeAnimatedSvg } from "../export/svg";
import { buildScene, multiply, type Matrix } from "../export/vectorAnim";

const shape = (over: Partial<MotionShapeLayer> & { node: string }): MotionShapeLayer => ({
  parent: null,
  name: over.node,
  type: "FRAME",
  transform: [1, 0, 0, 1, 0, 0],
  size: { width: 100, height: 50 },
  opacity: 1,
  clips: false,
  paths: [],
  rasterize: false,
  ...over,
});
const sample = (t: Matrix, o = 1): MotionSample => ({ t, o, w: 100, h: 50, fills: [], strokes: [], sw: 0 });

const FPS = 10;
const TIMES = Array.from({ length: 11 }, (_, k) => k * 100_000);
const EASE_IN: [number, number, number, number] = [0.42, 0, 1, 1];
// The rect's base: moved to (20, 30), turned 90° (y-down: clockwise); its anchor the middle of its 100 × 50 box.
const BASE: Matrix = [0, 1, -1, 0, 20, 30];
const O = [50, 25];

/** The engine's M = L · T(o) · X · T(−o) for the motion part X (t, a clockwise turn in degrees, s). */
const placed = (x: Matrix): Matrix => multiply(multiply(BASE, [1, 0, 0, 1, O[0], O[1]]), multiply(x, [1, 0, 0, 1, -O[0], -O[1]]));

/** Moves 100 px along its x (eased in), turns −90° (Figma's 90° counter-clockwise) linearly, fades out held at 0.5 s. */
function layerModel(over: Partial<TimelineLayer> = {}): TimelineModel {
  const layer: TimelineLayer = {
    node: "1:2",
    name: "Rect",
    icon: "16.rectangle",
    depth: 1,
    tracks: [
      { id: "t1", field: { type: "PROPERTY", name: "TRANSLATION_XY" }, label: "Position", keyframes: [
        { id: "a", timeUs: 0, value: { type: "VECTOR", value: { x: 0, y: 0 } }, easing: { type: "LINEAR" } },
        { id: "b", timeUs: 1_000_000, value: { type: "VECTOR", value: { x: 100, y: 0 } }, easing: { type: "EASE_IN" } },
      ] },
      { id: "t2", field: { type: "PROPERTY", name: "ROTATION" }, label: "Rotation", keyframes: [
        { id: "c", timeUs: 0, value: { type: "FLOAT", value: 0 }, easing: { type: "LINEAR" } },
        { id: "d", timeUs: 1_000_000, value: { type: "FLOAT", value: 90 }, easing: { type: "LINEAR" } },
      ] },
      { id: "t3", field: { type: "PROPERTY", name: "OPACITY" }, label: "Opacity", keyframes: [
        { id: "e", timeUs: 0, value: { type: "FLOAT", value: 1 }, easing: { type: "LINEAR" } },
        { id: "f", timeUs: 500_000, value: { type: "FLOAT", value: 0.5 }, easing: { type: "HOLD" } },
      ] },
    ],
    clips: [],
    startUs: 0,
    endUs: 1_000_000,
    ...over,
  };
  return { root: "1:1", rootName: "Root", timelineId: "1:1", durationUs: 1_000_000, playback: "LOOP", snappingFps: 60, layers: [layer], audioTracks: [], audio: [] };
}

/**
 * The scene as the engine samples it (the same motion as the model's keys; `at` the translation at a time); `times`
 * each frame's timeline time (Ping-pong's fold back after 1 s).
 */
function scene(perturb = 0, at: (us: number) => number[] = (us) => [100 * cubicBezierAt(EASE_IN, us / 1e6), 0], times: readonly number[] = TIMES) {
  const shapes = [shape({ node: "1:1", name: "Root" }), shape({ node: "1:2", parent: "1:1", name: "Rect", transform: BASE })];
  const rect = times.map((us) => {
    const p = us / 1e6;
    const t = at(us);
    const x = motionPart([t[0] + (us === 500_000 ? perturb : 0), t[1]], -90 * p, [1, 1]);
    return sample(placed(x), us < 500_000 ? 1 : 0.5);
  });
  const s = buildScene(shapes, [{ node: "1:1", frames: times.map(() => sample([1, 0, 0, 1, 0, 0])) }, { node: "1:2", frames: rect }], times.length - 1, FPS)!;
  s.times = [...times];
  s.rangeUs = (times.length - 1) * 100_000;
  return s;
}

const anchors = new Map([["1:2", { x: 50, y: 50 }]]);

describe("keyed layers", () => {
  it("keys a layer its manual keyframes reproduce; plays a channel back with its curves", () => {
    const s = scene();
    const keyed = keyedLayers(s, layerModel(), "LOOP", anchors).get("1:2");
    expect(keyed?.transform).toBe(true);
    expect(keyed!.anchor).toEqual([50, 25]);
    expect(keyed!.translate!.keys.map((k) => k.ease)).toEqual([EASE_IN, null]);
    expect(keyed!.rotate!.keys.map((k) => k.v[0])).toEqual([-0, -90]);
    expect(channelAt(keyed!.translate!, 500_000)[0]).toBeCloseTo(100 * cubicBezierAt(EASE_IN, 0.5), 9);
    // Hold: the first value until the next key.
    expect(channelAt(keyed!.opacity!, 400_000)[0]).toBe(1);
    expect(channelAt(keyed!.opacity!, 500_000)[0]).toBe(0.5);
    expect(keyed!.inheritedOpacity).toBe(1);
  });
  it("keeps the samples for a spring, a clip, an instance, Ping-pong, and keys that miss the samples", () => {
    const spring = layerModel();
    spring.layers[0].tracks[0].keyframes[1].easing = { type: "BOUNCY" };
    expect(keyedLayers(scene(), spring, "LOOP", anchors).get("1:2")?.transform).toBe(false);
    const clip = layerModel({ clips: [{ id: "c", preset: "opacity", name: "Opacity", startUs: 0, durationUs: 1, disabled: false, easing: { type: "EASE_OUT" }, props: {} }] });
    expect(keyedLayers(scene(), clip, "LOOP", anchors).has("1:2")).toBe(false);
    expect(keyedLayers(scene(), layerModel({ instance: { offsetUs: 0, durationUs: 1, mainTimeline: "9:9" } }), "LOOP", anchors).has("1:2")).toBe(false);
    // Ping-pong with a Hold (its way back would hold the other end's value): sampled.
    expect(keyedLayers(scene(), layerModel(), "PING_PONG", anchors).size).toBe(0);
    // The layer drawn 3 px off its keys at 0.5 s (a layout move the keys don't know): its transform stays sampled.
    expect(keyedLayers(scene(3), layerModel(), "LOOP", anchors).get("1:2")?.transform).toBe(false);
  });

  it("round 8j: Ping-pong keyed there and back — the keys again at 2·D − t, each curve mirrored", () => {
    const model = layerModel();
    model.layers[0].tracks = model.layers[0].tracks.slice(0, 2);
    const folded = Array.from({ length: 21 }, (_, k) => (k <= 10 ? k : 20 - k) * 100_000);
    const keyed = keyedLayers(scene(0, undefined, folded), model, "PING_PONG", anchors).get("1:2");
    expect(keyed?.transform).toBe(true);
    // The key at D is the turn; the way back eases in by the ease-in curve's mirror (an ease-out).
    expect(keyed!.translate!.keys.map((k) => [k.timeUs, k.v[0]])).toEqual([[0, 0], [1_000_000, 100], [2_000_000, 0]]);
    expect(keyed!.translate!.keys[0].ease).toEqual(EASE_IN);
    expect(keyed!.translate!.keys[1].ease).toEqual([0, 0, expect.closeTo(0.58, 9), 1]);
    for (const us of [1_300_000, 1_500_000, 1_900_000]) expect(channelAt(keyed!.translate!, us)[0]).toBeCloseTo(100 * cubicBezierAt(EASE_IN, (2_000_000 - us) / 1e6), 9);
    expect(channelAt(keyed!.rotate!, 1_750_000)[0]).toBeCloseTo(-22.5, 5);
  });
});

describe("keyed Lottie and SVG", () => {
  it("Lottie: the anchor point, position along the base's turn with the key's curve, the turn added, Hold as h", () => {
    const s = scene();
    s.keyed = keyedLayers(s, layerModel(), "LOOP", anchors);
    const json = writeLottie(s, { name: "Root", scale: 1, rasters: new Map() }) as { layers: { nm: string; ks: Record<string, { a: number; k: unknown }> }[] };
    const ks = json.layers.find((l) => l.nm === "Rect")!.ks;
    expect(ks.a.k).toEqual([50, 25]);
    // p = L(o + t): the base turns x into y.
    const p = ks.p.k as { t: number; s: number[]; o?: { x: number[]; y: number[] }; i?: { x: number[]; y: number[] } }[];
    expect(p.map((k) => [k.t, k.s])).toEqual([[0, [-5, 80]], [10, [-5, 180]]]);
    expect(p[0].o).toEqual({ x: [0.42, 0.42], y: [0, 0] });
    expect(p[0].i).toEqual({ x: [1, 1], y: [1, 1] });
    // The base's 90° and the keyed −90°.
    expect((ks.r.k as { s: number[] }[]).map((k) => k.s[0])).toEqual([90, 0]);
    expect(ks.s).toEqual({ a: 0, k: [100, 100] });
    const o = ks.o.k as { t: number; s: number[]; h?: number }[];
    expect(o.map((k) => [k.t, k.s[0], k.h])).toEqual([[0, 100, 1], [5, 50, undefined]]);
    // A motion path's handles become the position keys' spatial tangents, turned with the base (the samples along the
    // curve, by arc length as the engine moves).
    const curved = layerModel();
    curved.layers[0].tracks[0].keyframes[0].pathHandles = { in: { x: 0, y: 0 }, out: { x: 0, y: -40 } };
    const path = keyedLayers(scene(), curved, "LOOP", anchors);
    expect(path.get("1:2")?.transform).toBe(false); // the straight samples don't follow the curve
    const along = { keys: [{ timeUs: 0, v: [0, 0], ease: EASE_IN, out: [0, -40] as [number, number] }, { timeUs: 1_000_000, v: [100, 0], ease: null }] };
    const c = scene(0, (us) => channelAt(along, us));
    c.keyed = keyedLayers(c, curved, "LOOP", anchors);
    expect(c.keyed.get("1:2")?.curved).toBe(true);
    const cj = writeLottie(c, { name: "Root", scale: 1, rasters: new Map() }) as { layers: { nm: string; ks: Record<string, { k: unknown }> }[] };
    const cp = cj.layers.find((l) => l.nm === "Rect")!.ks.p.k as { to?: number[]; ti?: number[] }[];
    expect(cp[0].to).toEqual([40, 0]);
    expect(cp[0].ti).toEqual([0, 0]);
    // The SVG can't bend CSS's translate: that layer stays sampled there.
    expect(writeAnimatedSvg(c, { scale: 1, playback: "LOOP", durationMs: 1000, rasters: new Map() })).not.toContain("translate:");
  });
  it("SVG: the base and anchor on the group, translate / rotate keyed with their timing functions, opacity held", () => {
    const s = scene();
    s.keyed = keyedLayers(s, layerModel(), "LOOP", anchors);
    const svg = writeAnimatedSvg(s, { scale: 1, playback: "LOOP", durationMs: 1000, rasters: new Map() });
    expect(svg).toContain('id="n-1-2" data-name="Rect" transform="matrix(0,1,-1,0,-5,80)"');
    expect(svg).toMatch(/@keyframes k\d+\{0%\{translate:0px 0px;animation-timing-function:cubic-bezier\(0\.42,0,1,1\)\}100%\{translate:100px 0px\}\}/);
    expect(svg).toMatch(/@keyframes k\d+\{0%\{rotate:0deg;animation-timing-function:cubic-bezier\(0,0,1,1\)\}100%\{rotate:-90deg\}\}/);
    expect(svg).toMatch(/@keyframes k\d+\{0%\{opacity:1;animation-timing-function:steps\(1,end\)\}50%\{opacity:0\.5\}100%\{opacity:0\.5\}\}/);
    expect(svg).toContain('<g transform="translate(-50,-25)">');
  });
});
