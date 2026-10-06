import { contextBridge } from "electron";
import type { EditorApi } from "../shared/desktop";
import { common, invoke, on, openExternal, send } from "./common";

/**
 * A file tab's view: it reports its name and unsaved state, answers main's
 * questions (unsaved? save!), takes menu commands. Its tab id is main's —
 * main knows which view sent what, so the page never names its own tab.
 */

type Answer = (op: "is-dirty" | "save") => boolean | Promise<boolean>;
let answer: Answer | null = null;

// Main's question, answered by the page's handler (or "nothing unsaved" before the page has one).
on("tab:request", ({ reqId, op }) => {
  void (async () => {
    try {
      const value = answer ? await answer(op) : op === "save";
      send("tab:response", { reqId, ok: true, value: value === true });
    } catch (err) {
      send("tab:response", { reqId, ok: false, error: err instanceof Error ? err.message : String(err) });
    }
  })();
});

const base = common("editor");

const api: EditorApi = {
  ...base,
  tab: {
    report: (r) => send("tab:report", { title: r.title === undefined ? undefined : String(r.title), dirty: r.dirty, status: r.status, savedAt: r.savedAt }),
    onVisibility: (cb) => on("tab:visibility", cb),
    onRequest: (cb) => {
      answer = cb;
      return () => {
        if (answer === cb) answer = null;
      };
    },
    close: () => send("tabs:close", { tabId: "" }),
  },
  nav: {
    openFile: (file) => invoke("nav:open-file", { kind: file.kind, slug: String(file.slug), title: file.title === undefined ? undefined : String(file.title) }),
    goHome: () => send("nav:go-home"),
    newFile: () => send("nav:new-file"),
  },
  menu: { ...base.menu, onCommand: (cb) => on("menu:command", cb) },
  session: { requestSignOut: () => send("session:request-sign-out") },
  openExternal,
};

contextBridge.exposeInMainWorld("designer", api);
