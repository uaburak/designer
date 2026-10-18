import { useEffect, useSyncExternalStore } from "react";
import type { ThemeName, ThemePreference } from "./tokens";

/**
 * The theme (contract §2.3): a preference — system, light or dark — and the
 * theme it resolves to, on <html data-theme> (written before the first
 * paint by public/boot.js). Enhance contrast and Underline links
 * (Preferences › Accessibility settings…, atlas 21 §4.1) travel with it.
 *
 * In the desktop app the preference is main's: each view's preload hands a
 * boot snapshot (`window.designer.theme`), takes changes
 * (`window.designer.setTheme`, invoke "theme:set" → ThemeState) and
 * announces them (`window.designer.onThemeChanged`, event "theme:changed").
 * Without a preload (a browser, the viewer, the Gallery on a dev server) it
 * falls back to localStorage "designer-theme" (absent = system) and
 * `prefers-color-scheme`. Either way a change is also written to that key
 * and announced with the "designer-theme-change" event, so
 * context/ThemeContext.tsx follows until it is replaced.
 */
export type { ThemeName, ThemePreference } from "./tokens";
export type ThemeState = { preference: ThemePreference; resolved: ThemeName; contrast: boolean; underlineLinks: boolean };

export const THEME_STORAGE_KEY = "designer-theme";
/**
 * Enhance contrast without a preload (a browser, §2.5): "more" or "off" once set; absent, the system's
 * `prefers-contrast: more` (Figma's `global-debug-enhanced-contrast-preference` is null until set). Before 2026-10-18
 * only "more" was written.
 */
export const CONTRAST_STORAGE_KEY = "designer-contrast";
/** Underline links without a preload: "true" when on (Figma's `global-debug-link-underline-preference`) */
export const UNDERLINE_LINKS_STORAGE_KEY = "designer-underline-links";
export const THEME_EVENT = "designer-theme-change";

/** The slice of `window.designer` (src/shared/desktop.ts) the theme uses. */
type DesignerTheme = {
  theme?: ThemeState;
  setTheme?: (p: ThemePreference) => Promise<ThemeState>;
  setContrast?: (on: boolean) => Promise<ThemeState>;
  setUnderlineLinks?: (on: boolean) => Promise<ThemeState>;
  onThemeChanged?: (cb: (t: ThemeState) => void) => () => void;
};
const designer = (): DesignerTheme | undefined => (typeof window === "undefined" ? undefined : (window as unknown as { designer?: DesignerTheme }).designer);

/** The desktop app's latest word (boot snapshot, then theme:changed / setTheme answers). */
let desktopState: ThemeState | null = null;

/** A stored value as a preference (anything else is "system"). */
export const parsePreference = (saved: unknown): ThemePreference => (saved === "light" || saved === "dark" ? saved : "system");

/** The theme a preference means, given whether the system is dark. */
export const resolveTheme = (pref: ThemePreference, systemDark: boolean): ThemeName => (pref === "dark" || (pref === "system" && systemDark) ? "dark" : "light");

/** Enhance contrast as stored ("more" / "off"), else the system's. */
export const resolveContrast = (saved: unknown, systemMore: boolean): boolean => (saved === "more" ? true : saved === "off" ? false : systemMore);

const media = (query: string) => typeof window !== "undefined" && typeof window.matchMedia === "function" && window.matchMedia(query).matches;
const systemDark = () => media("(prefers-color-scheme: dark)");
const systemMoreContrast = () => media("(prefers-contrast: more)");

function stored(key: string): string | null {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}

export function currentTheme(): ThemeState {
  const desk = desktopState ?? designer()?.theme;
  if (desk && (desk.resolved === "light" || desk.resolved === "dark")) return { preference: parsePreference(desk.preference), resolved: desk.resolved, contrast: desk.contrast === true, underlineLinks: desk.underlineLinks === true };
  const preference = parsePreference(stored(THEME_STORAGE_KEY));
  return { preference, resolved: resolveTheme(preference, systemDark()), contrast: resolveContrast(stored(CONTRAST_STORAGE_KEY), systemMoreContrast()), underlineLinks: stored(UNDERLINE_LINKS_STORAGE_KEY) === "true" };
}

const announce = () => window.dispatchEvent(new Event(THEME_EVENT));

/** Choose a preference: main is told (desktop: native menus, the window, every view follow), the page's copy kept, listeners told. */
export function setThemePreference(next: ThemePreference): void {
  try {
    if (next === "system") localStorage.removeItem(THEME_STORAGE_KEY);
    else localStorage.setItem(THEME_STORAGE_KEY, next);
  } catch {
    /* this page only */
  }
  const d = designer();
  if (d?.setTheme) {
    void d.setTheme(next).then((state) => {
      desktopState = state;
      announce();
    });
  }
  announce();
}

