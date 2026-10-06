import { afterEach, describe, expect, it } from "vitest";
import type { Message, NodeChange } from "@/engine/codec";
import { decodeMessage, encodeMessage } from "../../../../shared/schema/codec";
import { nodeFieldId } from "../../../../shared/schema/patch";
import { settle } from "../../../../store/testing/harness";
import { rpcTestbed, type RpcTestbed } from "../../../../store/testing/rpcHarness";
import { openStoreDocument, type DocumentMeta } from "../documentSource";
import { messageToEngine, messageToKiwi } from "../engineMessage";

let bed: RpcTestbed | null = null;
afterEach(async () => {
  await bed?.close();
  bed = null;
});

const msg = (sessionID: number, nodeChanges: NodeChange[]): Message => ({ type: "NODE_CHANGES", sessionID, nodeChanges });

function rect(s: number, l: number, extra: Partial<NodeChange> = {}): NodeChange {
  return {
    guid: `${s}:${l}`,
    phase: "CREATED",
    type: "ROUNDED_RECTANGLE",
    name: `Rectangle ${l}`,
    parentIndex: { guid: "0:1", position: String.fromCharCode(33 + l) },
    size: { x: 100, y: 50 },
    transform: { m00: 1, m01: 0, m02: l * 10, m10: 0, m11: 1, m12: 20 },
    fillPaints: [{ type: "SOLID", color: { r: 1, g: 0, b: 0, a: 1 }, opacity: 1, visible: true }],
    childIds: [],
    ...extra,
  };
}

describe("engine ⇄ kiwi messages", () => {
  it("converts GUIDs both ways, drops what the schema doesn't know and round-trips through the kiwi codec", () => {
    const m = msg(1048577, [rect(1048577, 1), { guid: "1048577:1", name: "Renamed", clearedFields: [nodeFieldId("fillPaints")!] }, { guid: "1048577:2", phase: "REMOVED" }]);
    const kiwi = messageToKiwi(m);
    expect(kiwi.nodeChanges![0].guid).toEqual({ sessionID: 1048577, localID: 1 });
    expect(kiwi.nodeChanges![0].parentIndex).toEqual({ guid: { sessionID: 0, localID: 1 }, position: '"' });
    expect("childIds" in kiwi.nodeChanges![0]).toBe(false);
    const back = messageToEngine(decodeMessage(encodeMessage(kiwi)));
    const { childIds: _drop, ...expected } = rect(1048577, 1);
    expect(back.nodeChanges[0]).toEqual(expected);
    expect(back.nodeChanges[1]).toEqual({ guid: "1048577:1", name: "Renamed", clearedFields: [nodeFieldId("fillPaints")] });
    expect(back.nodeChanges[2]).toEqual({ guid: "1048577:2", phase: "REMOVED" });
  });
});

