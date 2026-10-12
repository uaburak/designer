import { app, BaseWindow } from "electron";
import { join } from "node:path";
import type { AuthSheet } from "./signIn";

/**
 * The sign-in sheet's addon (native/authsheet, docs/desktop.md §18.6): Apple's ASWebAuthenticationSession over our
 * window. Loaded once, on a Mac only — next to the app's resources when packaged, under native/authsheet in
 * development, as native/haptics is. null when it can't be (another OS, the file missing, macOS before 10.15): the
 * sign-in then goes through the system browser.
 */
interface Addon {
  available(): boolean;
  start(url: string, callbackScheme: string, windowHandle: Buffer | null, done: (error: string | null, url: string | null) => void): boolean;
  cancel(): void;
}

let addon: Addon | null | undefined;

function load(): Addon | null {
  if (addon !== undefined) return addon;
  addon = null;
  if (process.platform !== "darwin" || process.env.DESIGNER_SIGN_IN === "browser") return addon;
  const path = app.isPackaged ? join(process.resourcesPath, "authsheet.node") : join(app.getAppPath(), "native", "authsheet", "authsheet.node");
  try {
    const mod = { exports: {} as Partial<Addon> };
    process.dlopen(mod, path);
    const a = mod.exports;
    if (typeof a.start === "function" && typeof a.cancel === "function" && typeof a.available === "function" && a.available()) addon = a as Addon;
  } catch (err) {
    console.warn(`[account] the sign-in sheet isn't available (${path}):`, err instanceof Error ? err.message : err);
  }
  return addon;
}

/** The sheet, hung on `win` (else the window in front), or null: use the browser. */
export function authSheet(win: BaseWindow | null): AuthSheet | null {
  const a = load();
  if (!a) return null;
  return {
    start: (url, scheme, done) => {
      try {
        const handle = win && !win.isDestroyed() ? win.getNativeWindowHandle() : null;
        return a.start(url, scheme, handle, done);
      } catch (err) {
        console.warn("[account] the sign-in sheet didn't start:", err instanceof Error ? err.message : err);
        return false;
      }
    },
    cancel: () => a.cancel(),
  };
}
