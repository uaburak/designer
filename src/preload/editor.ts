import { contextBridge } from "electron";
import type { EditorApi } from "../shared/desktop";
import type { FlushReason } from "../shared/ipc";
import { common, files, forwardStorePort, nav, on, openExternal, send, viewMenu } from "./common";

/**
 * A file tab's view (`?editor&file=<fileKey>`). The file saves as it goes:
 * main asks it to flush (`tab:flush` → `tab:flushed`) before it closes, on
 * quit and when it is hidden. Its tab id is main's — main knows which view
 * sent what, so the page never names its own tab.
 */
forwardStorePort();

type Flusher = (reason: FlushReason) => void | Promise<void>;
let flusher: Flusher | null = null;

const message = (err: unknown) => (err instanceof Error ? err.message : String(err));

// Main's flush: the page's handler sends what it holds and awaits the store; no handler yet — nothing to send.
on("tab:flush", ({ reqId, reason }) => {
  void (async () => {
    try {
      if (flusher) await flusher(reason);
      send("tab:flushed", { reqId, ok: true });
    } catch (err) {
      send("tab:flushed", { reqId, ok: false, error: message(err) });
    }
  })();
});

const base = common("editor");

const api: EditorApi = {
  ...base,
  tab: {
    report: (r) => send("tab:report", { title: r.title === undefined ? undefined : String(r.title), status: r.status, error: r.error === undefined ? undefined : String(r.error) }),
    onVisibility: (cb) => on("tab:visibility", cb),
    onFlush: (cb) => {
      flusher = cb;
      return () => {
        if (flusher === cb) flusher = null;
      };
    },
    close: () => send("tabs:close", { tabId: "" }),
  },
  nav: {
    ...nav,
    goHome: (revealFileKey) => send("nav:go-home", revealFileKey === undefined ? {} : { revealFileKey: String(revealFileKey) }),
  },
  files,
  menu: viewMenu(base.menu),
  openExternal,
};

contextBridge.exposeInMainWorld("designer", api);
