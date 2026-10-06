import { ipcRenderer, type IpcRendererEvent } from "electron";
import type { IpcEvents, IpcInvoke, IpcSend, NativeMenuItem, Role, ThemeState } from "../shared/ipc";
import type { ThemePreference } from "../shared/api";

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