/** Enhance contrast (Settings › Account, Accessibility settings): main is told (every view follows), the page's copy
 *  kept — off too, so the system's no longer decides — listeners told. */
export function setContrast(on: boolean): void {
  try {
    localStorage.setItem(CONTRAST_STORAGE_KEY, on ? "more" : "off");
  } catch {
    /* this page only */
  }
  const d = designer();
  if (d?.setContrast) {
    void d.setContrast(on).then((state) => {
      desktopState = state;
      announce();
    });
  } else if (desktopState) desktopState = { ...desktopState, contrast: on };
  announce();
}

/** Accessibility settings › Underline links: main is told (every view follows), the page's copy kept, listeners told. */
export function setUnderlineLinks(on: boolean): void {
  try {
    if (on) localStorage.setItem(UNDERLINE_LINKS_STORAGE_KEY, "true");
    else localStorage.removeItem(UNDERLINE_LINKS_STORAGE_KEY);
  } catch {
    /* this page only */
  }
  const d = designer();
  if (d?.setUnderlineLinks) {
    void d.setUnderlineLinks(on).then((state) => {
      desktopState = state;
      announce();
    });
  } else if (desktopState) desktopState = { ...desktopState, underlineLinks: on };
  announce();
}

/** Enhance contrast on <html> (or `el`): `data-contrast="more"` switches the tokens (tokens.css). */
export function applyContrast(on: boolean, el: HTMLElement = document.documentElement): void {
  if (on) el.setAttribute("data-contrast", "more");
  else el.removeAttribute("data-contrast");
}

/** Underline links on <body> (or `el`), as Figma's `data-underline-links` (global.css underlines the links). */
export function applyUnderlineLinks(on: boolean, el: HTMLElement = document.body): void {
  if (on) el.setAttribute("data-underline-links", "");
  else el.removeAttribute("data-underline-links");
}

/** Called whenever the preference or the resolved theme may have changed. */
export function onThemeChange(cb: (t: ThemeState) => void): () => void {
  const fire = () => cb(currentTheme());
  const dark = window.matchMedia("(prefers-color-scheme: dark)");
  const contrast = window.matchMedia("(prefers-contrast: more)");
  const onStorage = (e: StorageEvent) => (e.key === THEME_STORAGE_KEY || e.key === CONTRAST_STORAGE_KEY || e.key === UNDERLINE_LINKS_STORAGE_KEY || e.key === null) && fire();
  window.addEventListener(THEME_EVENT, fire);
  window.addEventListener("storage", onStorage);
  dark.addEventListener("change", fire);
  contrast.addEventListener("change", fire);
  const offDesktop = designer()?.onThemeChanged?.((t) => {
    desktopState = t;
    fire();
  });
  return () => {
    window.removeEventListener(THEME_EVENT, fire);
    window.removeEventListener("storage", onStorage);
    dark.removeEventListener("change", fire);
    contrast.removeEventListener("change", fire);
    offDesktop?.();
  };
}

/**
 * Put a theme on <html> (or `el`): data-theme and color-scheme; for two
 * frames `data-theme-switching` turns every transition off so nothing
 * animates between the themes' colours.
 */
export function applyTheme(resolved: ThemeName, el: HTMLElement = document.documentElement): void {
  if (el.getAttribute("data-theme") === resolved) return;
  el.setAttribute("data-theme-switching", "");
  el.setAttribute("data-theme", resolved);
  el.style.colorScheme = resolved;
  // boot.js painted the old theme's background inline before the first paint; the stylesheet's takes over now.
  el.style.backgroundColor = "";
  requestAnimationFrame(() => requestAnimationFrame(() => el.removeAttribute("data-theme-switching")));
}

const snapshot = () => {
  const t = currentTheme();
  return `${t.preference}:${t.resolved}:${t.contrast ? "more" : ""}:${t.underlineLinks ? "underline" : ""}`;
};
const subscribe = (cb: () => void) => onThemeChange(cb);

/** The preference and resolved theme (useSyncExternalStore). */
export function useTheme(): ThemeState {
  const s = useSyncExternalStore(subscribe, snapshot, () => "system:light::");
  const [preference, resolved, contrast, underline] = s.split(":") as [ThemePreference, ThemeName, string, string];
  return { preference, resolved, contrast: contrast === "more", underlineLinks: underline === "underline" };
}

/** useTheme, and keeps <html data-theme> in step (a root without ThemeProvider: the Gallery). */
export function useThemeRoot(): ThemeState {
  const t = useTheme();
  useEffect(() => applyTheme(t.resolved), [t.resolved]);
  useEffect(() => applyContrast(t.contrast), [t.contrast]);
  useEffect(() => applyUnderlineLinks(t.underlineLinks), [t.underlineLinks]);
  return t;
}
