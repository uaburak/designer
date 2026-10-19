// The vector animation exports (docs/motion.md §7.5, §7.6; round 8e) on a fixed scene: the path data as Lottie's
// contours, a transform as Lottie's position / rotation / skew / scale (composed back the way lottie-web does), the
// samples thinned to the frames a line can't skip, the Lottie file (layers, parenting, a clipping frame's precomp,
// trim paths, colours and opacity over time, rasters), the animated SVG (ids, matrices, keyframes, path trim) and the
// dotLottie ZIP (its entries readable, CRC-32 and deflate-raw).
import { describe, expect, it } from "vitest";
import type { MotionSample, MotionShapeLayer } from "@shared/motion/types";
import { animationId, crc32, writeDotLottie } from "../export/lottie/dotLottie";
import { lottieValue, writeLottie } from "../export/lottie/lottie";
import { writeAnimatedSvg } from "../export/svg";
import { buildScene, contoursOf, decompose, keepFrames, unwrapDegrees, type Matrix } from "../export/vectorAnim";

/** lottie-web's layer matrix from its transform (anchor 0): translate(p) · rotate(r) · skew(sk, 0) · scale(s). */
function lottieMatrix(p: [number, number], r: number, sk: number, s: [number, number]): Matrix {
  const rad = (d: number) => (d * Math.PI) / 180;
  const R: Matrix = [Math.cos(rad(r)), Math.sin(rad(r)), -Math.sin(rad(r)), Math.cos(rad(r)), 0, 0];
  const K: Matrix = [1, 0, Math.tan(rad(-sk)), 1, 0, 0];
  const S: Matrix = [s[0] / 100, 0, 0, s[1] / 100, 0, 0];
  const mul = (m: Matrix, n: Matrix): Matrix => [m[0] * n[0] + m[2] * n[1], m[1] * n[0] + m[3] * n[1], m[0] * n[2] + m[2] * n[3], m[1] * n[2] + m[3] * n[3], m[0] * n[4] + m[2] * n[5] + m[4], m[1] * n[4] + m[3] * n[5] + m[5]];
  const T: Matrix = [1, 0, 0, 1, p[0], p[1]];
  return mul(T, mul(R, mul(K, S)));
}

const still = (t: Matrix, o = 1, extra: Partial<MotionSample> = {}): MotionSample => ({ t, o, w: 100, h: 50, fills: [], strokes: [], sw: 0, ...extra });
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

const RECT = "M0 0L100 0L100 50L0 50Z";

describe("vector animation maths", () => {
  it("reads the engine's path data as contours: lines, cubics, quadratics raised, a closing vertex merged", () => {
    const [c] = contoursOf("M0 0L10 0C10 5 5 10 0 10Z");
    expect(c.c).toBe(true);
    expect(c.v).toEqual([[0, 0], [10, 0], [0, 10]]);
    expect(c.o[1]).toEqual([0, 5]);
    expect(c.i[2]).toEqual([5, 0]);
    const q = contoursOf("M0 0Q3 3 6 0")[0];
    expect(q.c).toBe(false);
    expect(q.o[0]).toEqual([2, 2]);
    expect(q.i[1]).toEqual([-2, 2]);
    // A contour that comes back to its start: the last vertex is the first.
    const closed = contoursOf("M0 0C1 0 2 1 2 2C2 3 1 4 0 0Z")[0];
    expect(closed.v).toHaveLength(2);
    expect(closed.i[0]).toEqual([1, 4]);
    expect(contoursOf("M0 0L1 1ZM5 5L6 6Z")).toHaveLength(2);
  });
  it("decomposes a transform so lottie-web composes it back: rotation, flip, skew", () => {
    const rot = (d: number): Matrix => [Math.cos((d * Math.PI) / 180), Math.sin((d * Math.PI) / 180), -Math.sin((d * Math.PI) / 180), Math.cos((d * Math.PI) / 180), 12, -7];
    for (const m of [rot(30), [2, 0, 0.5, 1.5, 3, 4] as Matrix, [-1, 0, 0, 1, 10, 0] as Matrix, [0.8, 0.3, -0.2, 1.1, 0, 0] as Matrix]) {
      const d = decompose(m);
      const back = lottieMatrix(d.p, d.r, d.sk, d.s);
      back.forEach((v, k) => expect(v).toBeCloseTo(m[k], 9));
    }
    expect(unwrapDegrees([170, -170, -10])).toEqual([170, 190, 350]);
  });
  it("keeps the frames a straight line can't skip; a constant value is static, a moving one keyframed and linear", () => {
    const ramp = [[0], [1], [2], [3], [3], [3], [10]];
    expect(keepFrames(ramp, 0.01)).toEqual([0, 3, 5, 6]);
    expect(lottieValue([[5], [5], [5]], 0.01, true)).toEqual({ a: 0, k: 5 });
    const v = lottieValue([[0, 0], [1, 2], [2, 4]], 0.01);
    expect(v.a).toBe(1);
    expect(v.k).toEqual([
      { t: 0, s: [0, 0], o: { x: [0, 0], y: [0, 0] }, i: { x: [1, 1], y: [1, 1] } },
      { t: 2, s: [2, 4] },
    ]);
  });
});

