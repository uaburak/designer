import { contextBridge } from "electron";
import type { HomeApi } from "../shared/desktop";
import { agentSetupApi, figmaConnectionApi, aiSetupApi, common, files, forwardStorePort, invoke, nav, on, openExternal, send, sharedFontsApi, uploadedFonts, viewMenu } from "./common";

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
  nav: { ...nav, openDeveloper: () => send("nav:open-developer") },
  files,
  home: {
    onState: (cb) => on("home:state", cb),
    onReveal: (cb) => on("home:reveal", cb),
    onOpenShared: (cb) => on("home:open-shared", cb),
  },
  menu: viewMenu(base.menu),
  openExternal,
  // Settings (src/renderer/src/settings): uploaded fonts with their bytes for the samples, and Agents' setup.
  fonts: { read: (id) => invoke("fonts:read", { id: String(id) }), ...uploadedFonts, ...sharedFontsApi },
  agents: agentSetupApi(),
  figma: figmaConnectionApi,
  ai: aiSetupApi(),
};

contextBridge.exposeInMainWorld("designer", api);
