import { ipcRenderer, webUtils, type IpcRendererEvent } from "electron";
import type { IpcEvents, IpcInvoke, IpcSend, MenuStatePatch, NativeMenuItem, OpenWorkspaceFile, Role, ThemePreference, ThemeState } from "../shared/ipc";
import type { FilesApi, NavApi, ViewMenuApi } from "../shared/desktop";

/**
 * What every role's preload shares (each preload is bundled on its own —
 * electron-vite's isolatedEntries — since a sandboxed preload can't load a
 * shared chunk): typed send/invoke/on over the contract in src/shared/ipc.ts,
 * and the calls every role has.
 */

/** A listener of one of main's events, and the way to stop it. */
export function on<C extends keyof IpcEvents>(channel: C, listener: (value: IpcEvents[C]) => void) {
  const handler = (_e: IpcRendererEvent, value: IpcEvents[C]) => listener(value);
  ipcRenderer.on(channel, handler);
  return () => {
    ipcRenderer.removeListener(channel, handler);
  };
}

export function invoke<C extends keyof IpcInvoke>(channel: C, ...args: IpcInvoke[C]["args"]): Promise<IpcInvoke[C]["result"]> {
  return ipcRenderer.invoke(channel, ...args);
}

export function send<C extends keyof IpcSend>(channel: C, ...payload: IpcSend[C] extends void ? [] : [IpcSend[C]]) {
  ipcRenderer.send(channel, ...payload);
}

/** Handed over by main's additionalArguments: a sandboxed preload has no app module. */
const arg = (name: string) => process.argv.find((a) => a.startsWith(`--${name}=`))?.slice(name.length + 3) ?? "";

/** `--designer-theme=<preference>:<resolved>` */
function bootTheme(): ThemeState {
  const [preference, resolved] = arg("designer-theme").split(":");
  return {
    preference: preference === "light" || preference === "dark" ? preference : "system",
    resolved: resolved === "dark" ? "dark" : "light",
  };
}

/** A menu's items as plain data (no functions cross to main). */
function plainMenu(items: NativeMenuItem[], depth = 0): NativeMenuItem[] {
  if (!Array.isArray(items) || depth > 4) return [];
  return items.slice(0, 200).map((i) => ({
    id: i.id === undefined ? undefined : String(i.id),
    label: i.label === undefined ? undefined : String(i.label),
    type: i.type,
    checked: i.checked === undefined ? undefined : Boolean(i.checked),
    enabled: i.enabled === undefined ? undefined : Boolean(i.enabled),
    accelerator: i.accelerator === undefined ? undefined : String(i.accelerator),
    submenu: i.submenu ? plainMenu(i.submenu, depth + 1) : undefined,
  }));
}

export function common<R extends Role>(role: R) {
  return {
    role,
    platform: process.platform,
    version: arg("designer-version"),
    init: () => invoke("desktop:init"),
    ready: () => send("shell:ready"),
    theme: bootTheme(),
    setTheme: (preference: ThemePreference) => invoke("theme:set", preference),
    onThemeChanged: (cb: (t: ThemeState) => void) => on("theme:changed", cb),
    onWindowState: (cb: (s: IpcEvents["window:state"]) => void) => on("window:state", cb),
    onFullScreen: (cb: (fullScreen: boolean) => void) => on("window:state", (s) => cb(s.fullScreen)),
    menu: {
      popup: (template: NativeMenuItem[], at: { x: number; y: number }) => invoke("menu:popup", { template: plainMenu(template), x: Number(at?.x) || 0, y: Number(at?.y) || 0 }),
    },
  };
}

export const openExternal = (url: string) => send("shell:open-external", { url: String(url) });


// ── Home and editors ──────────────────────────────────────────────────────────

const STORE_PORT = "designer:store-port";
const STORE_PORT_WANTED = "designer:store-port-wanted";

