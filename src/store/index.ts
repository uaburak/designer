/**
 * The store utility process entry (docs/data.md §7): the single writer of the workspace.
 *
 * Main forks this bundle (`utilityProcess.fork(storeEntry, [], {serviceName: "Wecra Store"})`, see host.ts) and
 * sends `{type: "init", …}` with its own MessagePort; the store takes the workspace lock, loads the index, replies
 * `{type: "ready"}` and serves main's port. Every view port arrives later as `{type: "port", role}`. The same bundle
 * started as a worker thread with `workerData.designerStoreRole === "compactor"` is the compaction worker.
 */
import { dirname, join } from "node:path";
import { isMainThread, parentPort as workerParentPort, workerData } from "node:worker_threads";
import { portTransport, type PortRole } from "../shared/store/protocol";
import { COMPACTOR_ROLE, runCompactorWorker, workerCompactor } from "./compactor";
import { LocalStore } from "./localStore";
import { StoreServer } from "./server";
import { parseLocale, registerDictionary, setLocale, type Locale } from "../shared/i18n";
import { TR } from "../shared/i18n/tr";

// The UI's language for the messages the store words itself (errors shown in a toast): main's, at init and on a change
registerDictionary("tr", TR);

export interface StoreInitMessage {
  type: "init";
  workspaceDir: string;
  userDataDir: string;
  /** This bundle's path (the compactor worker runs it too) */
  entry: string;
  generation: number;
  deviceOrdinal?: number;
  teamName?: string;
  seedFigs?: string[];
  /** The login gate (docs/desktop.md §18.6): SESSION_METHODS only with a session */
  requireSession?: boolean;
  /** The preview viewer's built page; default: out/viewer/index.html next to this bundle's out/main */
  viewerTemplate?: string;
  /** The UI's language (src/shared/i18n); `{ type: "locale" }` after a change */
  locale?: Locale;
}

export type StoreParentMessage = StoreInitMessage | { type: "port"; role: PortRole } | { type: "locale"; locale: Locale };
export type StoreChildMessage = { type: "ready"; wid: string; generation: number } | { type: "error"; message: string; code?: string };

/** What Electron's utility process gives us (typed here so this file needs no electron import). */
interface ParentPortLike {
  on(event: "message", listener: (e: { data: unknown; ports: unknown[] }) => void): unknown;
  postMessage(message: unknown): void;
}

function runStoreProcess(parent: ParentPortLike): void {
  let server: StoreServer | null = null;
  let starting = false;
  const early: { port: unknown; role: PortRole }[] = [];
  parent.on("message", (e) => {
    const msg = e.data as StoreParentMessage;
    if (msg?.type === "port") {
      const port = e.ports[0];
      if (!port) return;
      if (server) server.connect(portTransport(port as never), msg.role);
      else early.push({ port, role: msg.role });
      return;
    }
    if (msg?.type === "locale") return void setLocale(parseLocale(msg.locale));
    if (msg?.type !== "init" || starting) return;
    starting = true;
    setLocale(parseLocale(msg.locale));
    const mainPort = e.ports[0];
    void LocalStore.open({
      workspaceDir: msg.workspaceDir,
      userDataDir: msg.userDataDir,
      deviceOrdinal: msg.deviceOrdinal,
      teamName: msg.teamName,
      generation: msg.generation,
      seedFigs: msg.seedFigs,
      viewerTemplate: msg.viewerTemplate ?? join(dirname(msg.entry), "..", "viewer", "index.html"),
      compactor: workerCompactor(msg.entry),
    }).then(
      (store) => {
        server = new StoreServer(store, {
          generation: msg.generation,
          ...(msg.requireSession ? { session: { signedIn: () => store.session !== null, known: store.sessionKnown } } : {}),
          // Answered first, then gone: main waits for the exit.
          onShutdown: () => setTimeout(() => process.exit(0), 20),
        });
        stopOnSignals(store);
        if (mainPort) server.connect(portTransport(mainPort as never), "main");
        for (const p of early.splice(0)) server.connect(portTransport(p.port as never), p.role);
        parent.postMessage({ type: "ready", wid: store.ws.workspace.wid, generation: msg.generation } satisfies StoreChildMessage);
      },
      (err: unknown) => {
        const e = err as { message?: string; code?: string };
        parent.postMessage({ type: "error", message: e?.message ?? String(err), code: e?.code } satisfies StoreChildMessage);
        setTimeout(() => process.exit(1), 20);
      },
    );
  });
}

/**
 * Stopped from outside (Ctrl-C of `npm run dev` reaches the whole process group, a `kill`, a closed terminal): the rooms'
 * sockets close cleanly first — a process that just dies leaves its socket in the room, a ghost in everyone's facepile
 * until the room expires it (docs/multiplayer.md §4.1) — then the store shuts down as on quit (1.5 s at most).
 */
function stopOnSignals(store: LocalStore): void {
  const goodbye = () => {
    try {
      store.multiplayer.close();
    } catch {
      // closing anyway
    }
  };
  process.once("exit", goodbye);
  for (const sig of ["SIGINT", "SIGTERM", "SIGHUP"] as const) {
    process.once(sig, () => {
      goodbye();
      void Promise.race([store.shutdown().catch(() => {}), new Promise((r) => setTimeout(r, 1500))]).finally(() => process.exit(0));
    });
  }
}

if (!isMainThread && (workerData as { designerStoreRole?: string } | null)?.designerStoreRole === COMPACTOR_ROLE) {
  if (workerParentPort) runCompactorWorker(workerParentPort);
} else {
  const parent = (process as unknown as { parentPort?: ParentPortLike }).parentPort;
  if (parent) runStoreProcess(parent);
  else console.error("Wecra Store: start me with utilityProcess.fork (see src/store/host.ts)");
}
