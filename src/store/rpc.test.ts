import { afterEach, describe, expect, it } from "vitest";
import { decodeMessage } from "../shared/schema/codec";
import type { FileChange, WorkspaceEvent } from "../shared/store/repositories";
import { batch, rect, settle } from "./testing/harness";
import { rpcTestbed, type RpcTestbed } from "./testing/rpcHarness";

let bed: RpcTestbed | null = null;
afterEach(async () => {
  await bed?.close();
  bed = null;
});

describe("the store port protocol (docs/data.md §8.3)", () => {
  it("says hello with the role and generation, and serves typed calls with bytes as structured clones", async () => {
    bed = await rpcTestbed();
    const home = await bed.connect("home");
    expect(home.role).toBe("home");
    expect(home.generation).toBe(1);
    const f = await home.workspace.createFile({ name: "Over the wire", folderId: null });
    expect((await home.workspace.listFiles({ in: "drafts" })).map((x) => x.name)).toEqual(["Over the wire"]);
    const opened = await home.files.open(f.fileKey, { mode: "edit", tabId: "t1" });
    expect(opened.snapshot).toBeInstanceOf(Uint8Array);
    expect(decodeMessage(opened.snapshot).nodeChanges).toHaveLength(3);
    const ack = await home.files.append(f.fileKey, batch(opened.sessionID, 1, [rect(opened.sessionID, 1, "!")]));
    expect(ack.seq).toBe(1);
    const put = await home.blobs.put(new Uint8Array([0x89, 0x50, 0x4e, 0x47, 13, 10, 26, 10]));
    expect(await home.blobs.get(put.sha1)).toEqual(new Uint8Array([0x89, 0x50, 0x4e, 0x47, 13, 10, 26, 10]));
    await expect(home.workspace.getFile("nope")).rejects.toMatchObject({ name: "StoreError", code: "not-found" });
  });

  it("keeps path methods and store.* for main", async () => {
    bed = await rpcTestbed();
    const editor = await bed.connect("editor");
    const main = await bed.connect("main");
    await expect(editor.files.importLocalCopy("/etc/hosts", null)).rejects.toMatchObject({ code: "forbidden" });
    await expect(editor.files.exportLocalCopy("x", "/tmp/x.fig")).rejects.toMatchObject({ code: "forbidden" });
    await expect(editor.store.info()).rejects.toMatchObject({ code: "forbidden" });
    const info = await main.store.info();
    expect(info).toMatchObject({ deviceOrdinal: 1, generation: 1, sync: { configured: false, enabled: false } });
  });

  it("sends workspace events to every port and file changes only to subscribers", async () => {
    bed = await rpcTestbed();
    const home = await bed.connect("home");
    const editor = await bed.connect("editor");
    const viewer = await bed.connect("editor");
    const seen: WorkspaceEvent[] = [];
    home.workspace.watch((e) => seen.push(e));
    const f = await editor.workspace.createFile({ folderId: null });
    const o = await editor.files.open(f.fileKey, { mode: "edit" });
    const changes: FileChange[] = [];
    const off = viewer.files.subscribe(f.fileKey, o.headSeq, (c) => changes.push(c));
    const homeChanges: FileChange[] = [];
    await settle();
    for (let i = 1; i <= 3; i++) await editor.files.append(f.fileKey, batch(o.sessionID, i, [rect(o.sessionID, i, String.fromCharCode(33 + i))]));
    await settle();
    expect(changes.map((c) => c.seq)).toEqual([1, 2, 3]);
    expect(decodeMessage(changes[0].message).nodeChanges![0].name).toBe("Rectangle 1");
    expect(homeChanges).toEqual([]);
    expect(seen.map((e) => e.type)).toEqual(["file.created"]);
    off();
    await editor.files.append(f.fileKey, batch(o.sessionID, 4, []));
    await settle();
    expect(changes).toHaveLength(3);
  });

  it("ends a port's edit sessions when the port closes (a tab closed or crashed)", async () => {
    bed = await rpcTestbed();
    const a = await bed.connect("editor");
    const b = await bed.connect("editor");
    const f = await a.workspace.createFile({ folderId: null });
    await a.files.open(f.fileKey, { mode: "edit", tabId: "A" });
    await expect(b.files.open(f.fileKey, { mode: "edit" })).rejects.toMatchObject({ code: "already-open", detail: { tabId: "A" } });
    a.close();
    await settle();
    await bed.t.idle();
    const o = await b.files.open(f.fileKey, { mode: "edit" });
    expect(o.sessionID).toBeGreaterThan(0);
  });

  it("survives a store restart: the client reattaches its session, resends unacknowledged batches and resubscribes", async () => {
    bed = await rpcTestbed();
    const editor = await bed.connect("editor");
    const watcher = await bed.connect("editor");
    const f = await editor.workspace.createFile({ folderId: null });
    const o = await editor.files.open(f.fileKey, { mode: "edit" });
    const s = o.sessionID;
    const seen: number[] = [];
    watcher.files.subscribe(f.fileKey, 0, (c) => seen.push(c.seq));
    await settle();
    expect((await editor.files.append(f.fileKey, batch(s, 1, [rect(s, 1, "!")]))).seq).toBe(1);
    await editor.files.flush(f.fileKey);

    await bed.restart(); // the store process dies; its ports close
    await settle();
    // The editor keeps editing while the store is down: these wait, unacknowledged.
    const p2 = editor.files.append(f.fileKey, batch(s, 2, [rect(s, 2, '"')]));
    const p3 = editor.files.append(f.fileKey, batch(s, 3, [rect(s, 3, "#")]));
    const list = editor.workspace.listFiles({ in: "drafts" }); // retry-safe: it waits for the new port too
    await settle();

    await bed.reconnect(editor, "editor");
    await bed.reconnect(watcher, "editor");
    expect(editor.generation).toBe(2);
    expect([(await p2).seq, (await p3).seq]).toEqual([2, 3]);
    expect((await list).length).toBe(1);
    await settle();
    expect(seen).toEqual([1, 2, 3]);

    // The session is still the editor's after the restart: another view can't take the file.
    const other = await bed.connect("editor");
    await expect(other.files.open(f.fileKey, { mode: "edit" })).rejects.toMatchObject({ code: "already-open" });
    const view = await other.files.open(f.fileKey, { mode: "view" });
    expect(view.headSeq).toBe(3);
  });
});
