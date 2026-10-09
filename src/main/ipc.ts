import { app, ipcMain, Menu, shell, type IpcMainEvent, type IpcMainInvokeEvent, type MenuItemConstructorOptions, type WebContents } from "electron";
import { INVOKE_ROLES, SEND_ROLES, type IpcInvoke, type IpcSend, type NativeMenuItem, type Role } from "../shared/ipc";
import { isFileKey } from "../shared/tabs";
import type { McpClientId } from "../shared/agents/types";
import * as agents from "./agents/host";
import { exportAssets } from "./files";
import { fontIndex, readFont } from "./fonts";
import { googlePreview } from "./googleFonts";
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
  onInvoke("nav:open-prototype", ({ ctl }, p) => {
    if (!isFileKey(p?.fileKey)) throw new Error("nav:open-prototype: not a file key");
    const guid = (v: unknown) => (typeof v === "string" && /^\d+:\d+$/.test(v) ? v : undefined);
    const pageId = guid(p.pageId);
    if (!pageId) throw new Error("nav:open-prototype: not a page");
    return ctl.tabs.openPrototype({ fileKey: p.fileKey, pageId, startNodeId: guid(p.startNodeId), title: str(p.title, 300) ?? undefined });
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
  onInvoke("file:export-assets", ({ ctl }, p) => {
    const list = Array.isArray(p?.files) ? p.files : null;
    if (!list || !list.length || list.length > 5000) throw new Error("file:export-assets: no files");
    let total = 0;
    const files = list.map((f) => {
      const name = str(f?.name, 2000);
      if (!name || !(f.bytes instanceof Uint8Array)) throw new Error("file:export-assets: not a file");
      total += f.bytes.length;
      return { name, bytes: f.bytes };
    });
    if (total > 4 * 1024 * 1024 * 1024) throw new Error("file:export-assets: too large");
    return exportAssets(ctl.win, files);
  });
  onInvoke("file:export-preview", ({ ctl }, p) => {
    if (!isFileKey(p?.fileKey)) throw new Error("file:export-preview: not a file key");
    if (!(p.snapshot instanceof Uint8Array) || p.snapshot.length === 0 || p.snapshot.length > 1 << 30) throw new Error("file:export-preview: not a snapshot");
    const pageIds = Array.isArray(p.options?.pageIds) ? p.options.pageIds.map((x) => str(x, 64)).filter((x): x is string => x !== null).slice(0, 1000) : "all";
    return ctl.tabs.exportPreview(p.fileKey, p.snapshot, { pageIds, inspect: p.options?.inspect !== false, export: p.options?.export !== false });
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
  // ── Agents (src/main/agents/host.ts): a view's file is main's to name — never the page's ──
  registerAgentsIpc();

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
    const id = str(p?.id, 300);
    if (!id) throw new Error("fonts:read: no id");
    return readFont(id);
  });
  onInvoke("fonts:preview", (_c, p) => {
    const family = str(p?.family, 200);
    const text = str(p?.text, 200);
    if (!family || !text) throw new Error("fonts:preview: a family and a text");
    return googlePreview(family, text);
  });
}

const CLIENT_IDS: readonly McpClientId[] = ["claude-code", "cursor", "vscode", "antigravity", "codex"];
const clientId = (v: unknown): McpClientId => {
  if (!CLIENT_IDS.includes(v as McpClientId)) throw new Error("agents: unknown client");
  return v as McpClientId;
};
const watched = new WeakSet<WebContents>();

function registerAgentsIpc() {
  onInvoke("agents:providers", () => agents.providers());
  onInvoke("agents:settings", () => agents.agentSettings());
  onInvoke("agents:set-settings", (_c, p) => agents.setAgentSettings({ providerId: p?.providerId === null ? null : (str(p?.providerId, 100) ?? undefined), models: p?.models && typeof p.models === "object" ? p.models : undefined }));
  onInvoke("agents:add-server", (_c, p) => agents.addServer({ label: str(p?.label, 100) ?? "", baseUrl: str(p?.baseUrl, 2000) ?? "", apiKey: str(p?.apiKey, 4000) ?? undefined }));
  onInvoke("agents:remove-server", (_c, p) => agents.removeServer(str(p?.id, 100) ?? ""));
  onInvoke("agents:test", (_c, p) => agents.testProvider(str(p?.providerId, 100) ?? ""));
  onInvoke("agents:auth", (_c, p) => agents.authStatus(str(p?.providerId, 100) ?? ""));
  onInvoke("agents:sign-in", (_c, p) => agents.signIn(str(p?.providerId, 100) ?? ""));
  onInvoke("agents:sign-out", (_c, p) => agents.signOut(str(p?.providerId, 100) ?? ""));
  onInvoke("agents:install", (_c, p) => agents.install(str(p?.providerId, 100) ?? ""));
  onInvoke("agents:turn", ({ info, sender }, req) => {
    if (!info.fileKey) throw new Error("agents:turn: no file in this view");
    const prompt = str(req?.prompt, 100_000);
    if (!prompt || !str(req?.providerId, 100) || !str(req?.chatId, 100)) throw new Error("agents:turn: a chat, a provider and a prompt");
    if (!watched.has(sender)) {
      watched.add(sender);
      sender.once("destroyed", () => agents.viewGone(sender));
    }
    const sel = Array.isArray(req.context?.selection) ? req.context.selection.slice(0, 50) : [];
    return agents.startTurn(sender, info.fileKey, {
      chatId: req.chatId,
      providerId: req.providerId,
      model: str(req.model, 300) ?? undefined,
      prompt,
      resume: str(req.resume, 200) ?? undefined,
      history: (Array.isArray(req.history) ? req.history : []).slice(-40).map((m) => ({ role: m?.role === "assistant" ? "assistant" : "user", text: str(m?.text, 100_000) ?? "" })),
      context: {
        fileName: str(req.context?.fileName, 300) ?? "",
        pageName: str(req.context?.pageName, 300) ?? "",
        selection: sel.map((s) => ({ id: str(s?.id, 64) ?? "", name: str(s?.name, 300) ?? "", type: str(s?.type, 40) ?? "", width: Number(s?.width) || 0, height: Number(s?.height) || 0 })),
      },
    });
  });
  onInvoke("agents:stop", (_c, p) => agents.stopTurn(str(p?.turnId, 100) ?? ""));
  onInvoke("agents:mcp", () => agents.mcp());
  onInvoke("agents:clients", () => agents.clients());
  onInvoke("agents:connect", ({ sender }, p) => agents.connect(sender, clientId(p?.client)));
  onInvoke("agents:disconnect", (_c, p) => agents.disconnect(clientId(p?.client)));
  onInvoke("agents:client-config", (_c, p) => agents.clientConfig(clientId(p?.client)));
  onSend("agents:tool-result", ({ sender }, r) => {
    if (r && typeof r.reqId === "number") agents.settleToolCall(sender, r);
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
