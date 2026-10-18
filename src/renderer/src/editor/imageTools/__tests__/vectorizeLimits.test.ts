// Vectorize's render limits (atlas 18 §7.7, Figma's own check): the layer scaled into 256…4096 px a side, 5 MP at most.
import { describe, expect, it } from "vitest";
import { vectorizeRenderSize } from "../vectorize";

describe("Vectorize's render limits", () => {
  it("scales a large layer down to 4096 and a small one up to 256", () => {
    expect(vectorizeRenderSize({ x: 8192, y: 2048 })).toEqual({ width: 4096, height: 1024 });
    expect(vectorizeRenderSize({ x: 128, y: 64 })).toEqual({ width: 512, height: 256 });
    expect(vectorizeRenderSize({ x: 1000, y: 800 })).toEqual({ width: 1000, height: 800 });
  });

  it("refuses a layer that can't fit, or one over 5 MP", () => {
    // 20:1 — scaled to 4096 long, its short side is under 256.
    expect(() => vectorizeRenderSize({ x: 8000, y: 400 })).toThrow("too small");
    // A thin layer scaled up to 256 short is over 4096 long.
    expect(() => vectorizeRenderSize({ x: 100, y: 1700 })).toThrow("too large");
    // 2400 × 2400 is 5.76 MP.
    expect(() => vectorizeRenderSize({ x: 2400, y: 2400 })).toThrow("too large");
  });
});
