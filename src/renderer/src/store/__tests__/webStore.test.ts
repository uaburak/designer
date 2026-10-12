/**
 * The web app's store (docs/cloud.md §7): the browser's MemoryStore with personal Drafts from the server (the real
 * Worker handler on node:sqlite) over the IndexedDB cache (idbStorage.ts, on a fake IndexedDB) — a reload reads the
 * cache instead of downloading again, images are read on demand, eviction keeps records and thumbnails, Save local
 * copy… is a .fig's bytes, and Log out deletes the account's database.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { realServer, type TestServer } from "./realServer";
import { KV_PREFIX } from "../memory/kv";
import { fakeIndexedDb, type FakeIdb } from "../memory/fakeIdb";
import { openIdbStorage, type IdbStorage } from "../memory/idbStorage";
import { MemoryStore } from "../memory/memoryStore";

const SERVER = "https://org.test";

class NoSocket {
  binaryType = "arraybuffer";
  readyState = 0;
  onopen = null;
  onmessage = null;
  onclose = null;
  onerror = null;
  send() {}
  close() {}
}

const open: { store: MemoryStore; kv: IdbStorage }[] = [];
afterEach(async () => {
  for (const o of open.splice(0)) {
    o.store.dispose();
    await o.kv.close().catch(() => {});
  }
  vi.unstubAllGlobals();
});

async function webStore(idb: FakeIdb, srv: TestServer, name = "wecra.cache.u") {
  const kv = await openIdbStorage({ name, idb: idb.factory, channel: null });
  const store = await MemoryStore.open({ storage: kv, personalDrafts: true, cacheLimitBytes: 1024 ** 3, fetch: srv.fetch, log: () => {} });
  open.push({ store, kv });
  return { kv, store, api: store.api({}) };
}

/** A 1×1 PNG */
const PNG = Uint8Array.from(atob("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=="), (c) => c.charCodeAt(0));

describe("the IndexedDB cache (idbStorage)", () => {
  it("keeps records across page loads; images are read on demand; destroy deletes the database", async () => {
    const idb = fakeIndexedDb();
    const a = await openIdbStorage({ name: "db", idb: idb.factory, channel: null });
    a.set(`${KV_PREFIX}workspace`, '{"wid":"w"}');
    a.set(`${KV_PREFIX}blob.${"a".repeat(40)}`, "x".repeat(1000));
    expect(a.get(`${KV_PREFIX}workspace`)).toBe('{"wid":"w"}');
    expect(a.has(`${KV_PREFIX}blob.${"a".repeat(40)}`)).toBe(true);
    await a.flush();
    expect(Object.keys(idb.dump("db")!.kv)).toEqual([`${KV_PREFIX}workspace`]);
    expect(Object.keys(idb.dump("db")!.lazy)).toEqual([`${KV_PREFIX}blob.${"a".repeat(40)}`]);
    await a.close();

    const b = await openIdbStorage({ name: "db", idb: idb.factory, channel: null });
    expect(b.get(`${KV_PREFIX}workspace`)).toBe('{"wid":"w"}');
    // Not read at open: known, sized, read when asked
    const blob = `${KV_PREFIX}blob.${"a".repeat(40)}`;
    expect(b.get(blob)).toBeNull();
    expect(b.has(blob)).toBe(true);
    expect(b.sizeOf(blob)).toBe(1000);
    expect(b.keys(`${KV_PREFIX}blob.`)).toEqual([blob]);
    expect(await b.getAsync(blob)).toBe("x".repeat(1000));
    b.remove(blob);
    expect(b.has(blob)).toBe(false);
    await b.flush();
    expect(idb.dump("db")!.lazy).toEqual({});
    await b.destroy();
    expect(idb.names()).toEqual([]);
  });

  it("another tab's writes arrive (watch), and a deletion elsewhere closes this one", async () => {
    const idb = fakeIndexedDb();
    // Two tabs' channels, joined
    const tabs: { onmessage: ((e: MessageEvent) => void) | null; postMessage(m: unknown): void; close(): void }[] = [];
    const channel = () => {
      const c = { onmessage: null as ((e: MessageEvent) => void) | null, postMessage: (m: unknown) => tabs.filter((t) => t !== c).forEach((t) => t.onmessage?.({ data: m } as MessageEvent)), close: () => {} };
      tabs.push(c);
      return c;
    };
    const one = await openIdbStorage({ name: "db", idb: idb.factory, channel: channel() });
    const two = await openIdbStorage({ name: "db", idb: idb.factory, channel: channel() });
    const heard: [string, string | null][] = [];
    two.watch!((k, v) => heard.push([k, v]));
    one.set(`${KV_PREFIX}meta.F`, '{"name":"Poster"}');
    await one.flush();
    await vi.waitFor(() => expect(heard).toEqual([[`${KV_PREFIX}meta.F`, '{"name":"Poster"}']]));
    expect(two.get(`${KV_PREFIX}meta.F`)).toBe('{"name":"Poster"}');

    let closed = false;
    two.onClosedElsewhere = () => (closed = true);
    await one.destroy();
    await vi.waitFor(() => expect(closed).toBe(true));
    expect(idb.names()).toEqual([]);
  });
});

