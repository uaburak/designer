// The image tools' pixel maths (docs/ai.md §2.6): masks and compositing, Expand's canvas and re-composite, the
// tiling of Boost resolution (coverage, seams, the 4096 cap), the models' pre- and post-processing around a fake
// runner, fp16.
import { afterEach, describe, expect, it } from "vitest";
import { blank, blendMasked, expandCanvas, feather, fromHalf, insetsForAspect, maskBounds, rasterizePolygon, recomposite, resize, toHalf, type Rgba } from "../pixels";
import { boostInputSize, tilePlan, upscaleTiled } from "../tiles";
import { erase, foregroundMatte, inpaintRegion, isolate, upscaleTile } from "../runners";
import { setModelRunner, type ModelInput } from "../worker";

afterEach(() => setModelRunner(null));

const fill = (width: number, height: number, f: (x: number, y: number) => [number, number, number, number]): Rgba => {
  const data = new Uint8Array(width * height * 4);
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) data.set(f(x, y), (y * width + x) * 4);
  return { width, height, data };
};
const px = (img: Rgba, x: number, y: number) => Array.from(img.data.subarray((y * img.width + x) * 4, (y * img.width + x) * 4 + 4));
const sum = (m: Uint8Array) => m.reduce((s, v) => s + (v ? 1 : 0), 0);

describe("masks", () => {
  it("rasterize a lasso by pixel centres (even-odd)", () => {
    const square = rasterizePolygon([{ x: 2, y: 2 }, { x: 8, y: 2 }, { x: 8, y: 8 }, { x: 2, y: 8 }], 10, 10);
    expect(sum(square)).toBe(36);
    expect(maskBounds(square, 10, 10)).toEqual({ x: 2, y: 2, width: 6, height: 6 });
    const tri = rasterizePolygon([{ x: 0, y: 0 }, { x: 100, y: 0 }, { x: 0, y: 100 }], 100, 100);
    expect(sum(tri) / 5000).toBeCloseTo(1, 1);
    expect(sum(rasterizePolygon([{ x: 0, y: 0 }, { x: 5, y: 5 }], 10, 10))).toBe(0);
  });

  it("feather keeps the mask's mass and softens its edge", () => {
    const m = rasterizePolygon([{ x: 10, y: 10 }, { x: 30, y: 10 }, { x: 30, y: 30 }, { x: 10, y: 30 }], 40, 40);
    const f = feather(m, 40, 40, 3);
    expect(f[20 * 40 + 20]).toBe(255);
    expect(f[20 * 40 + 10]).toBeGreaterThan(0);
    expect(f[20 * 40 + 10]).toBeLessThan(255);
    expect(f.reduce((s, v) => s + v, 0) / m.reduce((s, v) => s + v, 0)).toBeCloseTo(1, 1);
  });

  it("blend mixes by the mask only", () => {
    const base = fill(4, 1, () => [0, 0, 0, 255]);
    const over = fill(2, 1, () => [200, 200, 200, 255]);
    const out = blendMasked(base, over, Uint8Array.from([255, 128]), 1, 0);
    expect(out.data.subarray(0, 16)).toEqual(Uint8Array.from([0, 0, 0, 255, 200, 200, 200, 255, 100, 100, 100, 255, 0, 0, 0, 255]));
  });
});

