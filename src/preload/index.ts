import { contextBridge, ipcRenderer, type IpcRendererEvent } from "electron";
import type { MenuCommand, NativeApi, SignInResult, ThemePreference } from "../shared/api";

/** A listener of a channel, and the way to stop it. */
function on<T>(channel: string, listener: (value: T) => void) {
  const handler = (_e: IpcRendererEvent, value: T) => listener(value);
  ipcRenderer.on(channel, handler);
  return () => {
    ipcRenderer.removeListener(channel, handler);
  };
}

const api: NativeApi = {
  platform: process.platform,
  // Handed over by the window's settings (main's additionalArguments): a sandboxed preload has no app module.
  version: process.argv.find((a) => a.startsWith("--designer-version="))?.split("=")[1] ?? "",
  signInWithGoogle: async () => {
    const result: SignInResult = await ipcRenderer.invoke("auth:google");
    if ("credential" in result) return result.credential;
    throw new Error("cancelled" in result ? "cancelled" : result.error);
  },
  cancelSignIn: () => ipcRenderer.send("auth:cancel"),
  openExternal: (url: string) => ipcRenderer.send("shell:open-external", url),
  setTheme: (theme: ThemePreference) => ipcRenderer.send("theme:set", theme),
  setCloseGuard: (on: boolean) => ipcRenderer.send("window:guard", on),
  closeWindow: () => ipcRenderer.send("window:close"),
  cancelClose: () => ipcRenderer.send("window:close-cancel"),
  onMenuCommand: (listener: (command: MenuCommand) => void) => on("menu:command", listener),
  onCloseRequested: (listener: () => void) => on("window:close-requested", listener),
  onFullScreen: (listener: (fullScreen: boolean) => void) => on("window:fullscreen", listener),
  isFullScreen: () => ipcRenderer.invoke("window:is-fullscreen"),
};

contextBridge.exposeInMainWorld("designer", api);
