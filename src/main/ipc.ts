import { app, ipcMain, Menu, shell, type IpcMainEvent, type IpcMainInvokeEvent, type MenuItemConstructorOptions, type WebContents } from "electron";
import { INVOKE_ROLES, SEND_ROLES, type IpcInvoke, type IpcSend, type NativeMenuItem, type Role } from "../shared/ipc";
import type { GoogleCredential, SignInResult } from "../shared/api";
import type { TabKind } from "../shared/tabs";
import { isAppUrl } from "./protocol";
import { setThemePreference, themeState } from "./theme";
import { cancelSignIn, signInWithGoogle } from "./signIn";
import { settleRequest } from "./tabs";
import { viewOf, type ViewInfo } from "./views";
import { controllers, type WindowController } from "./window";

/**
 * Every ipcMain handler (docs/desktop.md §10). Each message is checked
 * before it is acted on: from a view main made, of a role allowed on the
 * channel, from that view's main frame, on one of the app's own pages.
 * Anything else is dropped (and logged once per channel).
 */

const warned = new Set<string>();
function drop(channel: string, why: string) {
  if (warned.has(channel + why)) return;
  warned.add(channel + why);
  console.warn(`[ipc] dropped ${channel}: ${why}`);
}

interface Caller {
  info: ViewInfo;
  ctl: WindowController;
  sender: WebContents;
}

function check(channel: string, roles: readonly Role[], e: IpcMainEvent | IpcMainInvokeEvent): Caller | null {
  const info = viewOf(e.sender);
  if (!info) return drop(channel, "not a view"), null;
  if (!roles.includes(info.role)) return drop(channel, `role ${info.role}`), null;
  if (!e.senderFrame || e.senderFrame !== e.sender.mainFrame) return drop(channel, "not the main frame"), null;
  if (!isAppUrl(e.senderFrame.url)) return drop(channel, "not the app's page"), null;
  // Its window is closing (a last report on the way out): nothing to tell.
  const ctl = controllers.get(info.windowId);
  if (!ctl) return null;
  return { info, ctl, sender: e.sender };
}

function onSend<C extends keyof IpcSend>(channel: C, fn: (caller: Caller, payload: IpcSend[C]) => void) {
  ipcMain.on(channel, (e, payload: IpcSend[C]) => {
    const caller = check(channel, SEND_ROLES[channel], e);
    if (caller) fn(caller, payload);
  });
}

function onInvoke<C extends keyof IpcInvoke>(channel: C, fn: (caller: Caller, ...args: IpcInvoke[C]["args"]) => IpcInvoke[C]["result"] | Promise<IpcInvoke[C]["result"]>) {
  ipcMain.handle(channel, (e, ...args) => {
    const caller = check(channel, INVOKE_ROLES[channel], e);
    if (!caller) throw new Error(`${channel}: not allowed`);
    return fn(caller, ...(args as IpcInvoke[C]["args"]));
  });
}

const str = (v: unknown, max = 512) => (typeof v === "string" && v.length <= max ? v : null);
const isKind = (k: unknown): k is TabKind => k === "project" || k === "preview" || k === "cv";