describe("Expand's compositing", () => {
  const original = fill(6, 4, (x, y) => [x * 40, y * 60, 7, 255]);

  it("puts the picture on the larger transparent canvas with OpenAI's mask (transparent = change)", () => {
    const { canvas, mask, at } = expandCanvas(original, { left: 2, top: 1, right: 3, bottom: 0 });
    expect([canvas.width, canvas.height, at.x, at.y]).toEqual([11, 5, 2, 1]);
    expect(px(canvas, 0, 0)[3]).toBe(0);
    expect(px(canvas, 2, 1)).toEqual(px(original, 0, 0));
    expect(px(canvas, 7, 4)).toEqual(px(original, 5, 3));
    expect(px(mask, 1, 1)[3]).toBe(0);
    expect(px(mask, 2, 1)[3]).toBe(255);
    expect(px(mask, 8, 1)[3]).toBe(0);
  });

  it("re-composites the untouched original over the answer, whatever size the answer came at", () => {
    const answer = fill(22, 10, () => [0, 0, 250, 128]);
    const out = recomposite(answer, original, 11, 5, { x: 2, y: 1 });
    expect([out.width, out.height]).toEqual([11, 5]);
    for (let y = 0; y < 4; y++) for (let x = 0; x < 6; x++) expect(px(out, x + 2, y + 1)).toEqual(px(original, x, y));
    expect(px(out, 0, 0)).toEqual([0, 0, 250, 255]);
    expect(px(out, 10, 4)).toEqual([0, 0, 250, 255]);
  });

  it("pads to an aspect ratio with the least growth, centred", () => {
    expect(insetsForAspect(400, 300, 1)).toEqual({ left: 0, right: 0, top: 50, bottom: 50 });
    expect(insetsForAspect(300, 300, 16 / 9)).toEqual({ left: 116, right: 117, top: 0, bottom: 0 });
    expect(insetsForAspect(300, 300, null)).toEqual({ left: 0, right: 0, top: 0, bottom: 0 });
  });
});

describe("Boost resolution's tiles", () => {
  it("cover the picture with 128 px tiles overlapping by 16, the last flush with the edge", () => {
    const plan = tilePlan(300, 130);
    expect(plan.map((t) => t.x).filter((v, i, a) => a.indexOf(v) === i)).toEqual([0, 112, 172]);
    expect(plan.map((t) => t.y).filter((v, i, a) => a.indexOf(v) === i)).toEqual([0, 2]);
    const covered = new Uint8Array(300 * 130);
    for (const t of plan) for (let y = t.y; y < t.y + t.height; y++) for (let x = t.x; x < t.x + t.width; x++) covered[y * 300 + x] = 1;
    expect(sum(covered)).toBe(300 * 130);
    expect(tilePlan(50, 20)).toEqual([{ x: 0, y: 0, width: 50, height: 20 }]);
  });

  it("cap the output's long side at 4096", () => {
    expect(boostInputSize(500, 300)).toEqual({ width: 500, height: 300 });
    expect(boostInputSize(2000, 1000)).toEqual({ width: 1024, height: 512 });
  });

  it("blend into a seamless picture (a smooth gradient stays smooth across tiles)", async () => {
    const src = fill(260, 140, (x, y) => [x % 256, y, 100, 255]);
    let tiles = 0;
    const nearest = async (t: Rgba) => {
      tiles++;
      const out = blank(t.width * 4, t.height * 4);
      for (let y = 0; y < out.height; y++) for (let x = 0; x < out.width; x++) out.data.set(t.data.subarray(((y >> 2) * t.width + (x >> 2)) * 4, ((y >> 2) * t.width + (x >> 2)) * 4 + 4), (y * out.width + x) * 4);
      return out;
    };
    const out = await upscaleTiled(src, nearest);
    expect([out.width, out.height]).toEqual([1040, 560]);
    expect(tiles).toBe(tilePlan(260, 140).length);
    for (const [x, y] of [[0, 0], [450, 300], [700, 520], [1039, 559]]) expect(px(out, x, y)).toEqual(px(src, x >> 2, y >> 2));
  });
});

