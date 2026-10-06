/**
 * Wires a <canvas> to an Engine: pointer events (with capture), the wheel
 * (pinch arrives as ctrlKey + wheel), keys (the engine first, then the
 * shortcut table), focus, the canvas's size in CSS and device pixels, cursors
 * and WebGL context loss. Every event goes straight to the engine — no React
 * state on the way, so input latency is one call.
 */
import {
  KEY_HANDLED,
  MOD_ALT,
  MOD_CTRL,
  MOD_META,
  MOD_PRIMARY,
  MOD_SHIFT,
  POINTER_CAPTURE,
  POINTER_HANDLED,
  PointerType,
  WHEEL_PINCH,
} from "./abi";
import { cssCursor } from "./cursors";
import type { Engine } from "./Engine";
import { DEFAULT_SHORTCUTS, runShortcut, type Shortcut } from "./shortcuts";

export const IS_MAC = typeof navigator !== "undefined" && /Mac|iPhone|iPad/.test(navigator.platform);

/** The modifier bits of an event (PRIMARY = ⌘ on a Mac, Ctrl elsewhere). */
export function modifiersOf(e: { shiftKey: boolean; altKey: boolean; ctrlKey: boolean; metaKey: boolean }): number {
  return (
    (e.shiftKey ? MOD_SHIFT : 0) |
    (e.altKey ? MOD_ALT : 0) |
    (e.ctrlKey ? MOD_CTRL : 0) |
    (e.metaKey ? MOD_META : 0) |
    ((IS_MAC ? e.metaKey : e.ctrlKey) ? MOD_PRIMARY : 0)
  );
}

const POINTER_KIND: Record<string, number> = { mouse: 0, pen: 1, touch: 2 };

export interface CanvasControllerOptions {
  shortcuts?: readonly Shortcut[];
}

export class CanvasController {
  private readonly canvas: HTMLCanvasElement;
  private readonly engine: Engine;
  private readonly shortcuts: readonly Shortcut[];
  private readonly cleanups: (() => void)[] = [];

  constructor(canvas: HTMLCanvasElement, engine: Engine, options: CanvasControllerOptions = {}) {
    this.canvas = canvas;
    this.engine = engine;
    this.shortcuts = options.shortcuts ?? DEFAULT_SHORTCUTS;
  }

  /** Starts listening; returns the detach. */
  attach(): () => void {
    const c = this.canvas;
    c.tabIndex = 0;
    c.style.touchAction = "none";
    c.style.outline = "none";
    this.listen(c, "pointerdown", this.onPointerDown);
    this.listen(c, "pointermove", this.onPointerMove);
    this.listen(c, "pointerup", this.onPointerUp);
    this.listen(c, "pointercancel", this.onPointerCancel);
    this.listen(c, "pointerenter", this.onPointerEnter);
    this.listen(c, "pointerleave", this.onPointerLeave);
    this.listen(c, "wheel", this.onWheel, { passive: false });
    this.listen(c, "keydown", this.onKeyDown);
    this.listen(c, "keyup", this.onKeyUp);
    this.listen(c, "blur", this.onBlur);
    this.listen(c, "contextmenu", (e: Event) => e.preventDefault());
    this.listen(c, "webglcontextlost", this.onContextLost);
    this.listen(c, "webglcontextrestored", this.onContextRestored);
    this.listen(window, "blur", this.onBlur);
    this.cleanups.push(this.engine.onCursor((kind, angle) => (c.style.cursor = cssCursor(kind, angle))));
    this.observeSize();
    return () => this.detach();
  }

  detach(): void {
    for (const cleanup of this.cleanups.splice(0)) cleanup();
  }

  private listen<E extends Event>(target: EventTarget, type: string, handler: (e: E) => void, options?: AddEventListenerOptions): void {
    const h = handler as EventListener;
    target.addEventListener(type, h, options);
    this.cleanups.push(() => target.removeEventListener(type, h, options));
  }

