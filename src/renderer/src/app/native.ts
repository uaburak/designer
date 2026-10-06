import type { NativeApi } from "@shared/api";
import type { DesktopApi, EditorApi, HomeApi, TabBarApi } from "@shared/desktop";

declare global {
  interface Window {
    /** This view's side of the desktop app (src/preload/<role>.ts) — absent in a browser (`npm run web`) */
    designer?: DesktopApi;
  }
}

/** The desktop app's API of this view (its role's), or undefined in a browser. */
export function desktop(): DesktopApi | undefined {
  return typeof window === "undefined" ? undefined : window.designer;
}

export const desktopAs = {
  tabbar: () => (desktop()?.role === "tabbar" ? (desktop() as TabBarApi) : undefined),
  home: () => (desktop()?.role === "home" ? (desktop() as HomeApi) : undefined),
  editor: () => (desktop()?.role === "editor" ? (desktop() as EditorApi) : undefined),
};

let legacy: NativeApi | undefined;

/**
 * The legacy API the site admin's code calls (the sign-in, the theme,
 * links), built on this view's `window.designer`; undefined in a browser.
 */
export function native(): NativeApi | undefined {
  const api = desktop();
  if (!api) return undefined;
  legacy ??= {
    platform: api.platform,
    version: api.version,
    signInWithGoogle: () => (api.role === "home" ? api.signInWithGoogle() : Promise.reject(new Error("Sign in from Home."))),
    cancelSignIn: () => (api.role === "home" ? api.cancelSignIn() : undefined),
    openExternal: (url) => (api.role === "tabbar" ? undefined : api.openExternal(url)),
    setTheme: (theme) => void api.setTheme(theme),
  };
  return legacy;
}

/** Running in the desktop app (not `npm run web`). */
export const isDesktop = Boolean(desktop());

/** A Mac: the window's traffic lights sit at the tab bar's left. */
export const isMac = typeof navigator !== "undefined" && /Mac/.test(navigator.platform);

/** An http(s) address, in the system's browser (a new browser tab in `npm run web`). */
export function openExternal(url: string) {
  const api = native();
  if (api) api.openExternal(url);
  else window.open(url, "_blank", "noopener,noreferrer");
}