describe("the models' processing (a fake runner)", () => {
  it("Remove background: 1024² ImageNet input, the sigmoid matte back at the picture's size", async () => {
    let seen: ModelInput | null = null;
    setModelRunner(async (_id, input) => {
      seen = input;
      const out = new Float32Array(1024 * 1024);
      for (let y = 0; y < 1024; y++) for (let x = 0; x < 1024; x++) out[y * 1024 + x] = y < 512 ? 20 : -20;
      return [{ data: new Float32Array(4), dims: [1, 1, 2, 2] }, { data: out, dims: [1, 1, 1024, 1024] }];
    });
    const matte = await foregroundMatte(fill(10, 10, () => [255, 255, 255, 255]));
    expect(seen!).toMatchObject({ kind: "onnx", file: "onnx/model_fp16.onnx" });
    const input = (seen! as Extract<ModelInput, { kind: "onnx" }>).inputs[0];
    expect(input.dims).toEqual([1, 3, 1024, 1024]);
    expect(input.data[0]).toBeCloseTo((1 - 0.485) / 0.229, 4);
    expect(matte[0]).toBe(255);
    expect(matte[99]).toBe(0);
  });

  it("Boost: a tile padded to a multiple of 8, the answer cropped back ×4", async () => {
    setModelRunner(async (_id, input) => {
      const t = (input as Extract<ModelInput, { kind: "onnx" }>).inputs[0];
      expect(t.dims).toEqual([1, 3, 16, 24]);
      return [{ data: new Float32Array(3 * 64 * 96).fill(0.5), dims: [1, 3, 64, 96] }];
    });
    const out = await upscaleTile(fill(20, 13, () => [9, 9, 9, 255]));
    expect([out.width, out.height]).toEqual([80, 52]);
    expect(px(out, 79, 51)).toEqual([128, 128, 128, 255]);
  });

  it("Erase: a 512² region around the lasso with the lasso's mask; outside untouched", async () => {
    setModelRunner(async (_id, input) => {
      const [img, mask] = (input as Extract<ModelInput, { kind: "onnx" }>).inputs;
      expect(img.dims).toEqual([1, 3, 512, 512]);
      expect(new Set(mask.data)).toEqual(new Set([0, 1]));
      return [{ data: new Float32Array(3 * 512 * 512).fill(77), dims: [1, 3, 512, 512] }];
    });
    const src = fill(200, 100, () => [10, 20, 30, 255]);
    const mask = rasterizePolygon([{ x: 90, y: 40 }, { x: 110, y: 40 }, { x: 110, y: 60 }, { x: 90, y: 60 }], 200, 100);
    expect(inpaintRegion({ x: 90, y: 40, width: 20, height: 20 }, 200, 100)).toEqual({ x: 68, y: 18, width: 64, height: 64 });
    const out = await erase(src, mask);
    expect(px(out, 100, 50)).toEqual([77, 77, 77, 255]);
    expect(px(out, 10, 10)).toEqual([10, 20, 30, 255]);
  });

  it("Isolate: the object inside the lasso only, cropped to it", async () => {
    setModelRunner(async () => [{ data: new Float32Array(1024 * 1024).fill(20), dims: [1, 1, 1024, 1024] }]);
    const src = fill(100, 100, () => [1, 2, 3, 255]);
    const lasso = rasterizePolygon([{ x: 20, y: 20 }, { x: 60, y: 20 }, { x: 60, y: 60 }, { x: 20, y: 60 }], 100, 100);
    const r = (await isolate(src, lasso))!;
    expect(r.rect).toEqual({ x: 18, y: 18, width: 44, height: 44 });
    expect(px(r.image, 22, 22)).toEqual([1, 2, 3, 255]);
    expect(px(r.image, 0, 0)[3]).toBeLessThan(10); // a 1 px feather at the lasso's edge
    expect(await isolate(src, new Uint8Array(100 * 100))).toBeNull();
  });
});

describe("helpers", () => {
  it("resize keeps a flat colour flat and weighs by alpha", () => {
    const r = resize(fill(10, 10, () => [10, 200, 30, 255]), 3, 7);
    expect(px(r, 2, 6)).toEqual([10, 200, 30, 255]);
    const edge = resize(fill(2, 1, (x) => (x ? [255, 0, 0, 255] : [0, 0, 0, 0])), 4, 1);
    expect(px(edge, 1, 0).slice(0, 3)).toEqual([255, 0, 0]);
  });

  it("fp16 round-trips the models' range", () => {
    for (const v of [0, 1, -2.5, 0.000123, 65504, 0.3333]) expect(fromHalf(toHalf(v))).toBeCloseTo(v, v < 0.01 ? 6 : 2);
  });
});
