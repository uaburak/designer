import { readFileSync } from "node:fs";
import { join } from "node:path";
import { zstdDecompressSync } from "node:zlib";
import { afterEach, describe, expect, it } from "vitest";
import { decodeMessage } from "../../../../shared/schema/codec";
import { NodeTable } from "../../../../shared/schema/patch";
import type { Message } from "@/engine/codec";
import type { WorkspaceEvent } from "../../../../shared/store/repositories";
import { createDevStore, resetDevStore, type DevStore } from "../devStore";
import { openStoreDocument } from "../documentSource";
import { KV_PREFIX, memoryStorage, type KeyValueStorage } from "../memory/kv";
import { MemoryStore } from "../memory/memoryStore";

const open: DevStore[] = [];
afterEach(() => {
  for (const d of open.splice(0)) d.close();
});

function dev(storage: KeyValueStorage = memoryStorage(), seed = true): DevStore {
  const d = createDevStore({ storage, seed });
  open.push(d);
  return d;
}

const tick = () => new Promise((r) => setTimeout(r, 5));

/** Two pages sharing one localStorage: each sees the other's writes as `storage` events. */
function sharedStorage(): [KeyValueStorage, KeyValueStorage] {
  const base = memoryStorage();
  const watchers: { page: number; l: (k: string, v: string | null) => void }[] = [];
  const page = (n: number): KeyValueStorage => ({
    get: base.get,
    keys: base.keys,
    set: (k, v) => {
      base.set(k, v);
      for (const w of watchers) if (w.page !== n) w.l(k, v);
      return true;
    },
    remove: (k) => {
      base.remove(k);
      for (const w of watchers) if (w.page !== n) w.l(k, null);
    },
    watch: (l) => {
      const w = { page: n, l };
      watchers.push(w);
      return () => watchers.splice(watchers.indexOf(w), 1);
    },
  });
  return [page(1), page(2)];
}