describe("the store-backed DocumentSource", () => {
  it("opens a session, journals each change, and a reopened file shows them", async () => {
    bed = await rpcTestbed();
    const editor = await bed.connect("editor");
    const f = await editor.workspace.createFile({ name: "Poster", folderId: null });
    const src = await openStoreDocument(editor, f.fileKey, { tabId: "t1" });
    expect(src.fileName).toBe("Poster");
    expect(src.location).toBe("Drafts");
    expect(src.sessionID).toBeGreaterThanOrEqual(2 ** 20);
    const s = src.sessionID;

    const doc = await src.load();
    expect(doc.nodeChanges.map((n) => n.guid)).toEqual(["0:0", "0:1", "0:2"]);
    expect(doc.nodeChanges[0].type).toBe("DOCUMENT");

    src.onChanges(msg(s, [rect(s, 1), rect(s, 2)]), { kind: "USER", label: "Create" });
    src.onChanges(msg(s, [{ guid: `${s}:1`, name: "Hero", clearedFields: [nodeFieldId("fillPaints")!] }]), { kind: "USER", label: "Rename" });
    src.onChanges(msg(s, [{ guid: `${s}:2`, phase: "REMOVED" }]), { kind: "UNDO" });
    src.onChanges(msg(s, []), { kind: "USER" }); // nothing to store
    await src.flush();
    expect((await editor.workspace.listFiles({ in: "recents" })).map((x) => x.fileKey)).toEqual([f.fileKey]);
    await src.close();
    await src.close(); // idempotent

    // The journal holds three batches with the engine's kinds.
    const viewer = await bed.connect("editor");
    const view = await viewer.files.open(f.fileKey, { mode: "view" });
    expect(view.journal.map((j) => j.kind)).toEqual(["edit", "edit", "undo"]);

    // Reopen: a new session, the document has the changes merged in.
    const again = await openStoreDocument(editor, f.fileKey);
    expect(again.sessionID).not.toBe(s);
    const loaded = await again.load();
    const hero = loaded.nodeChanges.find((n) => n.guid === `${s}:1`)!;
    expect(hero).toMatchObject({ name: "Hero", type: "ROUNDED_RECTANGLE", size: { x: 100, y: 50 }, parentIndex: { guid: "0:1", position: '"' } });
    expect(hero.fillPaints).toBeUndefined();
    expect(loaded.nodeChanges.some((n) => n.guid === `${s}:2`)).toBe(false);
    expect(loaded.nodeChanges.map((n) => n.guid).slice(0, 2)).toEqual(["0:0", "0:1"]);
    await again.close();
  });

  it("survives a store restart in the middle of editing (the client resends what wasn't acknowledged)", async () => {
    bed = await rpcTestbed();
    const editor = await bed.connect("editor");
    const f = await editor.workspace.createFile({ folderId: null });
    const src = await openStoreDocument(editor, f.fileKey);
    const s = src.sessionID;
    src.onChanges(msg(s, [rect(s, 1)]));
    await src.flush();
    await bed.restart();
    await settle();
    src.onChanges(msg(s, [rect(s, 2)]));
    src.onChanges(msg(s, [{ guid: `${s}:2`, name: "After restart" }]));
    await bed.reconnect(editor, "editor");
    await src.flush();
    await src.close();
    const again = await openStoreDocument(editor, f.fileKey);
    const doc = await again.load();
    expect(doc.nodeChanges.filter((n) => n.guid.startsWith(`${s}:`)).map((n) => n.name)).toEqual(["Rectangle 1", "After restart"]);
    await again.close();
  });

  it("reports refused appends through flush and onError", async () => {
    bed = await rpcTestbed();
    const editor = await bed.connect("editor");
    const f = await editor.workspace.createFile({ folderId: null });
    const src = await openStoreDocument(editor, f.fileKey);
    const errors: unknown[] = [];
    src.onError((e) => errors.push(e));
    await editor.files.close(f.fileKey, src.sessionID); // the session ends behind the source's back
    src.onChanges(msg(src.sessionID, [rect(src.sessionID, 1)]));
    await expect(src.flush()).rejects.toMatchObject({ code: "read-only" });
    expect(errors).toHaveLength(1);
    await src.flush(); // reported once
  });

  it("follows renames, moves and trash from elsewhere, renames from the header, and passes on other sessions' changes", async () => {
    bed = await rpcTestbed();
    const editor = await bed.connect("editor");
    const home = await bed.connect("home");
    const folder = await home.workspace.createFolder({ name: "Client work", parentId: null });
    const f = await home.workspace.createFile({ name: "Logo", folderId: folder.id });
    const src = await openStoreDocument(editor, f.fileKey);
    expect(src.location).toBe("Client work");
    const seen: DocumentMeta[] = [];
    src.onMetaChanged((m) => seen.push(m));
    const external: { m: Message; kind: string }[] = [];
    src.onExternalChanges((m, info) => external.push({ m, kind: info.kind }));
    await settle();

    await home.workspace.renameFile(f.fileKey, "Logo v2");
    await home.workspace.updateFolder(folder.id, { name: "Clients" });
    await home.workspace.moveFiles([f.fileKey], null);
    await settle();
    expect(seen.map((m) => [m.fileName, m.location])).toEqual([
      ["Logo v2", "Client work"],
      ["Logo v2", "Clients"],
      ["Logo v2", "Drafts"],
    ]);

    await src.rename("  Logo final ");
    expect(src.fileName).toBe("Logo final");
    expect((await home.workspace.getFile(f.fileKey)).name).toBe("Logo final");

    // Our own batches are not echoed; a remote frame (a sync pull) is.
    const s = src.sessionID;
    src.onChanges(msg(s, [rect(s, 1)]));
    await src.flush();
    await bed.t.store.files.appendRemote(f.fileKey, encodeMessage(messageToKiwi(msg(0, [{ guid: `${s}:1`, name: "From another device" }]))));
    await settle();
    expect(external).toEqual([{ m: msg(0, [{ guid: `${s}:1`, name: "From another device" }]), kind: "remote" }]);

    await home.workspace.trash({ files: [f.fileKey] });
    await settle();
    expect(seen.at(-1)).toMatchObject({ trashed: true, deleted: false });
    await src.close();
  });

  it("saves named versions, restores one as a single `restore` batch, keeps UI state and thumbnails", async () => {
    bed = await rpcTestbed();
    const editor = await bed.connect("editor");
    const f = await editor.workspace.createFile({ folderId: null });
    const src = await openStoreDocument(editor, f.fileKey, { uiStateDelayMs: 10 });
    const watcher = await bed.connect("editor");
    const kinds: string[] = [];
    watcher.files.subscribe(f.fileKey, 0, (c) => kinds.push(c.kind)); // versions compact the journal away
    await settle();
    const s = src.sessionID;
    src.onChanges(msg(s, [rect(s, 1)]));
    const v1 = await src.saveVersion({ title: "One rectangle", description: "first" });
    expect(v1).toMatchObject({ kind: "named", title: "One rectangle", description: "first" });
    src.onChanges(msg(s, [rect(s, 2), { guid: `${s}:1`, name: "Changed" }]));
    await src.flush();

    const version = await src.openVersion(v1.id);
    expect(version.nodeChanges.filter((n) => n.guid.startsWith(`${s}:`)).map((n) => n.name)).toEqual(["Rectangle 1"]);

    // The editor applies the diff as one undoable edit; its DOCUMENT_CHANGED comes back as a change.
    const restored = await src.restoreVersion(v1.id, (diff) => {
      expect(diff.nodeChanges).toEqual([{ guid: `${s}:2`, phase: "REMOVED" }, { guid: `${s}:1`, name: "Rectangle 1" }]);
      src.onChanges(msg(s, diff.nodeChanges), { kind: "USER" });
    });
    expect(restored).toMatchObject({ kind: "restore", restoredFrom: v1.id });
    expect((await src.listVersions()).map((v) => v.kind)).toEqual(["restore", "named"]);
    const named = await src.updateVersion(v1.id, { title: "Renamed version" });
    expect(named.title).toBe("Renamed version");

    const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 13, 10, 26, 10, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52, 0, 0, 0, 40, 0, 0, 0, 30, 8, 6, 0, 0, 0]);
    await src.saveThumbnail(png, { width: 40, height: 30 });
    src.setUiState({ currentPageId: "0:1", leftPanelWidth: 260 });
    src.setUiState({ rightPanelWidth: 300 });
    await src.close();

    await settle();
    expect(kinds).toEqual(["edit", "edit", "restore"]);
    const viewer = await bed.connect("editor");
    const view = await viewer.files.open(f.fileKey, { mode: "view" });
    expect(view.journal).toEqual([]);
    expect(view.ui).toMatchObject({ currentPageId: "0:1", leftPanelWidth: 260, rightPanelWidth: 300 });
    expect(view.meta.thumbnail).toMatchObject({ width: 40, height: 30 });
    const dup = await viewer.files.duplicateVersion(f.fileKey, v1.id);
    expect(dup.name).toContain("Renamed version");
  });
});
