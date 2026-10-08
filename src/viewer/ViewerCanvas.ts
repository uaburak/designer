/**
 * The viewer's canvas input (read-only; docs/engine.md §10.8's viewer mode in TS): the engine sees hovers, clicks and
 * the wheel, never a drag — a drag pans the canvas (as the Hand tool), so nothing can move. A click goes to the engine
 * as a press and release in place (Figma's selection rules: the top-level layer first, ⌘ deep select, ⇧ adds); a
 * double-click selects one level deeper under the pointer. Keys: ⇧1 zoom to fit, ⇧2 zoom to selection, ⌘+ / ⌘−,
 * ⇧0 / ⌘0 100 %, Esc selects the parent (or nothing).
 */
import { MOD_PRIMARY, PointerType, WHEEL_PINCH } from "@/engine/abi";
import { modifiersOf } from "@/engine/CanvasController";
import { cssCursor } from "@/engine/cursors";
import type { Engine } from "@/engine/Engine";
import type { Guid } from "@/engine/codec";

const DRAG_SLOP = 3;

export interface ViewerCanvasOptions {
  /** The parent of a layer (null at the top of the page), for Esc and double-click */
  parentOf(id: Guid): Guid | null;
}

export function attachViewerCanvas(canvas: HTMLCanvasElement, engine: Engine, opts: ViewerCanvasOptions): () => void {
  const offs: (() => void)[] = [];
  const on = <E extends Event>(target: EventTarget, type: string, fn: (e: E) => void, o?: AddEventListenerOptions) => {
    target.addEventListener(type, fn as EventListener, o);
    offs.push(() => target.removeEventListener(type, fn as EventListener, o));
  };
  canvas.tabIndex = 0;
  canvas.style.touchAction = "none";
  canvas.style.outline = "none";
  let cursor = "default";
  offs.push(engine.onCursor((kind, angle) => (cursor = cssCursor(kind, angle))));
  const setCursor = (c: string) => (canvas.style.cursor = c);

  const at = (e: { clientX: number; clientY: number }): [number, number] => {
    const r = canvas.getBoundingClientRect();
    return [e.clientX - r.left, e.clientY - r.top];
  };

  let press: { id: number; x: number; y: number; cx: number; cy: number; button: number; panning: boolean; camera: { x: number; y: number; zoom: number } } | null = null;
  let space = false;

  on<PointerEvent>(canvas, "pointerdown", (e) => {
    canvas.focus({ preventScroll: true });
    if (press) return;
    const [x, y] = at(e);
    press = { id: e.pointerId, x, y, cx: e.clientX, cy: e.clientY, button: e.button, panning: e.button === 1 || space, camera: engine.getCamera() };
    canvas.setPointerCapture(e.pointerId);
    if (press.panning) setCursor("grabbing");
    e.preventDefault();
  });
  on<PointerEvent>(canvas, "pointermove", (e) => {
    const [x, y] = at(e);
    if (!press) {
      engine.pointer(PointerType.MOVE, x, y, 0, 0, modifiersOf(e));
      setCursor(space ? "grab" : cursor);
      return;
    }
    if (e.pointerId !== press.id) return;
    const dx = e.clientX - press.cx;
    const dy = e.clientY - press.cy;
    if (!press.panning && Math.hypot(dx, dy) > DRAG_SLOP) {
      press.panning = true;
      setCursor("grabbing");
    }
    if (press.panning) engine.setCamera({ ...press.camera, x: press.camera.x + dx, y: press.camera.y + dy });
  });
  let last = { t: -1e9, x: 0, y: 0 };
  const finish = (e: PointerEvent, cancelled: boolean) => {
    if (!press || e.pointerId !== press.id) return;
    const p = press;
    press = null;
    if (canvas.hasPointerCapture(e.pointerId)) canvas.releasePointerCapture(e.pointerId);
    setCursor(space ? "grab" : cursor);
    if (cancelled || p.panning || p.button !== 0) return;
    const double = e.timeStamp - last.t < 500 && Math.hypot(p.x - last.x, p.y - last.y) <= 4;
    last = double ? { t: -1e9, x: 0, y: 0 } : { t: e.timeStamp, x: p.x, y: p.y };
    if (double && deeper(p.x, p.y)) return;
    const mods = modifiersOf(e);
    engine.pointer(PointerType.DOWN, p.x, p.y, 0, 1, mods, 0.5, 1, 0, e.timeStamp);
    engine.pointer(PointerType.UP, p.x, p.y, 0, 0, mods, 0, 1, 0, e.timeStamp);
  };
  on<PointerEvent>(canvas, "pointerup", (e) => finish(e, false));
  on<PointerEvent>(canvas, "pointercancel", (e) => finish(e, true));
  on<PointerEvent>(canvas, "pointerleave", (e) => {
    if (!press) engine.pointer(PointerType.LEAVE, ...at(e), 0, 0, 0);
  });

  /** Double-click: the layer one level under the selected one at the point. */
  function deeper(x: number, y: number): boolean {
    const hits = engine.hitTest(x, y);
    const selected = engine.getSelection().refs;
    if (selected.length !== 1) return false;
    for (const hit of hits) {
      let id: Guid | null = hit;
      while (id) {
        const parent = opts.parentOf(id);
        if (parent === selected[0]) {
          engine.setSelection([id]);
          return true;
        }
        id = parent;
      }
    }
    return false;
  }

  on<WheelEvent>(
    canvas,
    "wheel",
    (e) => {
      e.preventDefault();
      const [x, y] = at(e);
      engine.wheel(x, y, e.deltaX, e.deltaY, e.deltaMode, modifiersOf(e), e.ctrlKey ? WHEEL_PINCH : 0);
    },
    { passive: false },
  );
  on<MouseEvent>(canvas, "contextmenu", (e) => e.preventDefault());

  // Keys anywhere in the viewer but its fields, menus and dialogs (Dev Mode's shortcuts work with a layer row focused).
  const ownKeys = (e: KeyboardEvent) => {
    const t = e.target as Element | null;
    return !t?.closest?.('input,textarea,[contenteditable],[role="dialog"],[role="listbox"],[role="combobox"],[role="menu"]');
  };
  on<KeyboardEvent>(window, "keydown", (e) => {
    if (!ownKeys(e)) return;
    const mods = modifiersOf(e);
    const primary = (mods & MOD_PRIMARY) !== 0;
    if (e.code === "Space" && !e.repeat) {
      space = true;
      setCursor("grab");
      e.preventDefault();
      return;
    }
    let handled = true;
    if (e.shiftKey && e.code === "Digit1") engine.command("ZOOM_TO_FIT");
    else if (e.shiftKey && e.code === "Digit2") engine.command("ZOOM_TO_SELECTION");
    else if ((e.shiftKey && e.code === "Digit0") || (primary && e.code === "Digit0")) engine.command("ZOOM_TO_100");
    else if ((primary && (e.key === "=" || e.key === "+")) || (!primary && e.key === "+")) engine.command("ZOOM_IN");
    else if ((primary && e.key === "-") || (!primary && e.key === "-")) engine.command("ZOOM_OUT");
    else if (e.key === "Escape") {
      const sel = engine.getSelection().refs;
      const parent = sel.length === 1 ? opts.parentOf(sel[0]) : null;
      engine.setSelection(parent ? [parent] : []);
    } else handled = false;
    if (handled) e.preventDefault();
  });
  on<KeyboardEvent>(window, "keyup", (e) => {
    if (e.code === "Space") {
      space = false;
      setCursor(cursor);
    }
  });
  on<FocusEvent>(canvas, "blur", () => {
    space = false;
    engine.blur();
  });
  on<Event>(canvas, "webglcontextlost", (e) => {
    e.preventDefault();
    engine.contextLost();
  });
  on<Event>(canvas, "webglcontextrestored", () => engine.contextRestored());

  // The canvas's size in CSS and device pixels.
  const resize = () => {
    const r = canvas.getBoundingClientRect();
    const dpr = window.devicePixelRatio || 1;
    if (r.width > 0 && r.height > 0) engine.setViewport(r.width, r.height, dpr, Math.max(1, Math.round(r.width * dpr)), Math.max(1, Math.round(r.height * dpr)));
  };
  const observer = new ResizeObserver(resize);
  observer.observe(canvas);
  offs.push(() => observer.disconnect());
  resize();
  return () => {
    for (const off of offs.splice(0)) off();
  };
}
