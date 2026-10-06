import { app, type WebContents } from "electron";
import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import type { WorkspaceEvent } from "../shared/store/repositories";
import type { StoreClient } from "../shared/store/client";
import { startStore, type StoreHandle } from "../store/host";

/**
 * The store (docs/desktop.md §1, §9; docs/data.md §7): the utility process
 * "DesignerV2 Store", the only writer of the workspace. Main starts it
 * before the first window, keeps its own client on it (workspace events for
 * tab titles and closing trashed files; import and export, which take paths)
 * and brokers one MessagePort per Home/editor page load. When it exits it
 * is started again — at most 3 times in 60 s — and every live view gets a
 * port to the new one (its client reattaches and resends by itself); a 4th
 * exit gives up (`onGiveUp`: “DesignerV2 can’t save changes right now.”).
 *
 * On quit it is flushed and shut down after the tabs have flushed
 * (stopStoreHost, from index.ts's will-quit).
 */

type ViewRole = "home" | "editor";

let store: StoreHandle | null = null;
const views = new Map<number, { wc: WebContents; role: ViewRole }>();
const listeners = new Set<(e: WorkspaceEvent) => void>();
let restarts: number[] = [];
let stopping = false;
let stopped: Promise<void> | null = null;
let giveUp: () => void = () => {};
let lastError: string | null = null;
/** Each start's number, never reused: a page's client drops a port older than the one it has */
let generation = 0;

/** The workspace: DESIGNER_WORKSPACE, else `<userData>/Workspace` (docs/data.md §3). */
export const workspaceDir = () => process.env.DESIGNER_WORKSPACE ?? join(app.getPath("userData"), "Workspace");

/** `DESIGNER_SEED=demo`: the sample .fig files go into an empty workspace (scripts/drive.mjs runs, the demo). */
function seedFigs(): string[] | undefined {
  if (process.env.DESIGNER_SEED !== "demo") return undefined;
  const dir = join(app.getAppPath(), "docs/research/figma/samples");
  if (!existsSync(dir)) return undefined;
  return readdirSync(dir)
    .filter((f) => f.endsWith(".fig"))
    .map((f) => join(dir, f));
}

function spawn() {
  generation += 1;
  const handle = startStore({
    entry: join(__dirname, "store.js"),
    userDataDir: app.getPath("userData"),
    workspaceDir: workspaceDir(),
    generation,
    seedFigs: seedFigs(),
  });
  store = handle;
  handle.ready.then(
    () => (lastError = null),
    (err: unknown) => {
      lastError = err instanceof Error ? err.message : String(err);
      console.warn(`[store] ${lastError}`);
    },
  );
  handle.client.workspace.watch((e) => {
    for (const l of [...listeners]) {
      try {
        l(e);
      } catch (err) {
        console.error("[store] a workspace listener failed", err);
      }
    }
  });
  for (const v of views.values()) if (!v.wc.isDestroyed()) handle.connectView(v.wc, v.role);
  handle.onExit((code) => {
    if (stopping || store !== handle) return;
    console.warn(`[store] exited (${code})`);
    handle.client.close();
    restarts = [...restarts.filter((t) => Date.now() - t < 60_000), Date.now()];
    if (restarts.length <= 3) spawn();
    else {
      store = null;
      giveUp();
    }
  });
}

/** Started once, in app.whenReady() before the first window. */
export function startStoreHost(onGiveUp: () => void): void {
  if (store || stopping) return;
  giveUp = onGiveUp;
  spawn();
}

/** After giving up: "Try Again" — a new store, the restart budget reset. */
export function retryStoreHost(): void {
  if (store || stopping) return;
  restarts = [];
  spawn();
}

/** Main's own client (role "main"), or null while there is no store. */
export const storeClient = (): StoreClient | null => store?.client ?? null;

/** Main's client once the store holds the workspace (rejects if this start failed). */
export async function readyStore(): Promise<StoreClient> {
  const s = store;
  if (!s) throw new Error("DesignerV2 can’t reach its files right now.");
  await s.ready;
  return s.client;
}

/** The store's workspace events, across restarts (`file.renamed`, `file.trashed`…). */
export function onWorkspaceEvent(listener: (e: WorkspaceEvent) => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/**
 * A Home or editor view: a fresh port for every page load (a reload or a
 * crash recovery needs a new one; the old one's sessions end with it) and
 * after every store restart.
 */
export function connectStoreView(wc: WebContents, role: ViewRole): void {
  views.set(wc.id, { wc, role });
  wc.on("did-finish-load", () => store?.connectView(wc, role));
  const id = wc.id;
  wc.once("destroyed", () => views.delete(id));
}

/** On quit, after the tabs flushed: every file fsynced and closed, the lock released (3 s at most). */
export function stopStoreHost(): Promise<void> {
  stopped ??= (async () => {
    stopping = true;
    const s = store;
    if (!s) return;
    await Promise.race([s.client.store.flushAll().catch(() => {}), new Promise((r) => setTimeout(r, 3000))]);
    await s.shutdown();
  })();
  return stopped;
}

/** Everything the store has, fsynced (the Mac sleeps or locks). */
export async function flushStore(): Promise<void> {
  await store?.client.store.flushAll().catch(() => {});
}

/** For tests (scripts/drive.mjs): the store's process and state. */
export function storeDebug() {
  return {
    running: Boolean(store),
    generation: store?.generation ?? 0,
    pid: store?.process.pid ?? null,
    workspaceDir: workspaceDir(),
    restarts: restarts.length,
    lastError,
    views: [...views.values()].map((v) => ({ webContentsId: v.wc.id, role: v.role })),
  };
}
