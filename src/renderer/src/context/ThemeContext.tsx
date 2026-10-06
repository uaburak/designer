import { createContext, useCallback, useContext, useEffect, useMemo, useSyncExternalStore } from "react";
import type { ThemePreference } from "@shared/api";
import { native } from "@/app/native";

type Theme = "light" | "dark";

/**
 * The app's theme: the system's, light or dark — one for the whole window
 * (the home, the tab bar and every open tab: each tab is a page of its own,
 * they follow each other through localStorage). The document's `data-theme`
 * says the one in use (written before the first paint by boot.js); the
 * desktop app is told too, for its menus and window (nativeTheme).
 */
const KEY = "designer-theme";
const EVENT = "designer-theme-change";

const preference = (): ThemePreference => {
  try {
    const saved = localStorage.getItem(KEY);
    return saved === "light" || saved === "dark" ? saved : "system";
  } catch {
    return "system";
  }
};
const systemDark = () => window.matchMedia("(prefers-color-scheme: dark)").matches;
const resolve = (pref: ThemePreference): Theme => (pref === "dark" || (pref === "system" && systemDark()) ? "dark" : "light");

const subscribe = (cb: () => void) => {
  const media = window.matchMedia("(prefers-color-scheme: dark)");
  const onStorage = (e: StorageEvent) => (e.key === KEY || e.key === null) && cb();
  window.addEventListener(EVENT, cb);
  window.addEventListener("storage", onStorage);
  media.addEventListener("change", cb);
  return () => {
    window.removeEventListener(EVENT, cb);
    window.removeEventListener("storage", onStorage);
    media.removeEventListener("change", cb);
  };
};
/** One string, so React sees a change only when one of the two changes. */
const snapshot = () => `${preference()}:${resolve(preference())}`;

const ThemeContext = createContext<{ theme: Theme; preference: ThemePreference; setPreference: (pref: ThemePreference) => void; toggle: () => void }>({
  theme: "light",
  preference: "system",
  setPreference: () => {},
  toggle: () => {},
});

export function ThemeProvider({ children }: { children: React.ReactNode }) {
  const current = useSyncExternalStore(subscribe, snapshot, () => "system:light");
  const [pref, theme] = current.split(":") as [ThemePreference, Theme];

  useEffect(() => {
    const root = document.documentElement;
    root.setAttribute("data-theme", theme);
    root.style.colorScheme = theme;
    root.style.backgroundColor = "";
  }, [theme]);

  const setPreference = useCallback((next: ThemePreference) => {
    try {
      if (next === "system") localStorage.removeItem(KEY);
      else localStorage.setItem(KEY, next);
    } catch {
      /* this page only */
    }
    native()?.setTheme(next);
    window.dispatchEvent(new Event(EVENT));
  }, []);
  // A light/dark switch from where it is now (the system's turned into the other one).
  const toggle = useCallback(() => setPreference(resolve(preference()) === "dark" ? "light" : "dark"), [setPreference]);

  const value = useMemo(() => ({ theme, preference: pref, setPreference, toggle }), [theme, pref, setPreference, toggle]);
  return <ThemeContext.Provider value={value}>{children}</ThemeContext.Provider>;
}

export const useTheme = () => useContext(ThemeContext);
