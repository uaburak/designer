/**
 * The renderer's store client (docs/data.md §8.2, docs/desktop.md §10.2): Home and every editor talk to the store
 * process directly over a MessagePort that main brokers. The preload forwards it to the page as
 * `window.postMessage({type: "designer:store-port", generation}, location.origin, [port])`; this module accepts only
 * that message, from this window and origin, and hands each new port (one per store generation) to the client,
 * which reattaches its sessions and resends what the store had not acknowledged.
 *
 *   import { storeClient } from "@/store/client";
 *   const store = storeClient();
 *   const files = await store.workspace.listFiles({ in: "recents" });
 */
import { StoreClient, type StoreClientOptions } from "../../../shared/store/client";
import { portTransport } from "../../../shared/store/protocol";

export { StoreClient };
export type { StoreClientOptions };

export const STORE_PORT_MESSAGE = "designer:store-port";
/** Posted by the page when it starts listening, so a preload that kept the port can hand it over late. */
export const STORE_PORT_WANTED = "designer:store-port-wanted";

/** Creates a client fed by the preload's port messages (one per store generation). */
export function connectStore(opts: StoreClientOptions = {}, win: Window = window): StoreClient {
  const client = new StoreClient(opts);
  let generation = 0;
  win.addEventListener("message", (e: MessageEvent) => {
    if (e.source !== win || e.origin !== win.location.origin) return;
    const d = e.data as { type?: unknown; generation?: unknown } | null;
    if (!d || d.type !== STORE_PORT_MESSAGE || !e.ports?.[0]) return;
    const g = typeof d.generation === "number" ? d.generation : generation + 1;
    if (g < generation) return; // a stale port from before a restart
    generation = g;
    client.attach(portTransport(e.ports[0]));
  });
  win.postMessage({ type: STORE_PORT_WANTED }, win.location.origin);
  return client;
}

let shared: StoreClient | null = null;

/** The page's one client. */
export function storeClient(opts?: StoreClientOptions): StoreClient {
  return (shared ??= connectStore(opts));
}
