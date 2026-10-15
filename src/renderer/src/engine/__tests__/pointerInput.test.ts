import { describe, expect, it } from "vitest";
import { WHEEL_MOUSE, WHEEL_TRACKPAD } from "../abi";
import { pinchDelta, PINCH_RATE, TouchPinch, wheelSource, WheelNormalizer, withinClickBox } from "../pointerInput";

describe("pointer input (Figma's rules, docs/research/rea/canvas.md §2.13–2.14)", () => {
  it("click count: a box of 4 px on each axis (10 for touch), not a circle", () => {
    expect(withinClickBox(3, 3)).toBe(true); // 4.2 px away: inside the box, outside a 4 px circle
    expect(withinClickBox(-3.9, 0)).toBe(true);
    expect(withinClickBox(4, 0)).toBe(false); // strict
    expect(withinClickBox(0, -4)).toBe(false);
    expect(withinClickBox(9, 9, true)).toBe(true);
    expect(withinClickBox(10, 0, true)).toBe(false);
  });

  it("wheel source: whole-number deltas on both axes are a trackpad's, fractional ones a mouse's", () => {
    expect(wheelSource(0, 4)).toBe(WHEEL_TRACKPAD);
    expect(wheelSource(-12, 30)).toBe(WHEEL_TRACKPAD);
    expect(wheelSource(0, 4.000244140625)).toBe(WHEEL_MOUSE);
    expect(wheelSource(0.5, 0)).toBe(WHEEL_MOUSE);
  });

  it("Shift swaps the axes off the Mac only", () => {
    const mac = new WheelNormalizer({ mac: true, windows: false });
    expect(mac.normalize({ dx: 0, dy: 10, shift: true, ctrl: false, t: 0 })).toEqual({ dx: 0, dy: 10, source: WHEEL_TRACKPAD });
    const linux = new WheelNormalizer({ mac: false, windows: false });
    expect(linux.normalize({ dx: 0, dy: 10, shift: true, ctrl: false, t: 0 })).toEqual({ dx: 10, dy: 0, source: WHEEL_TRACKPAD });
    expect(linux.normalize({ dx: 0, dy: 10, shift: false, ctrl: false, t: 0 })).toEqual({ dx: 0, dy: 10, source: WHEEL_TRACKPAD });
  });

  it("Windows notches: d / 120 × 8, × 2.5 per notch under 50 ms the same way, clamped to 120 (40 with Ctrl)", () => {
    const w = new WheelNormalizer({ mac: false, windows: true });
    const notch = (dy: number, t: number, ctrl = false) => w.normalize({ dx: 0, dy, shift: false, ctrl, t });
    expect(notch(120, 1000)).toEqual({ dx: 0, dy: 8, source: WHEEL_MOUSE });
    expect(notch(120, 1030).dy).toBeCloseTo(20);
    expect(notch(120, 1060).dy).toBeCloseTo(50);
    expect(notch(120, 1090).dy).toBeCloseTo(120); // 125, clamped
    expect(notch(120, 1120).dy).toBeCloseTo(120);
    // Too late, or the other way: back to 8.
    expect(notch(120, 1300).dy).toBeCloseTo(8);
    expect(notch(-120, 1320).dy).toBeCloseTo(-8);
    // Ctrl (a zoom): clamped to 40.
    for (let t = 2000; t < 2200; t += 20) notch(100, t, true);
    expect(notch(100, 2200, true).dy).toBeCloseTo(40);
    // The vector is clamped, not each axis.
    const both = new WheelNormalizer({ mac: false, windows: true });
    both.normalize({ dx: 120, dy: 120, shift: false, ctrl: false, t: 0 });
    both.normalize({ dx: 120, dy: 120, shift: false, ctrl: false, t: 10 });
    both.normalize({ dx: 120, dy: 120, shift: false, ctrl: false, t: 20 });
    const out = both.normalize({ dx: 120, dy: 120, shift: false, ctrl: false, t: 30 });
    expect(Math.hypot(out.dx, out.dy)).toBeCloseTo(120);
    expect(out.dx).toBeCloseTo(out.dy);
    // Small deltas (a precision touchpad) and other platforms are left alone.
    expect(w.normalize({ dx: 0, dy: 12, shift: false, ctrl: false, t: 5000 })).toEqual({ dx: 0, dy: 12, source: WHEEL_TRACKPAD });
    const linux = new WheelNormalizer({ mac: false, windows: false });
    expect(linux.normalize({ dx: 0, dy: 120, shift: false, ctrl: false, t: 0 }).dy).toBe(120);
  });

  it("touch pinch: a second touch starts it; the distance ratio zooms about the middle, the middle pans", () => {
    const p = new TouchPinch();
    expect(p.down(1, 100, 100)).toBe(false);
    expect(p.active).toBe(false);
    expect(p.move(1, 110, 100)).toBeNull();
    expect(p.down(2, 210, 100)).toBe(true); // distance 100, middle (160, 100)
    expect(p.active).toBe(true);
    const step = p.move(2, 310, 100)!; // distance 200, middle (210, 100)
    expect(step.ratio).toBeCloseTo(2);
    expect(step.cx).toBe(210);
    expect(step.panX).toBe(50);
    expect(step.panY).toBe(0);
    // One touch lifted: the pinch holds the other until it lifts too.
    expect(p.up(1)).toBe(true);
    expect(p.move(2, 320, 100)).toBeNull();
    expect(p.up(2)).toBe(false);
    expect(p.active).toBe(false);
  });

  it("pinch delta: the engine's e^(−dy · 0.01) zoom gives the ratio back", () => {
    for (const ratio of [0.5, 1, 1.25, 3]) expect(Math.exp(-pinchDelta(ratio) * PINCH_RATE)).toBeCloseTo(ratio);
    expect(pinchDelta(0)).toBe(0);
  });
});
