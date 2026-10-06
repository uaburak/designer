import { contextBridge } from "electron";
import type { TabBarApi } from "../shared/desktop";
import { common, invoke, on, send } from "./common";

/** The tab bar's view: the tabs as main has them, and what a click asks of main. */
const api: TabBarApi = {
  ...common("tabbar"),
  tabs: {
    get: () => invoke("tabs:get"),
    onState: (cb) => on("tabs:state", cb),
    activate: (tabId) => send("tabs:activate", { tabId: String(tabId) }),
    close: (tabId) => send("tabs:close", { tabId: String(tabId) }),
    move: (tabId, toIndex) => send("tabs:move", { tabId: String(tabId), toIndex: Number(toIndex) }),
    contextMenu: (tabId, x, y) => send("tabs:context-menu", { tabId: String(tabId), x: Number(x), y: Number(y) }),
    reopen: () => send("tabs:reopen"),
    newFile: () => void invoke("nav:new-file", { folderId: null }).catch(() => {}),
  },
};

contextBridge.exposeInMainWorld("designer", api);
