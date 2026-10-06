import { contextBridge } from "electron";
import type { HomeApi } from "../shared/desktop";
import { common, invoke, on, openExternal, send } from "./common";

/** Home's view (the file browser, and the sign-in until the data layer replaces it). */
const base = common("home");

const api: HomeApi = {
  ...base,
  tabs: {
    get: () => invoke("tabs:get"),
    onState: (cb) => on("tabs:state", cb),
    activate: (tabId) => send("tabs:activate", { tabId: String(tabId) }),
    reopen: () => send("tabs:reopen"),
  },
  nav: { openFile: (file) => invoke("nav:open-file", { kind: file.kind, slug: String(file.slug), title: file.title === undefined ? undefined : String(file.title) }) },
  home: { onState: (cb) => on("home:state", cb) },
  menu: { ...base.menu, onCommand: (cb) => on("menu:command", cb) },
  session: {
    auth: (signedIn) => send("session:auth", { signedIn: signedIn === true }),
    requestSignOut: () => send("session:request-sign-out"),
    onSignOut: (cb) => on("session:sign-out", cb),
  },
  signInWithGoogle: async () => {
    const result = await invoke("auth:google");
    if ("credential" in result) return result.credential;
    throw new Error("cancelled" in result ? "cancelled" : result.error);
  },
  cancelSignIn: () => send("auth:cancel"),
  openExternal,
};

contextBridge.exposeInMainWorld("designer", api);
