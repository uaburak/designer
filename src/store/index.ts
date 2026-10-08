/**
 * The store utility process entry (docs/data.md §7): the single writer of the workspace.
 *
 * Main forks this bundle (`utilityProcess.fork(storeEntry, [], {serviceName: "DesignerV2 Store"})`, see host.ts) and
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
  /** The preview viewer's built page; default: out/viewer/index.html next to this bundle's out/main */
  viewerTemplate?: string;
}

export type StoreParentMessage = StoreInitMessage | { type: "port"; role: PortRole };
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
    if (msg?.type !== "init" || starting) return;
    starting = true;
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
          // Answered first, then gone: main waits for the exit.
          onShutdown: () => setTimeout(() => process.exit(0), 20),
        });
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

if (!isMainThread && (workerData as { designerStoreRole?: string } | null)?.designerStoreRole === COMPACTOR_ROLE) {
  if (workerParentPort) runCompactorWorker(workerParentPort);
} else {
  const parent = (process as unknown as { parentPort?: ParentPortLike }).parentPort;
  if (parent) runStoreProcess(parent);
  else console.error("DesignerV2 Store: start me with utilityProcess.fork (see src/store/host.ts)");
}