// A root with a red rect fading in and moving, a stroke being drawn by path trim, a clipping frame and an image.
function scene() {
  const shapes: MotionShapeLayer[] = [
    shape({ node: "1:1", name: "Root", paths: [{ d: RECT, windingRule: "NONZERO", paint: { type: "SOLID", color: { r: 1, g: 1, b: 1, a: 1 } }, source: { collection: "fills", index: 0 } }], clips: true }),
    shape({ node: "1:2", parent: "1:1", name: "Rect", type: "ROUNDED_RECTANGLE", transform: [1, 0, 0, 1, 10, 0], paths: [{ d: RECT, windingRule: "NONZERO", paint: { type: "SOLID", color: { r: 1, g: 0, b: 0, a: 1 } }, source: { collection: "fills", index: 0 } }] }),
    shape({ node: "1:3", parent: "1:1", name: "Line", type: "VECTOR", paths: [{ d: "M0 0L100 0", windingRule: "NONZERO", paint: { type: "SOLID", color: { r: 0, g: 0, b: 0, a: 1 } }, source: { collection: "strokes", index: 0 }, stroke: { weight: 2, cap: "ROUND", join: "MITER", miterLimit: 4, dashes: [] } }] }),
    shape({ node: "1:4", parent: "1:1", name: "Card", clips: true, transform: [1, 0, 0, 1, 0, 60], opacity: 0.5 }),
    shape({ node: "1:5", parent: "1:4", name: "Photo", type: "ROUNDED_RECTANGLE", rasterize: true, raster: { width: 40, height: 40, transform: [1, 0, 0, 1, 0, 0] } }),
  ];
  const frames = (f: (k: number) => MotionSample) => [0, 1, 2].map(f);
  const layers = [
    { node: "1:1", frames: frames(() => still([1, 0, 0, 1, 0, 0])) },
    { node: "1:2", frames: frames((k) => still([1, 0, 0, 1, 10 + 45 * k, 0], k / 2, { fills: [{ r: 1, g: 0, b: 0, a: 1 }] })) },
    { node: "1:3", frames: frames((k) => still([1, 0, 0, 1, 0, 0], 1, { strokes: [{ r: 0, g: 0, b: 0, a: 1 }], sw: 2, trim: [0, k / 2] })) },
    { node: "1:4", frames: frames(() => still([1, 0, 0, 1, 0, 60], 0.5)) },
    { node: "1:5", frames: frames(() => still([1, 0, 0, 1, 0, 0])) },
  ];
  return buildScene(shapes, layers, 2, 30)!;
}

describe("Lottie", () => {
  it("writes Lottie 5.7: the frames, the size at the scale, top layer first, each layer parented, the clip a masked precomp", () => {
    const json = writeLottie(scene(), { name: "Card", scale: 2, rasters: new Map([["1:5", { id: "image_0", w: 80, h: 80, u: "", p: "data:image/png;base64,AA==", e: 1 as const }]]) }) as {
      v: string; fr: number; op: number; w: number; h: number; layers: Record<string, unknown>[]; assets: Record<string, unknown>[];
    };
    expect([json.v, json.fr, json.op, json.w, json.h]).toEqual(["5.7.0", 30, 2, 200, 100]);
    const names = json.layers.map((l) => l.nm);
    // Top first: the clipped Card's precomp, the line, the rect, the root's own fill, the Size's null.
    expect(names).toEqual(["Card", "Line", "Rect", "Root", "Scale"]);
    const byName = (n: string) => json.layers.find((l) => l.nm === n)!;
    expect(byName("Root").parent).toBe(byName("Scale").ind);
    expect(byName("Rect").parent).toBe(byName("Root").ind);
    expect((byName("Scale").ks as { s: { k: number[] } }).s.k).toEqual([200, 200]);
    // The rect moves and fades in: position and opacity keyframed (linear: kept at the ends only).
    const ks = byName("Rect").ks as { p: { a: number; k: { t: number; s: number[] }[] }; o: { a: number; k: { s: number[] }[] } };
    expect(ks.p.a).toBe(1);
    expect(ks.p.k.map((k) => [k.t, k.s])).toEqual([[0, [10, 0]], [2, [100, 0]]]);
    expect(ks.o.k.map((k) => k.s[0])).toEqual([0, 100]);
    // The line: a stroke on its centre line, trimmed by Trim Paths 0 → 100 %.
    const group = (byName("Line").shapes as { it: { ty: string; e?: { k: { s: number[] }[] }; lc?: number }[] }[])[0];
    expect(group.it.map((i) => i.ty)).toEqual(["sh", "tm", "st", "tr"]);
    expect(group.it[1].e!.k.map((k) => k.s[0])).toEqual([0, 100]);
    expect(group.it[2].lc).toBe(2);
    // The clipping frame: a precomposition of its box, masked, carrying its opacity; the image inside.
    const card = byName("Card");
    expect(card.ty).toBe(0);
    expect(card.hasMask).toBe(true);
    expect((card.ks as { o: { k: number } }).o.k).toBe(50);
    const comp = json.assets.find((a) => a.id === card.refId) as { layers: Record<string, unknown>[] };
    expect(comp.layers.map((l) => [l.nm, l.ty])).toEqual([["Photo (image)", 2], ["Photo", 3], ["Card", 3]]);
    expect(json.assets.some((a) => a.id === "image_0" && a.e === 1)).toBe(true);
    // The image drawn at the scale's size, scaled back to its layer's.
    const img = comp.layers[0].ks as { s: { k: number[] } };
    expect(img.s.k).toEqual([50, 50]);
  });
});

