/**
 * Wires a <canvas> to an Engine: pointer events (with capture), the wheel
 * (pinch arrives as ctrlKey + wheel), keys (the engine first, then the
 * shortcut table), focus, the canvas's size in CSS and device pixels, cursors
 * and WebGL context loss. Every event goes straight to the engine — no React
 * state on the way, so input latency is one call.
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
  /** A key the engine didn't use while a text is edited (true: it was taken). */
  onTextKey?: (e: KeyboardEvent) => boolean;
}

export class CanvasController {
  private readonly canvas: HTMLCanvasElement;
  private readonly engine: Engine;
  private readonly shortcuts: readonly Shortcut[];
  private readonly onTextKey?: (e: KeyboardEvent) => boolean;
  private readonly cleanups: (() => void)[] = [];
  private textarea: HTMLTextAreaElement | null = null;

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
    this.listen(window, "blur", this.onBlur);
    this.cleanups.push(this.engine.onCursor((kind, angle) => (c.style.cursor = cssCursor(kind, angle))));
    this.cleanups.push(this.engine.on("TEXT_EDIT", (e) => this.onTextEdit(e.active, e.caretRectCss)));
    this.cleanups.push(() => {
      this.textarea?.remove();
      this.textarea = null;
    });
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

  // Pointer events carry no click count (detail is 0 in Chromium): counted here, as the OS does for clicks —
  // presses within 500 ms and 4 px of the last one, same button.
  private lastDown = { t: -1e9, x: 0, y: 0, button: -1, count: 0 };

  private clickCount(e: PointerEvent): number {
    const [x, y] = this.at(e);
    const l = this.lastDown;
    const near = e.timeStamp - l.t < 500 && Math.hypot(x - l.x, y - l.y) <= 4 && e.button === l.button;
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
