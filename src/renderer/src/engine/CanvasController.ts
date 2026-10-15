/**
 * Wires a <canvas> to an Engine: pointer events (with capture; a two-finger
 * touch pinch zooms and pans), the wheel (pinch arrives as ctrlKey + wheel;
 * its source and Windows notches by Figma's rules, pointerInput.ts), keys (the engine first, then the
 * shortcut table), focus, the canvas's size in CSS and device pixels, cursors,
 * WebGL context loss and the move to a new canvas after a WebGPU failure.
 * Every event goes straight to the engine — no React state on the way, so
 * input latency is one call.
 *
 * Text editing (docs/engine.md §7.6): while the engine edits a text
 * (TEXT_EDIT active) a hidden <textarea> sits at the caret and has the focus,
 * so the platform's input methods work: its keys go to the engine first
 * (caret moves, deleting, Esc…), typed text arrives as `beforeinput`
 * (engine.textInput), compositions as composition events, and copy / cut /
 * paste as clipboard events on it. Other key handlers ignore it (it is a text
 * field).
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
  WHEEL_TRACKPAD,
} from "./abi";
import { cssCursor } from "./cursors";
import type { Engine } from "./Engine";
import { CLICK_MS, pinchDelta, TouchPinch, WheelNormalizer, withinClickBox } from "./pointerInput";
import { DEFAULT_SHORTCUTS, runShortcut, type Shortcut } from "./shortcuts";

/** After the last zoom step, the canvas goes back to full resolution (the engine's own settle is 120 ms). */
const ZOOM_SETTLE_MS = 150;

export const IS_MAC = typeof navigator !== "undefined" && /Mac|iPhone|iPad/.test(navigator.platform);
export const IS_WINDOWS = typeof navigator !== "undefined" && /Win/.test(navigator.platform);

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
  /** A key the engine didn't use while a text is edited (true: it was taken). */
  onTextKey?: (e: KeyboardEvent) => boolean;
}

export class CanvasController {
  private canvas: HTMLCanvasElement;
  private readonly engine: Engine;
  private readonly shortcuts: readonly Shortcut[];
  private readonly onTextKey?: (e: KeyboardEvent) => boolean;
  private readonly cleanups: (() => void)[] = [];
  /** The canvas's size as last given to the engine (CSS px and backing px), for the zoom's reduced resolution. */
  private size = { cssW: 0, cssH: 0, pxW: 0, pxH: 0, dpr: 1 };
  /** While a zoom goes on: the canvas drawn at half the device pixels (sharp, a quarter of the GPU work); restored
   * ZOOM_SETTLE_MS after the last zoom step. Figma zooms heavy pages at 120 fps and sharp — this is how we keep up
   * (owner's B2C, 40 frames: 119 fps, p95 9.3 ms, against a pixelated scaled cache or 88 fps drawn full). */
  private reduced = false;
  private reducedTimer: ReturnType<typeof setTimeout> | null = null;
  private textarea: HTMLTextAreaElement | null = null;
  private readonly wheelInput = new WheelNormalizer({ mac: IS_MAC, windows: IS_WINDOWS });
  private readonly pinch = new TouchPinch();

