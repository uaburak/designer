/**
 * The inline preview's window as Figma's (live 2026-10-20, docs/research/figma/live/2026-10-20/prototype-preview.txt):
 * its first size and place, the header kept on screen, resizing, the menu's two resizes and the header's buttons.
 */
import { describe, expect, it } from "vitest";
import {
  HEADER,
  actualViewerSize,
  aspectViewerSize,
  breakpointOf,
  headerButtons,
  initialBox,
  initialViewerSize,
  keepHeaderOnScreen,
  resizeBox,
  sameSize,
} from "../inlinePreviewLayout";

// Live: a 1440 × 900 window with Figma's panels — the visible canvas 298…1199 (901 wide), 900 high.
const VIEW = { left: 298, top: 0, width: 901, height: 900 };

describe("the inline preview's window", () => {
  it("opens 16 in from the visible canvas at a phone frame's own size (live: 314,16 375 × 853)", () => {
    const frame = { x: 375, y: 812 };
    const viewer = initialViewerSize(breakpointOf(frame, null), frame, VIEW);
    expect(viewer).toEqual({ x: 375, y: 812 });
    expect(initialBox(viewer, VIEW)).toEqual({ x: 314, y: 16, w: 375, h: 853 });
  });

  it("shows a frame 1280 wide or more at 16:9, in half the canvas's width (live: 1440 × 1024 → 450.5 × 294.5)", () => {
    const frame = { x: 1440, y: 1024 };
    const bp = breakpointOf(frame, null);
    expect(bp).toEqual({ type: "WEBSITE" });
    const viewer = initialViewerSize(bp, frame, VIEW);
    expect(viewer.x).toBeCloseTo(450.5, 5);
    expect(viewer.y + HEADER).toBeCloseTo(294.4, 1);
  });

  it("fits a tall frame into the canvas's height less 73, and never goes under 104 × 20", () => {
    const tall = { x: 375, y: 2000 };
    const v = initialViewerSize(breakpointOf(tall, null), tall, VIEW);
    expect(v.y).toBeCloseTo(900 - HEADER - 32, 5);
    expect(v.x / v.y).toBeCloseTo(375 / 2000, 5);
    // Narrower than 104 that way: the width stops at 104 and the height follows (Figma's own rule).
    const taller = { x: 375, y: 3000 };
    expect(initialViewerSize(breakpointOf(taller, null), taller, VIEW)).toEqual({ x: 104, y: 832 });
    const tiny = { x: 20, y: 10 };
    expect(initialViewerSize(breakpointOf(tiny, null), tiny, VIEW)).toEqual({ x: 104, y: 52 });
  });

  it("uses the page's device screen", () => {
    const frame = { x: 1440, y: 1024 };
    const v = initialViewerSize(breakpointOf(frame, { x: 393, y: 852 }), frame, VIEW);
    expect(v.y).toBe(900 - 73);
    expect(v.x).toBeCloseTo((393 * (900 - 73)) / 852, 5);
  });

  it("keeps its header on screen when dragged: top 0 … height − 57, 40 px of it across", () => {
    const view = { width: 1440, height: 900 };
    expect(keepHeaderOnScreen({ x: 1500, y: 950, w: 375, h: 853 }, view)).toEqual({ x: 1400, y: 843, w: 375, h: 853 });
    expect(keepHeaderOnScreen({ x: -500, y: -20, w: 375, h: 853 }, view)).toEqual({ x: -335, y: 0, w: 375, h: 853 });
    expect(keepHeaderOnScreen({ x: -156, y: 10, w: 375, h: 853 }, view)).toEqual({ x: -156, y: 10, w: 375, h: 853 });
  });

  it("resizes from its edges down to 104 × 61, ⇧ keeping the viewer's proportions (live)", () => {
    const start = { x: 384, y: 52, w: 375, h: 853 };
    expect(resizeBox(start, "right", -150, 0, false)).toEqual({ x: 384, y: 52, w: 225, h: 853 });
    expect(resizeBox(start, "right", -500, 0, false).w).toBe(104);
    expect(resizeBox(start, "top", 0, 2000, false)).toEqual({ x: 384, y: 52 + 853 - 61, w: 375, h: 61 });
    expect(resizeBox(start, "left", -100, 0, false)).toEqual({ x: 284, y: 52, w: 475, h: 853 });
    // Live: 234 × 361 dragged +100, +100 with ⇧ → 307 × 461.
    const b = resizeBox({ x: 84, y: 343, w: 234, h: 361 }, "bottom-right", 100, 100, true);
    expect(b.h).toBeCloseTo(461, 5);
    expect(b.w).toBeCloseTo(234 * (420 / 320), 5);
  });

  it("Resize window to 100% and Reset aspect ratio (live: 175 wide → 175 × 420)", () => {
    const frame = { x: 375, y: 812 };
    const bp = breakpointOf(frame, null);
    expect(actualViewerSize(bp, frame)).toEqual(frame);
    const reset = aspectViewerSize({ x: 175, y: 812 }, bp, frame);
    expect(reset.x).toBe(175);
    expect(reset.y + HEADER).toBeCloseTo(419.9, 1);
    expect(aspectViewerSize({ x: 475, y: 1107 }, bp, frame)).toEqual(frame);
    expect(sameSize({ x: 375.2, y: 811.8 }, frame)).toBe(true);
  });

  it("keeps fewer header buttons when narrow (live: 6 from 217, 4 from 153, else 2)", () => {
    expect(headerButtons(375)).toBe(6);
    expect(headerButtons(217)).toBe(6);
    expect(headerButtons(216)).toBe(4);
    expect(headerButtons(153)).toBe(4);
    expect(headerButtons(152)).toBe(2);
  });
});
