import { Menu, nativeTheme, webContents } from "electron";
import type { ThemePreference, ThemeState } from "../shared/ipc";
import { readSettings, writeSettings } from "./session";
import { viewOf } from "./views";
import { controllers } from "./window";

/**
 * The theme (docs/design-system.md §2.3): the preference is main's
 * (settings.json), nativeTheme resolves it — native menus, the window and
 * the traffic lights follow — and every view hears `theme:changed` and gets
 * its background colour before it paints. Enhance contrast and Underline
 * links (Preferences › Accessibility settings…, atlas 21 §4.1) go the same way.
 *
 * The site admin's pages still keep the preference in localStorage too
 * (context/ThemeContext.tsx): Home carries a change made here over to it
 * (app/HomeApp.tsx), and a change made there comes here through `theme:set`.
 */

/**
 * Enhance contrast as the user set it, or null: unset, it follows the system (atlas 21 §4.1 — Figma's
 * `global-debug-enhanced-contrast-preference` stays null until set and follows `prefers-contrast: more`; nativeTheme's
 * high-contrast flag is that setting: macOS's Increase contrast, Windows' contrast themes).
 */
let contrastSet: boolean | null = null;
/** Underline links (Figma's desktop keeps it as `underlineLinks`) */
let underlineLinks = false;

const contrast = () => contrastSet ?? nativeTheme.shouldUseHighContrastColors;

export const themeState = (): ThemeState => ({ preference: nativeTheme.themeSource, resolved: nativeTheme.shouldUseDarkColors ? "dark" : "light", contrast: contrast(), underlineLinks });

/** `--designer-theme=<preference>:<resolved>:[contrast]:[underline]` for a new view's preload (boot.js reads it before the first paint). */
export const themeArg = (): string => `${nativeTheme.themeSource}:${nativeTheme.shouldUseDarkColors ? "dark" : "light"}:${contrast() ? "contrast" : ""}:${underlineLinks ? "underline" : ""}`;

const stateKey = (s: ThemeState) => `${s.preference}:${s.resolved}:${s.contrast}:${s.underlineLinks}`;

let lastSent = "";

/** Every view told, the views' colours and the menu's radio set — once per actual change. */
export function themeChanged() {
  const state = themeState();
  const key = stateKey(state);
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

/** Enhance contrast (Settings › Account, Accessibility settings): kept in settings.json — off too, once set — and
 *  every view told (docs/design-system.md §2.5). */
export function setContrast(on: boolean): ThemeState {
  contrastSet = on;
  writeSettings({ ...readSettings(), contrast: on });
  themeChanged();
  return themeState();
}

/** Accessibility settings › Underline links: kept in settings.json, every view told. */
export function setUnderlineLinks(on: boolean): ThemeState {
  underlineLinks = on;
  const { underlineLinks: _old, ...rest } = readSettings();
  writeSettings(on ? { ...rest, underlineLinks: true } : rest);
  themeChanged();
  return themeState();
}

/** At launch: the kept preference, and the system's changes followed (its contrast too, while unset). */
export function initTheme() {
  const s = readSettings();
  nativeTheme.themeSource = s.theme;
  contrastSet = typeof s.contrast === "boolean" ? s.contrast : null;
  underlineLinks = s.underlineLinks === true;
  lastSent = stateKey(themeState());
  nativeTheme.on("updated", themeChanged);
}
