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