describe("the browser dev store", () => {
  it("starts with the demo workspace: Drafts, nested folders, Recents, Starred, Trash, thumbnails, a version", async () => {
    const d = dev();
    const store = d.client;
    await store.whenReady();
    expect(store.role).toBe("home");
    const folders = await store.workspace.listFolders();
    expect(folders.map((f) => f.name).sort()).toEqual(["Archive", "Client work", "Personal"]);
    const client = folders.find((f) => f.name === "Client work")!;
    expect(folders.find((f) => f.name === "Archive")!.parentId).toBe(client.id);
    expect((await store.workspace.listFiles({ in: "drafts" })).map((f) => f.name)).toEqual(["Landing page", "Wireframes"]);
    expect((await store.workspace.listFiles({ in: "recents" })).map((f) => f.name)).toEqual(["Landing page", "Mobile app", "Logo explorations", "Wireframes"]);
    expect((await store.workspace.listFiles({ in: "starred" })).map((f) => f.name)).toEqual(["Landing page"]);
    expect((await store.workspace.getPrefs()).starred.folders).toEqual([client.id]);
    expect((await store.workspace.listFiles({ in: "trash" })).map((f) => f.name)).toEqual(["Scratch"]);
    expect((await store.workspace.listFiles({ in: "folder", folderId: client.id })).map((f) => f.name)).toEqual(["Mobile app"]);
    expect((await store.workspace.listFiles({ in: "search", text: "LOGO" })).map((f) => f.name)).toEqual(["Logo explorations"]);
    const landing = (await store.workspace.listFiles({ in: "drafts" }))[0];
    expect(landing.starred).toBe(true);
    expect(landing.sizeBytes).toBeGreaterThan(0);
    expect(landing.thumbnail).toEqual({ version: 1, width: 400, height: 300 });
    expect(d.thumbnailUrl(landing.fileKey)).toMatch(/^(blob:|data:image\/svg\+xml)/);
    expect((await store.files.listVersions(landing.fileKey)).map((v) => v.title)).toEqual(["First draft"]);
  });

  it("does Home's operations with the store's rules and events", async () => {
    const store = dev(memoryStorage(), false).client;
    const events: WorkspaceEvent["type"][] = [];
    store.workspace.watch((e) => events.push(e.type));
    const folder = await store.workspace.createFolder({ name: "Work", parentId: null, color: "teal" });
    const sub = await store.workspace.createFolder({ name: "Sub", parentId: folder.id });
    const a = await store.workspace.createFile({ folderId: null });
    expect(a.name).toBe("Untitled");
    await store.workspace.renameFile(a.fileKey, "Brand");
    const copy = await store.workspace.duplicateFile(a.fileKey);
    expect(copy.name).toBe("Brand (Copy)");
    await store.workspace.moveFiles([copy.fileKey], sub.id);
    await store.workspace.setStarred({ fileKey: copy.fileKey }, true);
    await expect(store.workspace.updateFolder(folder.id, { parentId: sub.id })).rejects.toMatchObject({ code: "invalid" });

    // Trashing a folder hides what is in it; restoring a file whose folder is in Trash puts it in Drafts.
    await store.workspace.trash({ folders: [folder.id] });
    expect(await store.workspace.listFiles({ in: "starred" })).toEqual([]);
    await expect(store.files.open(copy.fileKey, { mode: "edit" })).rejects.toMatchObject({ code: "trashed" });
    await store.workspace.restore({ files: [copy.fileKey] });
    expect((await store.workspace.getFile(copy.fileKey)).folderId).toBeNull();
    await store.workspace.trash({ files: [a.fileKey] });
    await store.workspace.deleteForever({ folders: [folder.id] });
    expect(await store.workspace.listFolders()).toEqual([]);
    await store.workspace.emptyTrash();
    expect((await store.workspace.listFiles({ in: "drafts" })).map((f) => f.name)).toEqual(["Brand (Copy)"]);
    await expect(store.workspace.getFile(a.fileKey)).rejects.toMatchObject({ code: "not-found" });
    await tick();
    expect(events).toEqual([
      "folder.created",
      "folder.created",
      "file.created",
      "file.renamed",
      "file.created",
      "file.moved",
      "prefs.updated",
      "folder.trashed",
      "file.trashed",
      "file.restored",
      "file.trashed",
      "folder.deleted",
      "folder.deleted",
      "file.deleted",
    ]);
  });

  it("backs the editor's DocumentSource: sessions, the lock, changes, versions, thumbnails", async () => {
    const storage = memoryStorage();
    const d = dev(storage, false);
    const store = d.client;
    const f = await store.workspace.createFile({ name: "Draw", folderId: null });
    const src = await openStoreDocument(store, f.fileKey, { tabId: "A" });
    await expect(store.files.open(f.fileKey, { mode: "edit" })).rejects.toMatchObject({ code: "already-open", detail: { tabId: "A" } });
    const s = src.sessionID;
    const change = (nodeChanges: Message["nodeChanges"]): Message => ({ type: "NODE_CHANGES", sessionID: s, nodeChanges });
    src.onChanges(change([{ guid: `${s}:1`, phase: "CREATED", type: "FRAME", name: "Frame 1", parentIndex: { guid: "0:1", position: "!" }, size: { x: 200, y: 100 } }]));
    const v = await src.saveVersion({ title: "Before" });
    src.onChanges(change([{ guid: `${s}:1`, name: "Renamed" }]), { kind: "USER" });
    await src.flush();
    await src.restoreVersion(v.id, (diff) => src.onChanges(change(diff.nodeChanges)));
    const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 13, 10, 26, 10, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52, 0, 0, 0, 20, 0, 0, 0, 10, 8, 6, 0, 0, 0]);
    await src.saveThumbnail(png, { width: 20, height: 10 });
    expect(d.thumbnailUrl(f.fileKey)).toBeTruthy();
    await src.close();

    // A reload of the page: a new store on the same storage sees everything.
    const reloaded = dev(storage, false).client;
    const again = await openStoreDocument(reloaded, f.fileKey);
    const doc = await again.load();
    expect(doc.nodeChanges.find((n) => n.guid === `${s}:1`)).toMatchObject({ name: "Frame 1", type: "FRAME", size: { x: 200, y: 100 } });
    expect((await again.listVersions()).map((x) => x.kind)).toEqual(["restore", "named"]);
    expect((await reloaded.workspace.getFile(f.fileKey)).thumbnail).toMatchObject({ version: 1, width: 20, height: 10 });
    await again.close();
  });

  it("follows another page's writes (Home in one browser tab, the editor in another)", async () => {
    const [p1, p2] = sharedStorage();
    const home = dev(p1, true).client;
    await home.whenReady();
    const editor = dev(p2, true).client; // the workspace exists: not seeded twice
    await editor.whenReady();
    expect((await editor.workspace.listFiles({ in: "drafts" })).length).toBe(2);
    const events: WorkspaceEvent[] = [];
    home.workspace.watch((e) => events.push(e));
    const landing = (await editor.workspace.listFiles({ in: "drafts" }))[0];
    await editor.workspace.renameFile(landing.fileKey, "Landing page v2");
    await tick();
    expect(events.some((e) => e.type === "file.renamed" && e.name === "Landing page v2")).toBe(true);
    expect((await home.workspace.getFile(landing.fileKey)).name).toBe("Landing page v2");
  });

  it("imports a .fig from its bytes with the browser's codecs (zstd only when a decoder is given)", async () => {
    const samples = join(__dirname, "../../../../../docs/research/figma/samples");
    const bytes = (n: string) => new Uint8Array(readFileSync(join(samples, n)));
    const plain = dev(memoryStorage(), false).client;
    const meta = await plain.files.importFigBytes(bytes("structure.fig"), "structure.fig"); // deflate: works everywhere
    expect(meta).toMatchObject({ name: "structure", folderId: null, importedFrom: { kind: "fig", name: "structure" }, thumbnail: { version: 1, width: 400, height: 190 } });
    expect((await plain.files.listVersions(meta.fileKey)).map((v) => v.kind)).toEqual(["import"]);
    const opened = await plain.files.open(meta.fileKey, { mode: "view" });
    const table = NodeTable.fromMessage(decodeMessage(opened.snapshot));
    expect(table.size).toBe(26);
    for (const h of table.imageHashes()) expect(await plain.blobs.has([h])).toEqual([true]);
    await expect(plain.files.importFigBytes(bytes("sections.fig"), "sections.fig")).rejects.toMatchObject({ code: "unsupported-format" }); // zstd data chunk
    await expect(plain.files.importLocalCopy("/etc/hosts", null)).rejects.toMatchObject({ code: "forbidden" });

    const withZstd = createDevStore({ storage: "memory", seed: false, zstdDecompress: (d) => new Uint8Array(zstdDecompressSync(d)) });
    open.push(withZstd);
    const folder = await withZstd.client.workspace.createFolder({ name: "Imports", parentId: null });
    for (const [n, nodes] of [["sections.fig", 21], ["stacks_wrap.fig", 57]] as const) {
      const m = await withZstd.client.files.importFigBytes(bytes(n), n, folder.id);
      expect(m.folderId).toBe(folder.id);
      expect(NodeTable.fromMessage(decodeMessage((await withZstd.client.files.open(m.fileKey, { mode: "view" })).snapshot)).size).toBe(nodes);
    }
  });

  it("resets to an empty storage", async () => {
    const storage = memoryStorage();
    const store = await MemoryStore.open({ storage, seed: async (s) => void (await s.createFile({ folderId: null })) });
    expect(storage.keys(KV_PREFIX).length).toBeGreaterThan(2);
    store.dispose();
    resetDevStore(storage);
    expect(storage.keys(KV_PREFIX)).toEqual([]);
  });
});
