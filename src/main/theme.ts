import { Menu, nativeTheme, webContents } from "electron";
import type { ThemePreference } from "../shared/api";
import type { ThemeState } from "../shared/ipc";
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

export const themeState = (): ThemeState => ({ preference: nativeTheme.themeSource, resolved: nativeTheme.shouldUseDarkColors ? "dark" : "light" });

let lastSent = "";

/** Every view told, the views' colours and the menu's radio set — once per actual change. */
export function themeChanged() {
  const state = themeState();
  const key = `${state.preference}:${state.resolved}`;
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

/** At launch: the kept preference, and the system's changes followed. */
export function initTheme() {
  nativeTheme.themeSource = readSettings().theme;
  lastSent = `${themeState().preference}:${themeState().resolved}`;
  nativeTheme.on("updated", themeChanged);
}