export function registerIpc() {
  // ── Init and window ──
  onInvoke("desktop:init", ({ info, ctl }) => ({ version: app.getVersion(), platform: process.platform, role: info.role, tabId: info.tabId, windowId: ctl.id, theme: themeState() }));
  onSend("shell:ready", ({ info, ctl }) => ctl.markReady(info.role === "tabbar" ? "tabbar" : "content"));

  // ── Tabs ──
  onInvoke("tabs:get", ({ ctl }) => ctl.tabs.snapshot());
  onSend("tabs:activate", ({ ctl }, p) => {
    const id = str(p?.tabId, 64);
    if (id) ctl.tabs.activate(id);
  });
  onSend("tabs:close", ({ ctl, info }, p) => {
    // A file tab closes only itself.
    const id = info.role === "editor" ? info.tabId : str(p?.tabId, 64);
    if (id) void ctl.tabs.close([id]);
  });
  onSend("tabs:move", ({ ctl }, p) => {
    const id = str(p?.tabId, 64);
    if (id && typeof p.toIndex === "number") ctl.tabs.move(id, p.toIndex);
  });
  onSend("tabs:context-menu", ({ ctl }, p) => {
    const id = str(p?.tabId, 64);
    if (id && typeof p.x === "number" && typeof p.y === "number") ctl.tabs.contextMenu(id, p.x, p.y);
  });
  onSend("tabs:reopen", ({ ctl }) => ctl.tabs.reopen());

  // ── Navigation ──
  onInvoke("nav:open-file", ({ ctl }, file) => {
    const slug = str(file?.slug, 200);
    if (!slug || !isKind(file.kind)) throw new Error("nav:open-file: a kind and a slug");
    return { tabId: ctl.tabs.open({ kind: file.kind, slug, title: str(file.title, 300) ?? undefined }) };
  });
  onSend("nav:new-file", ({ ctl }) => ctl.tabs.newFile());
  onSend("nav:go-home", ({ ctl }) => ctl.tabs.activate("home"));

  // ── A file tab ──
  onSend("tab:report", ({ ctl, sender }, r) => {
    if (!r || typeof r !== "object") return;
    const status = r.status === "loading" || r.status === "ready" || r.status === "missing" || r.status === "error" ? r.status : undefined;
    ctl.tabs.report(sender, { title: str(r.title, 300) ?? undefined, dirty: typeof r.dirty === "boolean" ? r.dirty : undefined, status, savedAt: typeof r.savedAt === "number" ? r.savedAt : undefined });
  });
  onSend("tab:response", ({ sender }, r) => {
    if (r && typeof r.reqId === "number") settleRequest(sender, { reqId: r.reqId, ok: r.ok === true, value: r.value === true, error: str(r.error, 2000) ?? undefined });
  });

  // ── The sign-in (legacy) ──
  onSend("session:auth", ({ ctl }, p) => ctl.tabs.setSignedIn(p?.signedIn === true));
  onSend("session:request-sign-out", ({ ctl }) => void ctl.tabs.signOut());
  onInvoke("auth:google", async ({ ctl }): Promise<SignInResult> => {
    let credential: GoogleCredential;
    try {
      credential = await signInWithGoogle();
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return message === "cancelled" ? { cancelled: true } : { error: message };
    }
    // Back to the app from the browser.
    if (!ctl.win.isDestroyed()) {
      if (ctl.win.isMinimized()) ctl.win.restore();
      ctl.win.show();
      ctl.win.focus();
    }
    if (process.platform === "darwin") app.focus({ steal: true });
    return { credential };
  });
  onSend("auth:cancel", () => cancelSignIn());

  // ── Links, theme ──
  onSend("shell:open-external", (_c, p) => {
    const url = str(p?.url, 4096);
    if (url && /^(https?:\/\/|mailto:)/i.test(url)) void shell.openExternal(url);
  });
  onInvoke("theme:set", (_c, preference) => {
    if (preference !== "system" && preference !== "light" && preference !== "dark") throw new Error("theme:set: system, light or dark");
    return setThemePreference(preference);
  });

  // ── A native menu for a view (a menu that wouldn't fit inside it) ──
  onInvoke("menu:popup", ({ ctl, sender }, p) => popupMenu(ctl, sender, p));
}

/** The view's menu, built from plain data (labels, ids, checks — nothing that runs), at the view's point: the picked id, or null. */
function popupMenu(ctl: WindowController, sender: WebContents, p: { template: NativeMenuItem[]; x: number; y: number }): Promise<string | null> {
  return new Promise((resolve) => {
    let picked: string | null = null;
    const build = (items: unknown, depth: number): MenuItemConstructorOptions[] =>
      (Array.isArray(items) ? (items as NativeMenuItem[]) : []).slice(0, 200).map((i) => {
        if (i?.type === "separator") return { type: "separator" };
        const id = str(i?.id, 200);
        const sub = i?.type === "submenu" || Array.isArray(i?.submenu) ? (depth < 4 ? build(i.submenu, depth + 1) : []) : null;
        return {
          label: str(i?.label, 300) ?? "",
          type: sub ? "submenu" : i?.type === "checkbox" ? "checkbox" : "normal",
          checked: i?.checked === true,
          enabled: i?.enabled !== false,
          accelerator: str(i?.accelerator, 64) ?? undefined,
          // Shown only: the accelerator is the menu bar's to act on.
          registerAccelerator: false,
          ...(sub ? { submenu: sub } : { click: () => (picked = id) }),
        };
      });
    const view = [ctl.tabbar, ...ctl.tabs.contentViews()].find((v) => v.webContents === sender);
    const origin = view?.getBounds() ?? { x: 0, y: 0 };
    Menu.buildFromTemplate(build(p?.template, 0)).popup({
      window: ctl.win,
      x: Math.round(origin.x + (Number(p?.x) || 0)),
      y: Math.round(origin.y + (Number(p?.y) || 0)),
      // The pick's click may come just after the menu closes.
      callback: () => setTimeout(() => resolve(picked), 0),
    });
  });
}
