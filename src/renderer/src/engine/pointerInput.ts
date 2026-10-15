/**
 * The canvas's input rules that are Figma's, kept out of CanvasController so they can be tested
 * (docs/research/rea/canvas.md §2.13, §2.14; docs/engine.md §8.4):
 *
 * - **Wheel source.** Figma's Chrome / Safari rule: a trackpad gives whole-number deltas on both axes, a Mac mouse wheel
 *   fractional ones. Electron is Chrome ≥ 118, so the deltas are not divided by the device pixel ratio.
 * - **Notch wheels (Windows).** A delta of 99 or more on an axis is a wheel notch: d / 120 × an acceleration factor
 *   of 8, or 2.5 × the last factor when the last notch came under 50 ms ago in the same directions; the vector is then
 *   clamped to a length of 120 (40 with Ctrl, a zoom).
 * - **Shift** swaps the axes off the Mac (macOS already turns a Shift + mouse wheel sideways).
 * - **Click count.** A press within 500 ms of the last one and less than 4 px from it on each axis (a box, not a
 *   circle); 10 px for touch.
 * - **Touch pinch.** Two touches: the ratio of their distances zooms about their middle (as a pinch's wheel event,
 *   `log(ratio) / log(base)` with the engine's pinch base e^−0.01), and their middle moving pans.
 */
import { WHEEL_MOUSE, WHEEL_TRACKPAD } from "./abi";

/** Figma's double-click window and box. */
export const CLICK_MS = 500;
export const CLICK_BOX = 4;
export const CLICK_BOX_TOUCH = 10;

/** Windows notch wheels (Figma's figma_app wheel listener). */
export const NOTCH_MIN = 99;
export const NOTCH_UNIT = 120;
export const NOTCH_FACTOR = 8;
export const NOTCH_ACCELERATION = 2.5;
export const NOTCH_REPEAT_MS = 50;
export const NOTCH_CLAMP = 120;
export const NOTCH_CLAMP_ZOOM = 40;

/** The engine's pinch zoom rate per pixel of wheel delta (Gestures.cpp Editor::wheel: zoom × e^(−dy · 0.01)). */
export const PINCH_RATE = 0.01;

/** True when a press `dx`, `dy` from the last one (and soon enough) continues its click count: a box on each axis. */
export function withinClickBox(dx: number, dy: number, touch = false): boolean {
  const box = touch ? CLICK_BOX_TOUCH : CLICK_BOX;
  return Math.abs(dx) < box && Math.abs(dy) < box;
}

/** WHEEL_TRACKPAD or WHEEL_MOUSE by Figma's Chrome rule: whole-number deltas on both axes are a trackpad's. */
export function wheelSource(dx: number, dy: number): number {
  return Number.isInteger(dx) && Number.isInteger(dy) ? WHEEL_TRACKPAD : WHEEL_MOUSE;
}

export interface WheelInput {
  dx: number;
  dy: number;
  shift: boolean;
  ctrl: boolean;
  /** The event's timeStamp (ms). */
  t: number;
}

export interface WheelOutput {
  dx: number;
  dy: number;
  /** WHEEL_TRACKPAD or WHEEL_MOUSE. */
  source: number;
}

/** One canvas's wheel: the source, Shift's axis swap off the Mac, and the Windows notch acceleration (stateful). */
export class WheelNormalizer {
  private last = { t: -Infinity, sx: 0, sy: 0, factor: NOTCH_FACTOR };

  constructor(private readonly platform: { mac: boolean; windows: boolean }) {}

  normalize(e: WheelInput): WheelOutput {
    let { dx, dy } = e;
    if (e.shift && !this.platform.mac) [dx, dy] = [dy, dx];
    let source = wheelSource(dx, dy);
    if (this.platform.windows && (Math.abs(dx) >= NOTCH_MIN || Math.abs(dy) >= NOTCH_MIN)) {
      const sx = Math.sign(dx), sy = Math.sign(dy);
      const l = this.last;
      const repeat = e.t - l.t < NOTCH_REPEAT_MS && sx === l.sx && sy === l.sy;
      // Bounded: the clamp below caps what a fast spin gives long before the factor matters.
      const factor = repeat ? Math.min(l.factor * NOTCH_ACCELERATION, 1e4) : NOTCH_FACTOR;
      this.last = { t: e.t, sx, sy, factor };
      dx = (dx / NOTCH_UNIT) * factor;
      dy = (dy / NOTCH_UNIT) * factor;
      const max = e.ctrl ? NOTCH_CLAMP_ZOOM : NOTCH_CLAMP;
      const length = Math.hypot(dx, dy);
      if (length > max) {
        dx = (dx / length) * max;
        dy = (dy / length) * max;
      }
      source = WHEEL_MOUSE;
    }
    return { dx, dy, source };
  }
}

/** The wheel delta a pinch's wheel event carries for a zoom by `ratio` (the engine zooms by e^(−dy · PINCH_RATE)). */
export function pinchDelta(ratio: number): number {
  return ratio > 0 && Number.isFinite(ratio) ? -Math.log(ratio) / PINCH_RATE : 0;
}

export interface PinchStep {
  /** The two touches' middle now (canvas CSS px): the zoom's fixed point. */
  cx: number;
  cy: number;
  /** Their distance now ÷ at the last step. */
  ratio: number;
  /** How far their middle moved since the last step (CSS px). */
  panX: number;
  panY: number;
}

/**
 * Touches on the canvas. One touch is a pointer like any other; a second one turns them into a pinch, which lasts until
 * every touch has lifted (a touch left alone after a pinch doesn't start a gesture).
 */
export class TouchPinch {
  private readonly touches = new Map<number, { x: number; y: number }>();
  private pinching = false;
  private lastMid = { x: 0, y: 0 };
  private lastDistance = 0;

  /** True while the touches are a pinch: their events don't go to the engine as pointer events. */
  get active(): boolean {
    return this.pinching;
  }

  /** A touch went down. True when it starts a pinch (the first touch's gesture should be cancelled). */
  down(id: number, x: number, y: number): boolean {
    this.touches.set(id, { x, y });
    if (this.pinching || this.touches.size < 2) return false;
    this.pinching = true;
    this.measure();
    return true;
  }

  /** A touch moved: the pinch's step, or null (not pinching, or not one of the two). */
  move(id: number, x: number, y: number): PinchStep | null {
    const t = this.touches.get(id);
    if (!t) return null;
    t.x = x;
    t.y = y;
    if (!this.pinching || this.touches.size < 2) return null;
    const before = { mid: this.lastMid, distance: this.lastDistance };
    this.measure();
    return {
      cx: this.lastMid.x,
      cy: this.lastMid.y,
      ratio: before.distance > 0 && this.lastDistance > 0 ? this.lastDistance / before.distance : 1,
      panX: this.lastMid.x - before.mid.x,
      panY: this.lastMid.y - before.mid.y,
    };
  }

  /** A touch lifted (or was cancelled). True while the pinch still holds the remaining touches. */
  up(id: number): boolean {
    this.touches.delete(id);
    if (this.touches.size === 0) this.pinching = false;
    else if (this.pinching && this.touches.size >= 2) this.measure();
    return this.pinching;
  }

  private measure(): void {
    const [a, b] = [...this.touches.values()];
    this.lastMid = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
    this.lastDistance = Math.hypot(a.x - b.x, a.y - b.y);
  }
}
