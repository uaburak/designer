// @vitest-environment happy-dom
// @vitest-environment-options {"url": "http://localhost:5199/?files"}
/**
 * The page's side of the port handover (docs/desktop.md §10.2): the preload posts `designer:store-port` with the port
 * to the page's own window and origin; the client accepts only that, one port per store generation.
 */
import { afterEach, describe, expect, it } from "vitest";
import { portTransport } from "../../../../shared/store/protocol";
import { StoreServer } from "../../../../store/server";
import { connectStore, STORE_PORT_MESSAGE, STORE_PORT_WANTED, type StoreClient } from "../client";
import { MemoryStore } from "../memory/memoryStore";

const cleanup: (() => void)[] = [];
afterEach(() => {
  for (const f of cleanup.splice(0)) f();
});

async function server(generation: number, store?: MemoryStore) {
  const s = store ?? (await MemoryStore.open({ seed: async (m) => void (await m.createFile({ name: "On the port", folderId: null })) }));
  const srv = new StoreServer(s, { generation });
  const { port1, port2 } = new MessageChannel();
  srv.connect(portTransport(port1), "home");
  cleanup.push(() => srv.close());
  return { store: s, port: port2 };
}

function deliver(data: unknown, ports: MessagePort[], init: { origin?: string; source?: unknown } = {}) {
  window.dispatchEvent(new MessageEvent("message", { data, ports, origin: init.origin ?? window.location.origin, source: (init.source ?? window) as Window }));
}

const ready = (c: StoreClient, ms = 200) => Promise.race([c.whenReady().then(() => true), new Promise<boolean>((r) => setTimeout(() => r(false), ms))]);

describe("connectStore (the renderer's store client)", () => {
  it("asks for the port, then takes it only from its own window and origin", async () => {
    const asked: unknown[] = [];
    const onMessage = (e: MessageEvent) => asked.push(e.data);
    window.addEventListener("message", onMessage);
    cleanup.push(() => window.removeEventListener("message", onMessage));
    const client = connectStore({}, window);
    cleanup.push(() => client.close());
    await new Promise((r) => setTimeout(r, 20));
    expect(asked).toContainEqual({ type: STORE_PORT_WANTED });

    const { port } = await server(1);
    deliver({ type: STORE_PORT_MESSAGE, generation: 1 }, [port], { origin: "https://evil.example" });
    deliver({ type: STORE_PORT_MESSAGE, generation: 1 }, [port], { source: {} });
    deliver({ type: "something-else", generation: 1 }, [port]);
    deliver({ type: STORE_PORT_MESSAGE, generation: 1 }, []);
    expect(await ready(client)).toBe(false);

    deliver({ type: STORE_PORT_MESSAGE, generation: 1 }, [port]);
    expect(await ready(client, 2000)).toBe(true);
    expect(client.generation).toBe(1);
    expect((await client.workspace.listFiles({ in: "drafts" })).map((f) => f.name)).toEqual(["On the port"]);
  });

  it("moves to a newer generation's port and ignores a stale one", async () => {
    const client = connectStore({}, window);
    cleanup.push(() => client.close());
    const first = await server(2);
    deliver({ type: STORE_PORT_MESSAGE, generation: 2 }, [first.port]);
    await client.whenReady();
    expect(client.generation).toBe(2);

    const stale = await server(1, first.store);
    deliver({ type: STORE_PORT_MESSAGE, generation: 1 }, [stale.port]);
    await new Promise((r) => setTimeout(r, 20));
    expect(client.generation).toBe(2);

    const next = await server(3, first.store);
    const connected = new Promise<number>((r) => client.onConnected((e) => r(e.generation)));
    deliver({ type: STORE_PORT_MESSAGE, generation: 3 }, [next.port]);
    expect(await connected).toBe(3);
    expect((await client.workspace.listFiles({ in: "drafts" })).length).toBe(1);
  });
});
