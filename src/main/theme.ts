import { Menu, nativeTheme, webContents } from "electron";
import type { ThemePreference, ThemeState } from "../shared/ipc";
import { readSettings, writeSettings } from "./session";
import { viewOf } from "./views";
import { controllers } from "./window";

/**
 * The theme (docs/design-system.md §2.3): the preference is main's
 * (settings.json), nativeTheme resolves it — native menus, the window and
 * the traffic lights follow — and every view hears `theme:changed` and gets
 * its background colour before it paints.
 *
 * The site admin's pages still keep the preference in localStorage too
 * (context/ThemeContext.tsx): Home carries a change made here over to it
 * (app/HomeApp.tsx), and a change made there comes here through `theme:set`.
 */

let contrast = false;

export const themeState = (): ThemeState => ({ preference: nativeTheme.themeSource, resolved: nativeTheme.shouldUseDarkColors ? "dark" : "light", contrast });

/** `--designer-theme=<preference>:<resolved>[:contrast]` for a new view's preload (boot.js reads it before the first paint). */
export const themeArg = (): string => `${nativeTheme.themeSource}:${nativeTheme.shouldUseDarkColors ? "dark" : "light"}${contrast ? ":contrast" : ""}`;

let lastSent = "";

/** Every view told, the views' colours and the menu's radio set — once per actual change. */
export function themeChanged() {
  const state = themeState();
  const key = `${state.preference}:${state.resolved}:${state.contrast}`;
  if (key === lastSent) return;
  lastSent = key;
  for (const contents of webContents.getAllWebContents()) if (viewOf(contents) && !contents.isDestroyed()) contents.send("theme:changed", state);
  for (const ctl of controllers.values()) ctl.themeChanged();
  const item = Menu.getApplicationMenu()?.getMenuItemById(`app.theme-${state.preference}`);
  if (item) item.checked = true;
}

export function setThemePreference(preference: ThemePreference): ThemeState {
  nativeTheme.themeSource = preference;
  writeSettings({ ...readSettings(), theme: preference });
  themeChanged();
  return themeState();
}

/** Settings › Account › Enhance contrast: kept in settings.json, every view told (docs/design-system.md §2.5). */
export function setContrast(on: boolean): ThemeState {
  contrast = on;
  const { contrast: _old, ...rest } = readSettings();
  writeSettings(on ? { ...rest, contrast: true } : rest);
  themeChanged();
  return themeState();
}

/** At launch: the kept preference, and the system's changes followed. */
export function initTheme() {
  const s = readSettings();
  nativeTheme.themeSource = s.theme;
  contrast = s.contrast === true;
  lastSent = `${themeState().preference}:${themeState().resolved}:${contrast}`;
  nativeTheme.on("updated", themeChanged);
}
