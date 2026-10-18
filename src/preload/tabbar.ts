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
    mainMenu: (x, y) => send("tabs:main-menu", { x: Number(x), y: Number(y) }),
    reopen: () => send("tabs:reopen"),
    newFile: () => void invoke("nav:new-file", { folderId: null }).catch(() => {}),
    newTab: () => send("tabs:new-tab"),
    groupMenu: (groupId, x, y) => send("tabs:group-menu", { groupId: String(groupId), x: Number(x), y: Number(y) }),
    renameGroup: (groupId, name) => send("tabs:group-rename", { groupId: String(groupId), name: String(name) }),
    listMenu: (x, y) => send("tabs:list-menu", { x: Number(x), y: Number(y) }),
    onEditGroup: (cb) => on("tabs:edit-group", cb),
  },
  updates: {
    get: () => invoke("updater:get"),
    onState: (cb) => on("updater:state", cb),
    check: () => send("updater:check"),
    restart: () => send("updater:restart"),
  },
};

contextBridge.exposeInMainWorld("designer", api);
