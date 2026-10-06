import { app, ipcMain, Menu, shell, type IpcMainEvent, type IpcMainInvokeEvent, type MenuItemConstructorOptions, type WebContents } from "electron";
import { INVOKE_ROLES, SEND_ROLES, type IpcInvoke, type IpcSend, type NativeMenuItem, type Role } from "../shared/ipc";
import { isFileKey } from "../shared/tabs";
import { fontIndex, readFont } from "./fonts";
import { isAppUrl } from "./protocol";
import { workspaceDir } from "./storeHost";
import { setThemePreference, themeState } from "./theme";
import { settleFlush } from "./tabs";
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
const folderOf = (v: unknown) => (v === null || v === undefined ? null : str(v, 64));

export function registerIpc() {
  // ── Init and window ──
  onInvoke("desktop:init", ({ info, ctl }) => ({ version: app.getVersion(), platform: process.platform, role: info.role, tabId: info.tabId, fileKey: info.fileKey, windowId: ctl.id, theme: themeState() }));
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
  onSend("tabs:reopen", ({ ctl }) => void ctl.tabs.reopen());

  // ── Navigation ──
  onInvoke("nav:open-file", ({ ctl }, file) => {
    if (!isFileKey(file?.fileKey)) throw new Error("nav:open-file: not a file key");
    return ctl.tabs.openFile({ fileKey: file.fileKey, title: str(file.title, 300) ?? undefined, background: file.background === true, pageId: str(file.pageId, 64) ?? undefined, nodeId: str(file.nodeId, 64) ?? undefined });
  });
  onInvoke("nav:new-file", ({ ctl }, p) => ctl.tabs.newFile({ folderId: folderOf(p?.folderId), name: str(p?.name, 300) ?? undefined }));
  onSend("nav:go-home", ({ ctl, info }, p) => {
    // "Back to files": Home shows the file it came from, unless told another.
    const reveal = str(p?.revealFileKey, 64);
    ctl.tabs.goHome(reveal && isFileKey(reveal) ? reveal : (info.fileKey ?? undefined));
  });

  // ── Files that need a native dialog or a path ──
  onInvoke("file:import", ({ ctl }, p) => ctl.tabs.importFiles(folderOf(p?.folderId), Array.isArray(p?.paths) ? p.paths.map((x) => str(x, 4096)).filter((x): x is string => x !== null) : undefined));
  onInvoke("file:save-local-copy", ({ ctl }, p) => {
    if (!isFileKey(p?.fileKey)) throw new Error("file:save-local-copy: not a file key");
    return ctl.tabs.saveLocalCopy(p.fileKey);
  });
  onSend("file:reveal-data-folder", () => void shell.openPath(workspaceDir()));

  // ── A file tab ──
  onSend("tab:report", ({ ctl, sender }, r) => {
    if (!r || typeof r !== "object") return;
    const status = r.status === "loading" || r.status === "ready" || r.status === "error" ? r.status : undefined;
    ctl.tabs.report(sender, { title: str(r.title, 300) ?? undefined, status, error: str(r.error, 2000) ?? undefined });
  });
  onSend("tab:flushed", ({ sender }, r) => {
    if (r && typeof r.reqId === "number") settleFlush(sender, { reqId: r.reqId, ok: r.ok === true, error: str(r.error, 2000) ?? undefined });
  });

  // ── The menu bar's state, from the views ──
  onSend("menu:state", ({ ctl, sender }, p) => {
    if (p && typeof p === "object") ctl.tabs.setMenuState(sender, p);
  });


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
  onInvoke("fonts:list", () => fontIndex());
  onInvoke("fonts:read", (_c, p) => {
    const id = str(p?.id, 64);
    if (!id) throw new Error("fonts:read: no id");
    return readFont(id);
  });
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