describe("animated SVG", () => {
  it("nests a group per layer with its id, animates transforms, opacity and path trim with CSS keyframes, clips frames", () => {
    const svg = writeAnimatedSvg(scene(), { scale: 1, playback: "LOOP", durationMs: 2000, rasters: new Map([["1:5", { bytes: new Uint8Array([1, 2, 3]), width: 40, height: 40 }]]) });
    expect(svg.startsWith('<svg xmlns="http://www.w3.org/2000/svg" width="100" height="50" viewBox="0 0 100 50"')).toBe(true);
    expect(svg).toContain('id="n-1-2"');
    expect(svg).toMatch(/@keyframes k\d+\{0%\{transform:matrix\(1,0,0,1,10,0\)\}100%\{transform:matrix\(1,0,0,1,100,0\)\}\}/);
    expect(svg).toMatch(/@keyframes k\d+\{0%\{opacity:0\}100%\{opacity:1\}\}/);
    expect(svg).toContain("2000ms linear infinite both");
    expect(svg).toContain('pathLength="1"');
    expect(svg).toMatch(/0%\{stroke-dasharray:0 1\}100%\{stroke-dasharray:1 1\}/);
    expect(svg).toContain("<clipPath");
    expect(svg).toContain('href="data:image/png;base64,AQID"');
    expect(svg).toContain('opacity="0.5"');
    expect(writeAnimatedSvg(scene(), { scale: 1, playback: "ONCE", durationMs: 2000, rasters: new Map() })).toContain("2000ms linear 1 both");
  });
});

describe("dotLottie", () => {
  it("zips the manifest, the animations and the images: entries readable, CRC-32 and deflate-raw", async () => {
    expect(crc32(new TextEncoder().encode("123456789"))).toBe(0xcbf43926);
    expect(animationId("My card / v2", 0)).toBe("My_card_v2");
    expect(animationId("x", 2)).toBe("x_3");
    const bytes = await writeDotLottie([{ id: "card", json: { v: "5.7.0" } }], [{ name: "image_0.png", bytes: new Uint8Array([9, 9, 9]) }]);
    // The central directory's names, then each local entry inflated back.
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const end = bytes.length - 22;
    expect(view.getUint32(end, true)).toBe(0x06054b50);
    const count = view.getUint16(end + 10, true);
    let at = view.getUint32(end + 16, true);
    const entries: Record<string, Uint8Array> = {};
    for (let i = 0; i < count; i++) {
      const method = view.getUint16(at + 10, true);
      const size = view.getUint32(at + 20, true);
      const nameLen = view.getUint16(at + 28, true);
      const local = view.getUint32(at + 42, true);
      const name = new TextDecoder().decode(bytes.subarray(at + 46, at + 46 + nameLen));
      const data = bytes.subarray(local + 30 + view.getUint16(local + 26, true), local + 30 + view.getUint16(local + 26, true) + size);
      entries[name] = method === 8 ? new Uint8Array(await new Response(new Blob([data as BlobPart]).stream().pipeThrough(new DecompressionStream("deflate-raw"))).arrayBuffer()) : data;
      expect(crc32(entries[name])).toBe(view.getUint32(at + 16, true));
      at += 46 + nameLen;
    }
    expect(Object.keys(entries)).toEqual(["manifest.json", "animations/card.json", "images/image_0.png"]);
    expect(JSON.parse(new TextDecoder().decode(entries["manifest.json"])).animations[0].id).toBe("card");
    expect(JSON.parse(new TextDecoder().decode(entries["animations/card.json"]))).toEqual({ v: "5.7.0" });
    expect([...entries["images/image_0.png"]]).toEqual([9, 9, 9]);
  });
});
