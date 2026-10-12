import { contextBridge } from "electron";
import type { WelcomeApi } from "../shared/desktop";
import { common } from "./common";

/** The signed-out window's view (docs/desktop.md §18.6): the account and the theme only — no store, no files, no tabs. */
const api: WelcomeApi = common("welcome");

contextBridge.exposeInMainWorld("designer", api);