/**
 * The store's MessagePort, handed to the page (docs/desktop.md §10.2 "Store
 * port"). Main sends a fresh one on every page load and after every store
 * restart. A port is held until the page says it listens
 * (`designer:store-port-wanted`, posted by `@/store/client`), so a client made
 * after the port arrived still gets it; once the page listens, each new port
 * goes straight through.
 */
type Port = IpcRendererEvent["ports"][number];

/** The page's window, as the preload (in its isolated world) sees it — tsconfig.node.json has no DOM types. */
const page = globalThis as unknown as {
  location: { origin: string };
  postMessage(message: unknown, targetOrigin: string, transfer: Port[]): void;
  addEventListener(type: "message", listener: (e: { origin: string; data: unknown }) => void): void;
};

export function forwardStorePort() {
  let wanted = false;
  let held: { generation: number; port: Port } | null = null;
  const hand = () => {
    if (!held) return;
    page.postMessage({ type: STORE_PORT, generation: held.generation }, page.location.origin, [held.port]);
    held = null;
  };
  ipcRenderer.on("store:port", (e, payload: IpcEvents["store:port"]) => {
    const port = e.ports[0];
    if (!port) return;
    // An older port the page never took: its store is gone (or replaced) anyway.
    held?.port.close();
    held = { generation: Number(payload?.generation) || 0, port };
    if (wanted) hand();
  });
  page.addEventListener("message", (e) => {
    if (e.origin !== page.location.origin || (e.data as { type?: unknown } | null)?.type !== STORE_PORT_WANTED) return;
    wanted = true;
    hand();
  });
}

const optStr = (v: unknown) => (v === undefined || v === null ? undefined : String(v));

export const nav: NavApi = {
  openFile: ((file: string | OpenWorkspaceFile, options?: Omit<OpenWorkspaceFile, "fileKey">) => {
    const target = typeof file === "string" ? { ...options, fileKey: file } : file;
    return invoke("nav:open-file", {
      fileKey: String(target.fileKey),
      title: optStr(target.title),
      background: target.background === true,
      pageId: optStr(target.pageId),
      nodeId: optStr(target.nodeId),
    });
  }) as NavApi["openFile"],
  newFile: (folderId, name) => invoke("nav:new-file", { folderId: folderId === undefined || folderId === null ? null : String(folderId), name: optStr(name) }),
};

export const files: FilesApi = {
  import: (folderId, paths) => invoke("file:import", { folderId: folderId === null || folderId === undefined ? null : String(folderId), paths: Array.isArray(paths) ? paths.map(String) : undefined }),
  saveLocalCopy: (fileKey) => invoke("file:save-local-copy", { fileKey: String(fileKey) }),
  pathFor: (file) => webUtils.getPathForFile(file),
  revealDataFolder: () => send("file:reveal-data-folder"),
};

/** Only booleans under string keys: what crosses to main is plain data. */
function plainState(patch: MenuStatePatch | undefined): MenuStatePatch {
  const pick = (m: unknown) => {
    if (!m || typeof m !== "object") return undefined;
    const out: Record<string, boolean> = {};
    for (const [k, v] of Object.entries(m as Record<string, unknown>).slice(0, 500)) if (typeof v === "boolean" && k.length <= 100) out[k] = v;
    return out;
  };
  return { enabled: pick(patch?.enabled), checked: pick(patch?.checked) };
}

/** The view's menu: popup, menu commands, and its menu state — patches merged and sent once per tick. */
export function viewMenu(base: { popup: ViewMenuApi["popup"] }): ViewMenuApi {
  let queued: { enabled: Record<string, boolean>; checked: Record<string, boolean> } | null = null;
  return {
    popup: base.popup,
    onCommand: (cb) => on("menu:command", cb),
    setState: (patch) => {
      const p = plainState(patch);
      const first = !queued;
      queued ??= { enabled: {}, checked: {} };
      Object.assign(queued.enabled, p.enabled);
      Object.assign(queued.checked, p.checked);
      if (!first) return;
      setTimeout(() => {
        const q = queued;
        queued = null;
        if (q) send("menu:state", q as MenuStatePatch);
      }, 16);
    },
  };
}
