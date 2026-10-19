/**
 * The desktop app's View › Interface scale (atlas 21 §7: Figma desktop's `zoomStop`, `ZOOM_STOPS`): the whole
 * window's chrome and canvas zoomed as one, an accessibility control (the browser uses its own page zoom). Kept in
 * settings.json in percent; applied as each web view's zoom factor (src/main/interfaceScale.ts).
 */

/** Figma's stops, in percent */
export const ZOOM_STOPS = [25, 33, 50, 66, 80, 90, 100, 110, 120, 130, 140, 150, 175, 200, 250, 300, 400, 500] as const;
export type ZoomStop = (typeof ZOOM_STOPS)[number];

export const DEFAULT_ZOOM_STOP: ZoomStop = 100;

export const isZoomStop = (v: unknown): v is ZoomStop => typeof v === "number" && (ZOOM_STOPS as readonly number[]).includes(v);

/** Make larger / Make smaller: the next stop up or down, the ends staying where they are. */
export function stepZoomStop(current: number, dir: 1 | -1): ZoomStop {
  const at = ZOOM_STOPS.indexOf(isZoomStop(current) ? current : DEFAULT_ZOOM_STOP);
  return ZOOM_STOPS[Math.max(0, Math.min(ZOOM_STOPS.length - 1, at + dir))];
}
