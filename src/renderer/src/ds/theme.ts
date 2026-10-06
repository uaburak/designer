import { useEffect, useSyncExternalStore } from "react";
import type { ThemeName, ThemePreference } from "./tokens";

/**
 * The theme (contract §2.3): a preference — system, light or dark — and the
 * theme it resolves to, on <html data-theme> (written before the first
 * paint by public/boot.js).
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
export type ThemeState = { preference: ThemePreference; resolved: ThemeName };

export const THEME_STORAGE_KEY = "designer-theme";
export const THEME_EVENT = "designer-theme-change";

/** The slice of `window.designer` (src/shared/desktop.ts) the theme uses. */
type DesignerTheme = {
  theme?: ThemeState;
  setTheme?: (p: ThemePreference) => Promise<ThemeState>;
  onThemeChanged?: (cb: (t: ThemeState) => void) => () => void;
};
const designer = (): DesignerTheme | undefined => (typeof window === "undefined" ? undefined : (window as unknown as { designer?: DesignerTheme }).designer);

/** The desktop app's latest word (boot snapshot, then theme:changed / setTheme answers). */
let desktopState: ThemeState | null = null;

/** A stored value as a preference (anything else is "system"). */
export const parsePreference = (saved: unknown): ThemePreference => (saved === "light" || saved === "dark" ? saved : "system");

/** The theme a preference means, given whether the system is dark. */
export const resolveTheme = (pref: ThemePreference, systemDark: boolean): ThemeName => (pref === "dark" || (pref === "system" && systemDark) ? "dark" : "light");

const systemDark = () => typeof window !== "undefined" && typeof window.matchMedia === "function" && window.matchMedia("(prefers-color-scheme: dark)").matches;

function storedPreference(): ThemePreference {
  try {
    return parsePreference(localStorage.getItem(THEME_STORAGE_KEY));
  } catch {
    return "system";
  }
}

export function currentTheme(): ThemeState {
  const desk = desktopState ?? designer()?.theme;
  if (desk && (desk.resolved === "light" || desk.resolved === "dark")) return { preference: parsePreference(desk.preference), resolved: desk.resolved };
  const preference = storedPreference();
  return { preference, resolved: resolveTheme(preference, systemDark()) };
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

/** Called whenever the preference or the resolved theme may have changed. */
export function onThemeChange(cb: (t: ThemeState) => void): () => void {
  const fire = () => cb(currentTheme());
  const media = window.matchMedia("(prefers-color-scheme: dark)");
  const onStorage = (e: StorageEvent) => (e.key === THEME_STORAGE_KEY || e.key === null) && fire();
  window.addEventListener(THEME_EVENT, fire);
  window.addEventListener("storage", onStorage);
  media.addEventListener("change", fire);
  const offDesktop = designer()?.onThemeChanged?.((t) => {
    desktopState = t;
    fire();
  });
  return () => {
    window.removeEventListener(THEME_EVENT, fire);
    window.removeEventListener("storage", onStorage);
    media.removeEventListener("change", fire);
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
  return `${t.preference}:${t.resolved}`;
};
const subscribe = (cb: () => void) => onThemeChange(cb);

/** The preference and resolved theme (useSyncExternalStore). */
export function useTheme(): ThemeState {
  const s = useSyncExternalStore(subscribe, snapshot, () => "system:light");
  const [preference, resolved] = s.split(":") as [ThemePreference, ThemeName];
  return { preference, resolved };
}

/** useTheme, and keeps <html data-theme> in step (a root without ThemeProvider: the Gallery). */
export function useThemeRoot(): ThemeState {
  const t = useTheme();
  useEffect(() => applyTheme(t.resolved), [t.resolved]);
  return t;
}
