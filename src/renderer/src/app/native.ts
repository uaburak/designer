import type { NativeApi } from "@shared/api";

declare global {
  interface Window {
    /** The desktop's side (src/preload) — absent in a browser, and in a tab's own frame (it asks the shell, see bridge.ts) */
    designer?: NativeApi;
  }
}

/** The desktop app's side of the window — the top window's (a tab is a frame inside it); undefined in a browser. */
export function native(): NativeApi | undefined {
  if (typeof window === "undefined") return undefined;
  if (window.designer) return window.designer;
  try {
    return window.top?.designer;
  } catch {
    return undefined;
  }
}

/** Running in the desktop app (not `npm run web`). */
export const isDesktop = Boolean(native());

/** A Mac: the window's traffic lights sit at the tab bar's left. */
export const isMac = typeof navigator !== "undefined" && /Mac/.test(navigator.platform);

/** An http(s) address, in the system's browser (a new browser tab in `npm run web`). */
export function openExternal(url: string) {
  const desktop = native();
  if (desktop) desktop.openExternal(url);
  else window.open(url, "_blank", "noopener,noreferrer");
}
