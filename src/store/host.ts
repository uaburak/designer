/**
 * Main's side of the store (docs/desktop.md §1, §9, §10.2; docs/data.md §7): spawn the store utility process, keep
 * main's own client on it, and broker one MessagePort per view. Restarts are main's policy (storeHost.ts): on
 * `onExit`, call `startStore` again with `generation + 1` and `connectView` every live Home/editor view; their
 * clients reattach their sessions and resend unacknowledged batches by themselves.
 *
 *   const store = startStore({ entry: join(__dirname, "store.js"), userDataDir: app.getPath("userData"),
 *                              workspaceDir: process.env.DESIGNER_WORKSPACE ?? join(app.getPath("userData"), "Workspace") });
 *   await store.ready;
 *   store.connectView(view.webContents, "home");          // the page gets `store:port` → `designer:store-port`
 *   store.client.workspace.watch((e) => …);               // renames and trash for tab titles and closing tabs
 *   await store.client.files.importLocalCopy(path, null); // path methods are main-only
 *   await store.shutdown();                               // on quit, after the tabs flushed
 */
import { MessageChannelMain, utilityProcess, type UtilityProcess, type WebContents } from "electron";
import { StoreClient } from "../shared/store/client";
import { portTransport } from "../shared/store/protocol";
import type { StoreChildMessage, StoreInitMessage } from "./index";

export interface StartStoreOptions {
  /** The built store entry: electron-vite's main-side `store` input (out/main/store.js) */
  entry: string;
  userDataDir: string;
  workspaceDir: string;
  /** 1 for the first start, +1 after each restart (the clients see it in the hello) */
  generation?: number;
  deviceOrdinal?: number;
  /** "‹Owner›'s team" for a new workspace */
  teamName?: string;
  /** DESIGNER_SEED=demo: .fig files imported into "Samples" when the workspace is empty */
  seedFigs?: string[];
  env?: Record<string, string | undefined>;
}

export interface StoreHandle {
  readonly process: UtilityProcess;
  readonly generation: number;
  /** Resolves when the store holds the workspace lock and has loaded its index; rejects if it fails to start */
  readonly ready: Promise<{ wid: string }>;
  /** Main's own client (role "main"): every method, including the path ones and `store.*` */
  readonly client: StoreClient;
  /** Brokers a port for a Home or editor view: one end to the store with the role, the other to the page */
  connectView(webContents: WebContents, role: "home" | "editor"): void;
  /** `store.shutdown` (fsync, release the lock), waits for the exit, kills it after the timeout */
  shutdown(timeoutMs?: number): Promise<void>;
  onExit(listener: (code: number) => void): () => void;
}

const delay = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

export function startStore(opts: StartStoreOptions): StoreHandle {
  const generation = opts.generation ?? 1;
  const child = utilityProcess.fork(opts.entry, [], { serviceName: "DesignerV2 Store", stdio: "inherit", env: { ...process.env, ...(opts.env ?? {}) } });
  let exited = false;
  child.once("exit", () => {
    exited = true;
  });
  const mainChannel = new MessageChannelMain();
  const client = new StoreClient();
  client.attach(portTransport(mainChannel.port2 as never));
  const init: StoreInitMessage = {
    type: "init",
    workspaceDir: opts.workspaceDir,
    userDataDir: opts.userDataDir,
    entry: opts.entry,
    generation,
    deviceOrdinal: opts.deviceOrdinal,
    teamName: opts.teamName,
    seedFigs: opts.seedFigs,
  };
  child.postMessage(init, [mainChannel.port1]);
  const ready = new Promise<{ wid: string }>((resolve, reject) => {
    child.on("message", (m: StoreChildMessage) => {
      if (m?.type === "ready") resolve({ wid: m.wid });
      else if (m?.type === "error") reject(new Error(`The store couldn't start: ${m.message}`));
    });
    child.once("exit", (code) => reject(new Error(`The store exited (${code}) before it was ready`)));
  });
  ready.catch(() => {}); // observed by callers; no unhandled rejection when nobody awaits it
  return {
    process: child,
    generation,
    ready,
    client,
    connectView(webContents, role) {
      if (exited) return;
      const { port1, port2 } = new MessageChannelMain();
      child.postMessage({ type: "port", role }, [port1]);
      webContents.postMessage("store:port", { generation }, [port2]);
    },
    async shutdown(timeoutMs = 3000) {
      if (exited) return;
      const exit = new Promise<void>((r) => child.once("exit", () => r()));
      await Promise.race([client.store.shutdown().catch(() => {}), delay(timeoutMs)]);
      await Promise.race([exit, delay(1000)]);
      if (!exited) child.kill();
      client.close();
    },
    onExit(listener) {
      child.on("exit", listener);
      return () => child.off("exit", listener);
    },
  };
}
