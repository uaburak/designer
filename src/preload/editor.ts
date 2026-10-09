import { contextBridge, webFrame } from "electron";
import type { EditorApi } from "../shared/desktop";
import type { FlushReason, TabAttach } from "../shared/ipc";
import { common, files, forwardStorePort, invoke, nav, on, openExternal, send, viewMenu } from "./common";

/**
 * A file tab's view (`?editor&file=<fileKey>`), or the spare editor (`?editor`
 * alone, docs/desktop.md §3.1), which learns its file from `tab:attach` when
 * main adopts it. The file saves as it goes: main asks it to flush
 * (`tab:flush` → `tab:flushed`) before it closes, on quit and when it is
 * hidden. Its tab id is main's — main knows which view sent what, so the
 * page never names its own tab.
 */
forwardStorePort();

// Main's attach may come before the page registered its handler (the spare is adopted while its page is still coming
// up): it is held, as the store port is, and handed over when the handler registers.
type Attacher = (a: TabAttach) => void;
let attacher: Attacher | null = null;
let heldAttach: TabAttach | null = null;

/** Only what the contract names, as plain data. */
const plainAttach = (a: TabAttach): TabAttach | null => {
  if (!a || typeof a !== "object" || typeof a.tabId !== "string" || typeof a.fileKey !== "string") return null;
  const opt = (v: unknown) => (typeof v === "string" ? v : undefined);
  return { tabId: a.tabId, fileKey: a.fileKey, mode: a.mode === "prototype" ? "prototype" : "edit", pageId: opt(a.pageId), nodeId: opt(a.nodeId), startNodeId: opt(a.startNodeId) };
};

on("tab:attach", (raw) => {
  const a = plainAttach(raw);
  if (!a) return;
  if (attacher) attacher(a);
  else heldAttach = a;
});

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
    onAttach: (cb) => {
      attacher = cb;
      const held = heldAttach;
      heldAttach = null;
      if (held) cb(held);
      return () => {
        if (attacher === cb) attacher = null;
      };
    },
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
    openPrototype: (fileKey, pageId, startNodeId, title) =>
      invoke("nav:open-prototype", { fileKey: String(fileKey), pageId: String(pageId), startNodeId: startNodeId === undefined ? undefined : String(startNodeId), title: title === undefined ? undefined : String(title) }),
    goHome: (revealFileKey) => send("nav:go-home", revealFileKey === undefined ? {} : { revealFileKey: String(revealFileKey) }),
  },
  files,
  menu: viewMenu(base.menu),
  openExternal,
  fonts: {
    list: () => invoke("fonts:list"),
    read: (id) => invoke("fonts:read", { id: String(id) }),
    preview: (family, text) => invoke("fonts:preview", { family: String(family), text: String(text) }),
    onChanged: (cb) => on("fonts:changed", () => cb()),
  },
  // Text › Spell check: the view's own spell checker (webPreferences.spellcheck, src/main/views.ts), at most 2000 words a call.
  spelling: {
    misspelled: (words) => (Array.isArray(words) ? words.slice(0, 2000) : []).map((w) => typeof w === "string" && w.length < 64 && webFrame.isWordMisspelled(w)),
  },
};

contextBridge.exposeInMainWorld("designer", api);