  /** CSS size + exact backing pixels (device-pixel-content-box where supported). */
  private observeSize(): void {
    const c = this.canvas;
    const apply = (cssW: number, cssH: number, pxW: number, pxH: number) => {
      if (this.engine.destroyed || cssW <= 0 || cssH <= 0) return;
      this.engine.setViewport(cssW, cssH, window.devicePixelRatio || 1, Math.max(1, pxW), Math.max(1, pxH));
    };
    const observer = new ResizeObserver((entries) => {
      const entry = entries[entries.length - 1];
      const css = entry.contentBoxSize?.[0];
      const cssW = css ? css.inlineSize : entry.contentRect.width;
      const cssH = css ? css.blockSize : entry.contentRect.height;
      const device = entry.devicePixelContentBoxSize?.[0];
      const dpr = window.devicePixelRatio || 1;
      // The exact backing size when the browser knows it; it only ever differs from css × dpr by rounding
      // (an emulated device scale reports CSS pixels there: fall back to css × dpr then).
      const exact = (px: number | undefined, css: number) => (px !== undefined && Math.abs(px - css * dpr) <= 2 ? px : Math.round(css * dpr));
      apply(cssW, cssH, exact(device?.inlineSize, cssW), exact(device?.blockSize, cssH));
    });
    try {
      observer.observe(c, { box: "device-pixel-content-box" });
    } catch {
      observer.observe(c);
    }
    this.cleanups.push(() => observer.disconnect());
    const rect = c.getBoundingClientRect();
    const dpr = window.devicePixelRatio || 1;
    apply(rect.width, rect.height, Math.round(rect.width * dpr), Math.round(rect.height * dpr));
  }

  private at(e: PointerEvent | WheelEvent): [number, number] {
    const r = this.canvas.getBoundingClientRect();
    return [e.clientX - r.left, e.clientY - r.top];
  }

  private send(type: number, e: PointerEvent): number {
    const [x, y] = this.at(e);
    return this.engine.pointer(type, x, y, e.button, e.buttons, modifiersOf(e), e.pressure, e.detail || 1, POINTER_KIND[e.pointerType] ?? 0, e.timeStamp);
  }

  private readonly onPointerDown = (e: PointerEvent) => {
    this.canvas.focus({ preventScroll: true });
    const r = this.send(PointerType.DOWN, e);
    if (r & POINTER_CAPTURE) this.canvas.setPointerCapture(e.pointerId);
    if (r & POINTER_HANDLED) e.preventDefault();
  };
  private readonly onPointerMove = (e: PointerEvent) => void this.send(PointerType.MOVE, e);
  private readonly onPointerUp = (e: PointerEvent) => {
    if (this.send(PointerType.UP, e) & POINTER_HANDLED) e.preventDefault();
  };
  private readonly onPointerCancel = (e: PointerEvent) => void this.send(PointerType.CANCEL, e);
  private readonly onPointerEnter = (e: PointerEvent) => void this.send(PointerType.ENTER, e);
  private readonly onPointerLeave = (e: PointerEvent) => void this.send(PointerType.LEAVE, e);

  private readonly onWheel = (e: WheelEvent) => {
    e.preventDefault();
    const [x, y] = this.at(e);
    // A trackpad pinch arrives as a wheel event with ctrlKey set.
    this.engine.wheel(x, y, e.deltaX, e.deltaY, e.deltaMode, modifiersOf(e), e.ctrlKey ? WHEEL_PINCH : 0);
  };

  private readonly onKeyDown = (e: KeyboardEvent) => {
    if (e.isComposing) return;
    const mods = modifiersOf(e);
    if (this.engine.key("down", e.code, e.key, mods, e.repeat) & KEY_HANDLED) {
      e.preventDefault();
      return;
    }
    if (runShortcut(this.shortcuts, e, (mods & MOD_PRIMARY) !== 0, this.engine)) e.preventDefault();
  };

  private readonly onKeyUp = (e: KeyboardEvent) => {
    if (this.engine.key("up", e.code, e.key, modifiersOf(e)) & KEY_HANDLED) e.preventDefault();
  };

  private readonly onBlur = () => this.engine.blur();

  private readonly onContextLost = (e: Event) => {
    e.preventDefault(); // allows the restore
    this.engine.contextLost();
  };

  private readonly onContextRestored = () => this.engine.contextRestored();
}
