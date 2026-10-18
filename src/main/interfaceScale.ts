import { webContents } from "electron";
import { DEFAULT_ZOOM_STOP, isZoomStop, stepZoomStop, type ZoomStop } from "../shared/interfaceScale";
import { TABBAR_HEIGHT } from "../shared/layout";
import { refreshAppMenu } from "./menu";
import { readSettings, writeSettings } from "./session";
import { viewOf } from "./views";
import { controllers } from "./window";

/**
 * View › Interface Scale (atlas 21 §7, Figma desktop's `zoomStop`): Reset to Default ⇧⌘⌥0, Make Larger ⇧⌘⌥=, Make
 * Smaller ⇧⌘⌥-, over Figma's stops (src/shared/interfaceScale.ts). Kept in settings.json; applied as the zoom factor of
 * every web view — the tab bar too, whose height (and the traffic lights' place in it) grows with it, as Figma's
 * overlays are placed in scaled pixels. A new view starts at it (views.ts `webPreferences.zoomFactor`).
 */

let stop: ZoomStop = DEFAULT_ZOOM_STOP;

export const interfaceScale = (): ZoomStop => stop;
export const zoomFactor = (): number => stop / 100;

/** The tab bar's height at the current scale (its 38 CSS px). */
export const tabbarHeight = (): number => Math.round(TABBAR_HEIGHT * zoomFactor());

export function setInterfaceScale(next: number): ZoomStop {
  const value = isZoomStop(next) ? next : DEFAULT_ZOOM_STOP;
  if (value === stop) return stop;
  stop = value;
  const { zoomStop: _old, ...rest } = readSettings();
  writeSettings(value === DEFAULT_ZOOM_STOP ? rest : { ...rest, zoomStop: value });
  for (const contents of webContents.getAllWebContents()) if (viewOf(contents) && !contents.isDestroyed()) contents.setZoomFactor(zoomFactor());
  for (const ctl of controllers.values()) ctl.interfaceScaleChanged();
  // The menu's "{n}%" line.
  refreshAppMenu();
  return stop;
}

/** Make Larger / Make Smaller. */
export const stepInterfaceScale = (dir: 1 | -1): ZoomStop => setInterfaceScale(stepZoomStop(stop, dir));

/** At launch, before the first window: the kept scale. */
export function initInterfaceScale(): void {
  const saved = readSettings().zoomStop;
  stop = isZoomStop(saved) ? saved : DEFAULT_ZOOM_STOP;
}