  constructor(canvas: HTMLCanvasElement, engine: Engine, options: CanvasControllerOptions = {}) {
    this.canvas = canvas;
    this.engine = engine;
    this.shortcuts = options.shortcuts ?? DEFAULT_SHORTCUTS;
    this.onTextKey = options.onTextKey;
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
    // A WebGPU failure moves the engine to a fresh canvas (Engine.gfxFallback): input follows it.
    this.cleanups.push(
      this.engine.onCanvasChange((fresh) => {
        this.detach();
        this.canvas = fresh;
        this.attach();
      })
    );
    this.listen(window, "blur", this.onBlur);
    this.cleanups.push(this.engine.onCursor((kind, angle) => (c.style.cursor = cssCursor(kind, angle))));
    this.cleanups.push(this.engine.on("TEXT_EDIT", (e) => this.onTextEdit(e.active, e.caretRectCss)));
    this.cleanups.push(() => {
      this.textarea?.remove();
      this.textarea = null;
    });
    this.observeSize();
    // Moves during a gesture are taken once per frame, the latest winning (docs/engine.md §8.4); hover stays immediate.
    this.engine.setCoalesceMoves(true);
    this.cleanups.push(() => this.engine.setCoalesceMoves(false));
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

  /**
   * CSS size + exact backing pixels (device-pixel-content-box where supported). The observer runs after layout and
   * before paint: the drawing buffer is resized (engine_set_viewport) and drawn in that same frame, so a panel
   * resized beside the canvas never shows the canvas blank (WebGL2 clears a resized buffer) or its old picture
   * stretched to the new box (WebGPU) for a frame.
   */
  private observeSize(): void {
    const c = this.canvas;
    let last = "";
    const apply = (cssW: number, cssH: number, pxW: number, pxH: number, draw = true) => {
      if (this.engine.destroyed || cssW <= 0 || cssH <= 0) return;
      const dpr = window.devicePixelRatio || 1;
      const key = `${cssW} ${cssH} ${dpr} ${pxW} ${pxH}`;
      if (key === last) return;
      last = key;
      this.size = { cssW, cssH, pxW: Math.max(1, pxW), pxH: Math.max(1, pxH), dpr };
      if (this.reduced) return; // the zoom's reduced viewport stays until it settles (it is restored at the new size)
      this.engine.setViewport(cssW, cssH, dpr, Math.max(1, pxW), Math.max(1, pxH));
      // (Not at attach: the first frame comes by itself, with nothing on screen to keep.)
      if (draw) this.engine.frameNow();
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
    this.cleanups.push(() => {
      if (this.reducedTimer) clearTimeout(this.reducedTimer);
    });
    const rect = c.getBoundingClientRect();
    const dpr = window.devicePixelRatio || 1;
    apply(rect.width, rect.height, Math.round(rect.width * dpr), Math.round(rect.height * dpr), false);
  }

  private at(e: PointerEvent | WheelEvent): [number, number] {
    const r = this.canvas.getBoundingClientRect();
    return [e.clientX - r.left, e.clientY - r.top];
  }

  // Pointer events carry no click count (detail is 0 in Chromium): counted here by Figma's rule — presses within 500 ms
  // of the last one and less than 4 px from it on each axis (10 for touch), same button.
  private lastDown = { t: -1e9, x: 0, y: 0, button: -1, count: 0 };

  private clickCount(e: PointerEvent): number {
    const [x, y] = this.at(e);
    const l = this.lastDown;
    const near = e.timeStamp - l.t < CLICK_MS && withinClickBox(x - l.x, y - l.y, e.pointerType === "touch") && e.button === l.button;
    const count = Math.max(e.detail || 0, near ? l.count + 1 : 1);
    this.lastDown = { t: e.timeStamp, x, y, button: e.button, count };
    return count;
  }

  private send(type: number, e: PointerEvent): number {
    const [x, y] = this.at(e);
    const clicks = type === PointerType.DOWN ? this.clickCount(e) : this.lastDown.count || 1;
    return this.engine.pointer(type, x, y, e.button, e.buttons, modifiersOf(e), e.pressure, clicks, POINTER_KIND[e.pointerType] ?? 0, e.timeStamp);
  }

  private readonly onPointerDown = (e: PointerEvent) => {
    if (!this.engine.textEdit) this.canvas.focus({ preventScroll: true });
    if (e.pointerType === "touch") {
      const [x, y] = this.at(e);
      // A second touch: the two are a pinch from now on; the first one's gesture goes back to where it started.
      if (this.pinch.down(e.pointerId, x, y)) this.send(PointerType.CANCEL, e);
      if (this.pinch.active) {
        this.canvas.setPointerCapture(e.pointerId);
        e.preventDefault();
        return;
      }
    }
    const r = this.send(PointerType.DOWN, e);
    if (r & POINTER_CAPTURE) this.canvas.setPointerCapture(e.pointerId);
    if (r & POINTER_HANDLED) e.preventDefault();
    // Still (or now) editing text: its field keeps the keyboard.
    if (this.engine.textEdit) this.textarea?.focus({ preventScroll: true });
  };

  // ---- Text editing: the hidden field at the caret ----

  private onTextEdit(active: boolean, caret: { x: number; y: number; width: number; height: number }): void {
    if (!active) {
      if (this.textarea && document.activeElement === this.textarea) this.canvas.focus({ preventScroll: true });
      return;
    }
    const t = this.ensureTextarea();
    const r = this.canvas.getBoundingClientRect();
    t.style.left = `${Math.round(r.left + caret.x)}px`;
    t.style.top = `${Math.round(r.top + caret.y)}px`;
    t.style.height = `${Math.max(1, Math.round(caret.height))}px`;
    if (document.activeElement !== t) t.focus({ preventScroll: true });
  }

  private ensureTextarea(): HTMLTextAreaElement {
    if (this.textarea) return this.textarea;
    const t = document.createElement("textarea");
    t.setAttribute("aria-label", "Text");
    t.setAttribute("data-canvas-text", ""); // the canvas's own field (editor/desktop.ts menuCommandInField)
    t.setAttribute("autocomplete", "off");
    t.setAttribute("autocorrect", "off");
    t.setAttribute("autocapitalize", "off");
    t.spellcheck = false;
    Object.assign(t.style, {
      position: "fixed", width: "1px", padding: "0", border: "0", margin: "0", outline: "none", resize: "none",
      overflow: "hidden", opacity: "0", pointerEvents: "none", whiteSpace: "pre", fontSize: "12px", zIndex: "0",
    } satisfies Partial<CSSStyleDeclaration>);
    const on = <K extends keyof HTMLElementEventMap>(type: K, handler: (e: HTMLElementEventMap[K]) => void) => {
      t.addEventListener(type, handler);
      this.cleanups.push(() => t.removeEventListener(type, handler));
    };
    on("keydown", (e) => {
      if (e.isComposing || e.keyCode === 229) return;
      if (this.engine.key("down", e.code, e.key, modifiersOf(e), e.repeat) & KEY_HANDLED) {
        e.preventDefault();
        e.stopPropagation();
      } else if (this.onTextKey?.(e)) {
        e.preventDefault();
        e.stopPropagation();
      }
    });
    on("keyup", (e) => {
      if (this.engine.key("up", e.code, e.key, modifiersOf(e)) & KEY_HANDLED) e.preventDefault();
    });
    on("beforeinput", (e) => {
      if (e.isComposing) return;
      if (e.inputType === "insertText" || e.inputType === "insertReplacementText") {
        e.preventDefault();
        const text = e.data ?? e.dataTransfer?.getData("text/plain") ?? "";
        if (text) this.engine.textInput(text);
      } else if (e.inputType !== "insertCompositionText") {
        e.preventDefault(); // deletes and line breaks come as keys; paste as the paste event
      }
    });
    on("compositionupdate", (e) => {
      const data = e.data ?? "";
      this.engine.textComposition(data, data.length, data.length);
    });
    on("compositionend", (e) => {
      this.engine.textCompositionEnd(e.data ?? "");
      t.value = "";
    });
    on("copy", (e) => {
      e.preventDefault();
      e.stopPropagation();
      e.clipboardData?.setData("text/plain", this.engine.textSelection());
    });
    on("cut", (e) => {
      e.preventDefault();
      e.stopPropagation();
      e.clipboardData?.setData("text/plain", this.engine.textSelection());
      this.engine.textInput("");
    });
    on("paste", (e) => {
      e.preventDefault();
      e.stopPropagation();
      const text = e.clipboardData?.getData("text/plain") ?? "";
      if (text) this.engine.textInput(text.replace(/\r\n?/g, "\n"));
    });
    document.body.appendChild(t);
    this.textarea = t;
    return t;
  }
  private readonly onPointerMove = (e: PointerEvent) => {
    if (e.pointerType === "touch" && this.pinchMove(e)) return;
    this.send(PointerType.MOVE, e);
  };
  private readonly onPointerUp = (e: PointerEvent) => {
    if (e.pointerType === "touch" && this.pinchEnd(e)) return;
    if (this.send(PointerType.UP, e) & POINTER_HANDLED) e.preventDefault();
  };
  private readonly onPointerCancel = (e: PointerEvent) => {
    if (e.pointerType === "touch" && this.pinchEnd(e)) return;
    this.send(PointerType.CANCEL, e);
  };

  /** A touch of a pinch moved: zoom about the touches' middle by their distance's ratio, pan by its move. */
  private pinchMove(e: PointerEvent): boolean {
    const [x, y] = this.at(e);
    const step = this.pinch.move(e.pointerId, x, y);
    if (!this.pinch.active) return false;
    if (!step) return true;
    if (step.panX || step.panY) {
      const c = this.engine.getCamera();
      this.engine.setCamera({ ...c, x: c.x + step.panX, y: c.y + step.panY });
    }
    if (step.ratio !== 1) this.engine.wheel(step.cx, step.cy, 0, pinchDelta(step.ratio), 0, modifiersOf(e), WHEEL_PINCH | WHEEL_TRACKPAD);
    return true;
  }

  /** A touch of a pinch lifted: true when it was one (nothing goes to the engine). */
  private pinchEnd(e: PointerEvent): boolean {
    const was = this.pinch.active;
    this.pinch.up(e.pointerId);
    return was;
  }
  private readonly onPointerEnter = (e: PointerEvent) => void this.send(PointerType.ENTER, e);
  private readonly onPointerLeave = (e: PointerEvent) => void this.send(PointerType.LEAVE, e);

  private readonly onWheel = (e: WheelEvent) => {
    e.preventDefault();
    const [x, y] = this.at(e);
    // The source (trackpad or mouse), Shift's axis swap off the Mac and Windows notches: Figma's rules.
    const w = this.wheelInput.normalize({ dx: e.deltaX, dy: e.deltaY, shift: e.shiftKey, ctrl: e.ctrlKey, t: e.timeStamp });
    // A trackpad pinch arrives as a wheel event with ctrlKey set.
    if (e.ctrlKey || e.metaKey) this.zoomResolution();
    this.engine.wheel(x, y, w.dx, w.dy, e.deltaMode, modifiersOf(e), (e.ctrlKey ? WHEEL_PINCH : 0) | w.source);
  };

  /** A zoom step: the canvas drawn at half its device pixels until the zoom settles (Retina only). */
  private zoomResolution(): void {
    const s = this.size;
    if (s.dpr < 1.5 || s.cssW <= 0) return;
    if (!this.reduced) {
      this.reduced = true;
      this.engine.setViewport(s.cssW, s.cssH, s.dpr / 2, Math.max(1, Math.round(s.pxW / 2)), Math.max(1, Math.round(s.pxH / 2)));
    }
    if (this.reducedTimer) clearTimeout(this.reducedTimer);
    this.reducedTimer = setTimeout(() => {
      this.reducedTimer = null;
      this.reduced = false;
      if (this.engine.destroyed) return;
      const n = this.size;
      this.engine.setViewport(n.cssW, n.cssH, n.dpr, n.pxW, n.pxH);
      this.engine.frameNow();
    }, ZOOM_SETTLE_MS);
  }

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
