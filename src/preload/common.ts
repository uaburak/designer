import { ipcRenderer, webUtils, type IpcRendererEvent } from "electron";
import type { IpcEvents, IpcInvoke, IpcSend, MenuStatePatch, NativeMenuItem, OpenWorkspaceFile, Role, ThemePreference, ThemeState } from "../shared/ipc";
import type { FilesApi, NavApi, SharedFontsApi, ViewMenuApi } from "../shared/desktop";
import type { AccountMethod, SignInMethod } from "../shared/account";
import type { AgentSetupApi, McpClientId } from "../shared/agents/types";
import type { AiSetupApi } from "../shared/ai/api";

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

/** `--designer-theme=<preference>:<resolved>[:contrast]` */
function bootTheme(): ThemeState {
  const [preference, resolved, contrast] = arg("designer-theme").split(":");
  return {
    preference: preference === "light" || preference === "dark" ? preference : "system",
    resolved: resolved === "dark" ? "dark" : "light",
    contrast: contrast === "contrast",
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
    setContrast: (on: boolean) => invoke("theme:set-contrast", on === true),
    onThemeChanged: (cb: (t: ThemeState) => void) => on("theme:changed", cb),
    onWindowState: (cb: (s: IpcEvents["window:state"]) => void) => on("window:state", cb),
    onFullScreen: (cb: (fullScreen: boolean) => void) => on("window:state", (s) => cb(s.fullScreen)),
    haptics: { tick: () => send("haptics:tick") },
    account: {
      get: () => invoke("account:get"),
      signIn: (opts?: { tenant?: string; method?: SignInMethod }) =>
        invoke("account:sign-in", ...(opts && typeof opts.tenant === "string" ? [{ tenant: String(opts.tenant) }] : opts?.method === "google" || opts?.method === "sso" ? [{ method: opts.method }] : [])),
      cancelSignIn: () => invoke("account:cancel-sign-in"),
      signOut: () => invoke("account:sign-out"),
      // Several accounts (docs/desktop.md §18.7)
      switchTo: (userId: string) => invoke("account:switch", String(userId ?? "").slice(0, 128)),
      signOutAll: () => invoke("account:sign-out-all"),
      onChanged: (cb: (s: IpcEvents["account:changed"]) => void) => on("account:changed", cb),
      // The idle timeout's prompt (docs/desktop.md §18.2)
      staySignedIn: () => invoke("account:stay-signed-in"),
      onIdle: (cb: (n: IpcEvents["account:idle"]) => void) => on("account:idle", cb),
      request: (r: { method: AccountMethod; path: string; body?: unknown }) => invoke("account:request", { method: r?.method, path: String(r?.path ?? ""), body: r?.body === undefined ? undefined : (JSON.parse(JSON.stringify(r.body)) as unknown) }),
    },
    menu: {
      popup: (template: NativeMenuItem[], at: { x: number; y: number }) => invoke("menu:popup", { template: plainMenu(template), x: Number(at?.x) || 0, y: Number(at?.y) || 0 }),
    },
  };
}

export const openExternal = (url: string) => send("shell:open-external", { url: String(url) });

/** Settings › Account › Your uploaded fonts (Home and editors). */
export const uploadedFonts = {
  uploaded: () => invoke("fonts:uploaded"),
  upload: () => invoke("fonts:upload"),
  removeUploaded: (id: string) => invoke("fonts:remove-uploaded", { id: String(id) }),
};

/** Organization and team fonts (docs/desktop.md §14.3; Home and editors): plain data both ways, main checks it again. */
const plain = <T>(v: T): T => JSON.parse(JSON.stringify(v ?? null)) as T;
export const sharedFontsApi: SharedFontsApi = {
  sharedList: (scope) => invoke("fonts:shared-list", { scope: plain(scope) }),
  sharedPick: (scope) => invoke("fonts:shared-pick", { scope: plain(scope) }),
  sharedUpload: (req) => invoke("fonts:shared-upload", plain(req)),
  sharedRemove: (req) => invoke("fonts:shared-remove", plain(req)),
};

/** Agents' setup (Settings › Agents, the Agents tab's settings): plain data both ways. */
export function agentSetupApi(): AgentSetupApi {
  return {
    providers: () => invoke("agents:providers"),
    settings: () => invoke("agents:settings"),
    setSettings: (patch) => invoke("agents:set-settings", { providerId: patch?.providerId === null ? null : patch?.providerId === undefined ? undefined : String(patch.providerId), models: patch?.models }),
    addServer: (s) => invoke("agents:add-server", { label: String(s?.label ?? ""), baseUrl: String(s?.baseUrl ?? ""), apiKey: s?.apiKey === undefined ? undefined : String(s.apiKey) }),
    removeServer: (id) => invoke("agents:remove-server", { id: String(id) }),
    test: (providerId) => invoke("agents:test", { providerId: String(providerId) }),
    auth: (providerId) => invoke("agents:auth", { providerId: String(providerId) }),
    signIn: (providerId) => invoke("agents:sign-in", { providerId: String(providerId) }),
    signOut: (providerId) => invoke("agents:sign-out", { providerId: String(providerId) }),
    install: (providerId) => invoke("agents:install", { providerId: String(providerId) }),
    mcp: () => invoke("agents:mcp"),
    onMcpState: (cb) => on("agents:mcp-state", cb),
    clients: () => invoke("agents:clients"),
    connect: (client: McpClientId) => invoke("agents:connect", { client }),
    disconnect: (client: McpClientId) => invoke("agents:disconnect", { client }),
    clientConfig: (client: McpClientId) => invoke("agents:client-config", { client }),
    connectors: () => invoke("agents:connectors"),
    addConnector: (c) => invoke("agents:add-connector", plain(c)),
    updateConnector: (p) => invoke("agents:update-connector", plain(p)),
    removeConnector: (id) => invoke("agents:remove-connector", { id: String(id) }),
    testConnector: (id) => invoke("agents:test-connector", { id: String(id) }),
  };
}

/** Main's AI setup (Settings › AI): plain data both ways. */
export function aiSetupApi(): AiSetupApi {
  return {
    settings: () => invoke("ai:settings"),
    setSettings: (patch) => invoke("ai:set-settings", plain(patch ?? {})),
    setImageKey: (provider, key) => invoke("ai:set-image-key", { provider, key: key === null ? null : String(key) }),
    models: () => invoke("ai:models"),
    modelDownload: (id) => invoke("ai:model-download", { id }),
    modelRemove: (id) => invoke("ai:model-remove", { id }),
    onModelState: (cb) => on("ai:model-state", cb),
    imageRoutes: () => invoke("ai:image-routes"),
  };
}


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
  exportAssets: (list) =>
    invoke("file:export-assets", {
      files: (Array.isArray(list) ? list : []).map((f) => ({ name: String(f?.name ?? ""), bytes: f?.bytes instanceof Uint8Array ? f.bytes : new Uint8Array(0) })),
    }),
  exportPreview: (r) =>
    invoke("file:export-preview", {
      fileKey: String(r?.fileKey),
      snapshot: r?.snapshot instanceof Uint8Array ? r.snapshot : new Uint8Array(),
      options: { pageIds: Array.isArray(r?.options?.pageIds) ? r.options.pageIds.map(String) : "all", inspect: r?.options?.inspect !== false, export: r?.options?.export !== false },
    }),
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