describe("the web app's store: personal Drafts over the cache", () => {
  it("registers new files on the server, reloads from the cache without downloading, opens a draft made elsewhere", async () => {
    vi.stubGlobal("WebSocket", NoSocket);
    const srv = await realServer();
    const alice = await srv.addUser("alice@example.com");
    const laptop = fakeIndexedDb();

    // The laptop's browser: a new design file becomes a draft on the server
    const w1 = await webStore(laptop, srv);
    await w1.store.setSession({ server: SERVER, token: alice.token });
    await w1.store.personal.idle();
    expect((await w1.api.cloud.status()).uid).toBe(alice.user.id);
    const poster = await w1.api.workspace.createFile({ name: "Poster", folderId: null });
    await w1.store.personal.idle();
    await vi.waitFor(async () => expect((await srv.call("GET", "/me/drafts", alice.token)).body.files.map((f: { name: string }) => f.name)).toEqual(["Poster"]));
    const key = (await w1.api.workspace.getFile(poster.fileKey)).cloud!.key!;
    await vi.waitFor(() => expect(srv.snapshots.get(key)?.bytes.length).toBeGreaterThan(50));
    await w1.api.files.saveThumbnail(poster.fileKey, PNG, { width: 1, height: 1 });
    await w1.kv.flush();
    w1.store.dispose();
    await w1.kv.close();
    open.length = 0;

    // A reload: the records and the document come from the cache — no snapshot downloaded
    srv.log.length = 0;
    const w2 = await webStore(laptop, srv);
    expect((await w2.api.workspace.listFiles({ in: "drafts" })).map((f) => f.name)).toEqual([]); // signed out: not listed
    await w2.store.setSession({ server: SERVER, token: alice.token });
    await w2.store.personal.idle();
    expect((await w2.api.workspace.listFiles({ in: "drafts" })).map((f) => f.name)).toEqual(["Poster"]);
    const opened = await w2.api.files.open(poster.fileKey, { mode: "view" });
    expect(opened.snapshot.length).toBeGreaterThan(50);
    expect(srv.log.some((l) => l.includes("/me/drafts"))).toBe(true);
    expect(srv.log.some((l) => l.includes("/snapshot"))).toBe(false);
    expect(w2.store.thumbnail(poster.fileKey)?.mime).toBe("image/png");

    // Save local copy…: a .fig (a ZIP) with the canvas
    const fig = await w2.api.files.exportFigBytes!(poster.fileKey);
    expect([...fig.slice(0, 2)]).toEqual([0x50, 0x4b]);

    // The desktop's browser (another cache): the draft is listed, downloaded when opened
    const desk = await webStore(fakeIndexedDb(), srv);
    await desk.store.setSession({ server: SERVER, token: alice.token });
    await desk.store.personal.idle();
    const [listed] = await desk.api.workspace.listFiles({ in: "drafts" });
    expect(listed.name).toBe("Poster");
    expect((await desk.api.workspace.getFile(listed.fileKey)).cloud?.remote).toBe(true);
    const there = await desk.api.files.open(listed.fileKey, { mode: "view" });
    expect(there.snapshot.length).toBeGreaterThan(50);
    expect((await desk.api.workspace.getFile(listed.fileKey)).cloud?.remote).toBeFalsy();

    // Clear cache: the document goes, the record stays (listed, downloaded again when opened)
    await w2.api.files.close(poster.fileKey, 0);
    await w2.api.cloud.clearCache();
    expect((await w2.api.workspace.getFile(poster.fileKey)).cloud?.remote).toBe(true);
    await w2.kv.flush();
    expect(w2.kv.has(`${KV_PREFIX}file.${poster.fileKey}`)).toBe(false);
    expect(w2.store.thumbnail(poster.fileKey)?.mime).toBe("image/png");
    expect((await w2.api.files.open(poster.fileKey, { mode: "view" })).snapshot.length).toBeGreaterThan(50);
  });

  it("renames and trashes on the server first", async () => {
    vi.stubGlobal("WebSocket", NoSocket);
    const srv = await realServer();
    const alice = await srv.addUser("alice@example.com");
    const w = await webStore(fakeIndexedDb(), srv);
    await w.store.setSession({ server: SERVER, token: alice.token });
    const f = await w.api.workspace.createFile({ name: "Logo", folderId: null });
    await w.store.personal.idle();
    await w.api.workspace.renameFile(f.fileKey, "Logo v2");
    await w.api.workspace.trash({ files: [f.fileKey] });
    const trashed = (await srv.call("GET", "/me/drafts?trashed=1", alice.token)).body.files as { name: string }[];
    expect(trashed.map((x) => x.name)).toEqual(["Logo v2"]);
  });
});
