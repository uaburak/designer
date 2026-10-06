/**
 * The canvas's view: its tools, where it is (the canvas's origin on the
 * screen and its zoom), and the zoom's arithmetic.
 */

/** Figma's tools: move (V), hand (H), frame (F), rectangle (R), ellipse (O), line (L), text (T). */
export type CanvasTool = "move" | "hand" | "frame" | "rectangle" | "ellipse" | "line" | "text";

/** Where the view is: the canvas's origin on the screen (px from the viewport's top left) and its zoom. */
export interface CanvasView {
  x: number;
  y: number;
  zoom: number;
}

/** What the canvas's zoom does, for the chrome's zoom menu. */
export interface ZoomActions {
  zoomTo: (zoom: number) => void;
  fitAll: () => void;
  fitSelection: () => void;
}

export const MIN_ZOOM = 0.02;
export const MAX_ZOOM = 256;
export const clampZoom = (zoom: number) => Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, zoom));

/** The view zoomed to `zoom`, the canvas point under `at` (screen px in the viewport) staying there. */
export function zoomAround(view: CanvasView, zoom: number, at: { x: number; y: number }): CanvasView {
  const next = clampZoom(zoom);
  const px = (at.x - view.x) / view.zoom;
  const py = (at.y - view.y) / view.zoom;
  return { zoom: next, x: at.x - px * next, y: at.y - py * next };
}

/** The view fitting a canvas rect in a viewport of `width` × `height`, with room around it — never over 100% when `upTo100`. */
export function fitView(rect: { x: number; y: number; w: number; h: number }, width: number, height: number, upTo100 = true): CanvasView {
  const room = 64;
  const zoom = clampZoom(Math.min((width - room * 2) / Math.max(1, rect.w), (height - room * 2) / Math.max(1, rect.h), upTo100 ? 1 : Infinity));
  return { zoom, x: (width - rect.w * zoom) / 2 - rect.x * zoom, y: (height - rect.h * zoom) / 2 - rect.y * zoom };
}

/**
 * Where a canvas's view is, kept apart from the editor: it changes with every
 * wheel tick and drag, and only the canvas (and the zoom's label) need to be
 * drawn again for it — read with useView; the rest read it when they act (get).
 */
export interface ViewStore {
  get: () => CanvasView;
  set: (update: (view: CanvasView) => CanvasView) => void;
  subscribe: (listener: () => void) => () => void;
}

export function createViewStore(initial: CanvasView): ViewStore {
  let view = initial;
  const listeners = new Set<() => void>();
  return {
    get: () => view,
    set: (update) => {
      const next = update(view);
      if (next === view || (next.x === view.x && next.y === view.y && next.zoom === view.zoom)) return;
      view = next;
      listeners.forEach((l) => l());
    },
    subscribe: (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
}
