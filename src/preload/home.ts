import { contextBridge } from "electron";
import type { HomeApi } from "../shared/desktop";
import { common, files, forwardStorePort, invoke, nav, on, openExternal, send, viewMenu } from "./common";

/** Home's view: the file browser, on the store over its own port. */
forwardStorePort();

const base = common("home");

const api: HomeApi = {
  ...base,
  tabs: {
    get: () => invoke("tabs:get"),
    onState: (cb) => on("tabs:state", cb),
    activate: (tabId) => send("tabs:activate", { tabId: String(tabId) }),
    reopen: () => send("tabs:reopen"),
  },
  nav,
  files,
  home: {
    onState: (cb) => on("home:state", cb),
    onReveal: (cb) => on("home:reveal", cb),
  },
  menu: viewMenu(base.menu),
  openExternal,
};

contextBridge.exposeInMainWorld("designer", api);
