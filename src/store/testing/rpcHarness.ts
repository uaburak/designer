/**
 * The store and its clients in one process, over real MessageChannels with structured clone — the same protocol the
 * app runs between the store utility process and the views.
 */
import { MessageChannel } from "node:worker_threads";
import { StoreClient, type StoreClientOptions } from "../../shared/store/client";
import { portTransport, type PortRole } from "../../shared/store/protocol";
import { StoreServer } from "../server";
import { openTestStore, type TestStore } from "./harness";

export interface RpcTestbed {
  t: TestStore;
  server: StoreServer;
  /** A client with its own port and role, ready (hello received) */
  connect(role: PortRole, opts?: StoreClientOptions): Promise<StoreClient>;
  /** Gives an existing client a new port on the current server (what main does after a restart) */
  reconnect(client: StoreClient, role: PortRole): Promise<void>;
  /** Kills the store as a crash would (ports close, nothing flushed), then starts a new one on the same workspace */
  restart(): Promise<void>;
  close(): Promise<void>;
}

export async function rpcTestbed(): Promise<RpcTestbed> {
  let t = await openTestStore();
  let generation = 1;
  let server = new StoreServer(t.store, { generation });
  const clients: StoreClient[] = [];
  const bed: RpcTestbed = {
    get t() {
      return t;
    },
    get server() {
      return server;
    },
    async connect(role, opts) {
      const client = new StoreClient(opts);
      clients.push(client);
      await bed.reconnect(client, role);
      return client;
    },
    async reconnect(client, role) {
      const { port1, port2 } = new MessageChannel();
      server.connect(portTransport(port1), role);
      client.attach(portTransport(port2));
      await client.whenReady();
    },
    async restart() {
      server.close();
      t.crash();
      t = await t.reopen();
      generation++;
      server = new StoreServer(t.store, { generation });
    },
    async close() {
      for (const c of clients) c.close();
      server.close();
      await t.close().catch(() => {});
      t.dispose();
    },
  } as RpcTestbed;
  return bed;
}
