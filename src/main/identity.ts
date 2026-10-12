import { join } from "node:path";

/**
 * The app's names (docs/desktop.md §12.7). It is "Wecra" to the person (from 1.0.4) — the bundle, the menus, the
 * dialogs — was "Designer" from 1.0.0 to 1.0.3, and shipped as "DesignerV2" before 1.0. Two things stored under the
 * first name stay under it, for every install:
 *
 * - **userData** is `<appData>/DesignerV2` (`~/Library/Application Support/DesignerV2`, `%APPDATA%\DesignerV2`),
 *   pinned rather than moved: its absolute path is outside our files too — Claude Code keeps a chat's session by its
 *   working folder (`agents/work/<chat>`, continued with `--resume`), and the stdio snippet other MCP clients were
 *   given runs `agents/designer-mcp.cjs` by path. A move would orphan both, and on Windows fails while any file in it
 *   is open. The folder's name isn't shown anywhere.
 * - **The safeStorage key** is the login keychain's "DesignerV2 Safe Storage" (account "DesignerV2 Key"). Electron
 *   names the item after `app.name` as it is when the main message loop is made — after this script's first run,
 *   before `ready` (shell/browser/electron_browser_main_parts.cc, PostCreateMainMessageLoop: `<name> Safe Storage`,
 *   account `<name>` + Electron's " Key" suffix) — and keeps that for the run. Under "Wecra" it would make a new,
 *   empty "Wecra Safe Storage" and every "enc:" value (the session, the MCP token, the AI and agents' API keys,
 *   Chromium's cookies) would stop opening. So the name is "DesignerV2" until `ready`, then "Wecra". Windows keeps
 *   its key in userData's "Local State" (DPAPI): the pinned folder keeps it.
 */
export const PRODUCT_NAME = "Wecra";
export const LEGACY_NAME = "DesignerV2";

/** userData: `DESIGNER_USER_DATA` (scripts/drive.mjs's own runs), else `<appData>/DesignerV2`. */
export function userDataPath(appData: string, override?: string): string {
  return override || join(appData, LEGACY_NAME);
}

/** The keychain item safeStorage's key is in (macOS): what Electron derives from the name it is given before `ready`. */
export const keychainItem = (nameBeforeReady: string) => ({ service: `${nameBeforeReady} Safe Storage`, account: `${nameBeforeReady} Key` });

/** What `applyIdentity` uses of Electron's `app` (a fake in identity.test.ts) */
export interface IdentityApp {
  getPath(name: "appData"): string;
  setPath(name: "userData", path: string): void;
  setName(name: string): void;
  whenReady(): Promise<unknown>;
}

/** Run first, before anything reads userData or the keychain (index.ts's first import). */
export function applyIdentity(app: IdentityApp, env: NodeJS.ProcessEnv = process.env): void {
  app.setPath("userData", userDataPath(app.getPath("appData"), env.DESIGNER_USER_DATA));
  app.setName(LEGACY_NAME);
  void app.whenReady().then(() => app.setName(PRODUCT_NAME));
}
