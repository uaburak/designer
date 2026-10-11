/**
 * The plugin host's way to main (docs/plugins.md §3.3; main's side is src/main/plugins, round 5e): the `plugins:*`
 * channels of src/shared/ipc.ts, reached through the editor view's preload as `window.designer.plugins`. The preload
 * may expose them as one `invoke(channel, arg)` (and `on("plugins:changed")`) or as methods named after the channels
 * (`listDevelopment`, `importManifest`, …, `onChanged`); both are accepted. Null in a browser (no main).
 */
import type { DevelopmentPlugin, IpcInvoke, PluginFetchInit, PluginFetchResponse, PluginStorageCall } from "@shared/ipc";
import type { PluginBundle, PluginManifest } from "@shared/plugins/types";

export interface PluginDesktop {
  listDevelopment(): Promise<DevelopmentPlugin[]>;
  importManifest(): Promise<{ plugin: DevelopmentPlugin; manifest: PluginManifest } | { cancelled: true }>;
  removeDevelopment(id: string): Promise<DevelopmentPlugin[]>;
  read(id: string): Promise<PluginBundle>;
  openUi(args: { runId: string; html: string; allowedDomains: string[]; dev: boolean }): Promise<{ url: string }>;
  closeUi(runId: string): Promise<void>;
  fetch(args: { runId: string; url: string; init?: PluginFetchInit }): Promise<PluginFetchResponse>;
  storage(call: PluginStorageCall): Promise<unknown>;
  openConsole(): Promise<void>;
  /** A development plugin's files changed (Hot reload). Returns the unsubscribe. */
  onChanged(listener: (e: { id: string }) => void): () => void;
}

type Channel = Extract<keyof IpcInvoke, `plugins:${string}`>;
type Raw = {
  invoke?: <C extends Channel>(channel: C, ...args: IpcInvoke[C]["args"]) => Promise<IpcInvoke[C]["result"]>;
  on?: (channel: "plugins:changed", listener: (e: { id: string }) => void) => () => void;
} & Record<string, unknown>;

const METHOD: Record<Channel, string> = {
  "plugins:list-development": "listDevelopment",
  "plugins:import-manifest": "importManifest",
  "plugins:remove-development": "removeDevelopment",
  "plugins:read": "read",
  "plugins:open-ui": "openUi",
  "plugins:close-ui": "closeUi",
  "plugins:fetch": "fetch",
  "plugins:storage": "storage",
  "plugins:open-console": "openConsole",
};

/** Wraps whatever the preload gives into PluginDesktop. */
export function pluginDesktopFrom(raw: Raw): PluginDesktop {
  const call = <C extends Channel>(channel: C, ...args: IpcInvoke[C]["args"]): Promise<IpcInvoke[C]["result"]> => {
    if (typeof raw.invoke === "function") return raw.invoke(channel, ...args);
    const m = raw[METHOD[channel]];
    if (typeof m !== "function") return Promise.reject(new Error(`${channel} isn't available in this app`));
    return (m as (...a: unknown[]) => Promise<IpcInvoke[C]["result"]>)(...args);
  };
  return {
    listDevelopment: () => call("plugins:list-development"),
    importManifest: () => call("plugins:import-manifest"),
    removeDevelopment: (id) => call("plugins:remove-development", { id }),
    read: (id) => call("plugins:read", { id }),
    openUi: (args) => call("plugins:open-ui", args),
    closeUi: (runId) => call("plugins:close-ui", { runId }),
    fetch: (args) => call("plugins:fetch", args),
    storage: (c) => call("plugins:storage", c),
    openConsole: () => call("plugins:open-console"),
    onChanged: (listener) => {
      if (typeof raw.on === "function") return raw.on("plugins:changed", listener);
      if (typeof raw.onChanged === "function") return (raw.onChanged as (l: typeof listener) => () => void)(listener);
      return () => {};
    },
  };
}

/** The editor view's plugin channels, or null (a browser, Home, the viewer). */
export function pluginDesktop(): PluginDesktop | null {
  const d = (window as unknown as { designer?: { role?: string; plugins?: Raw } }).designer;
  if (d?.role !== "editor" || !d.plugins) return null;
  return pluginDesktopFrom(d.plugins);
}
