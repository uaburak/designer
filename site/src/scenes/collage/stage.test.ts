import { describe, expect, it } from "vitest";
import { stageBox } from "./stage";

describe("stageBox", () => {
  it("holds the stage at 1× on a tile its size or larger, centred", () => {
    expect(stageBox(1312, 640, 1312, 640)).toEqual({ s: 1, x: 0, y: 0 });
    expect(stageBox(1312, 640, 860, 560)).toEqual({ s: 1, x: 226, y: 40 });
  });

  it("scales down to cover a smaller tile of the same shape", () => {
    const b = stageBox(656, 320, 1312, 640);
    expect(b.s).toBe(0.5);
    expect([b.x, b.y]).toEqual([0, 0]);
  });

  it("on a phone keeps `safe` px of the width in view and centres the height", () => {
    const b = stageBox(343, 343, 860, 560, [0.5, 0.5], 686);
    expect(b.s).toBe(0.5);
    expect(b.y).toBe(32); // 343 − 280, halved
    expect(b.x).toBe(-43); // the middle 343 of 430, rounded
  });

  it("crops around the focus without showing past the stage's edges", () => {
    expect(stageBox(343, 429, 1312, 680, [0, 0.5], 560).x).toBe(0);
    const right = stageBox(343, 429, 1312, 680, [1, 0.5], 560);
    expect(right.x).toBe(Math.round(343 - 1312 * right.s));
  });
});
