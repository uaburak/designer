import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { WorkspaceEvent } from "../../shared/store/repositories";
import { openTestStore, type TestStore } from "../testing/harness";

let t: TestStore | null = null;
afterEach(async () => {
  await t?.close().catch(() => {});
  t?.dispose();
  t = null;
});

describe("workspace on disk (docs/data.md §3–§4)", () => {
  it("creates the layout, the records and a lock on first start", async () => {
    t = await openTestStore();
    const root = join(t.dir, "Workspace");
    for (const p of ["workspace.json", "prefs.json", "folders", "files", "blobs", "libraries", "schemas", "tmp", ".trash-pending", ".lock"]) expect(existsSync(join(root, p))).toBe(true);
    const ws = await t.api.workspace.getWorkspace();
    expect(ws.wid).toMatch(/^[0-9A-Za-z]{16}$/);
    expect(ws.formatVersion).toBe(1);
    expect(JSON.parse(readFileSync(join(t.dir, "device.json"), "utf8")).ordinal).toBe(1);
    // A second store on the same workspace is refused while this one lives.
    await expect(openTestStore({ dir: t.dir })).rejects.toMatchObject({ code: "io" });
  });

  it("creates files in Drafts and folders, renames, moves, lists and searches without case or diacritics", async () => {
    t = await openTestStore();
    const { workspace } = t.api;
    const events: WorkspaceEvent[] = [];
    workspace.watch((e) => events.push(e));
    const draft = await workspace.createFile({ folderId: null });
    expect(draft.name).toBe("Untitled");
    expect(draft.fileKey).toMatch(/^[0-9A-Za-z]{22}$/);
    const folder = await workspace.createFolder({ name: "Müşteri İşleri", parentId: null, color: "blue" });
    await workspace.createFile({ name: "Çalışma", folderId: folder.id });
    await workspace.renameFile(draft.fileKey, "Café Menu");
    expect((await workspace.listFiles({ in: "drafts" })).map((f) => f.name)).toEqual(["Café Menu"]);
    expect((await workspace.listFiles({ in: "folder", folderId: folder.id })).map((f) => f.name)).toEqual(["Çalışma"]);
    expect((await workspace.listFiles({ in: "search", text: "cafe" })).map((f) => f.name)).toEqual(["Café Menu"]);
    expect((await workspace.listFiles({ in: "search", text: "CALIS" })).map((f) => f.name)).toEqual(["Çalışma"]);
    await workspace.moveFiles([draft.fileKey], folder.id);
    expect((await workspace.listFiles({ in: "drafts" })).length).toBe(0);
    const item = await workspace.getFile(draft.fileKey);
    expect(item.folderId).toBe(folder.id);
    expect(item.sizeBytes).toBeGreaterThan(0);
    expect(events.map((e) => e.type)).toEqual(["file.created", "folder.created", "file.created", "file.renamed", "file.moved"]);
    await expect(workspace.renameFile(draft.fileKey, "  ")).rejects.toMatchObject({ code: "invalid" });
    await expect(workspace.createFile({ folderId: "AAAAAAAAAAAAAAAA" })).rejects.toMatchObject({ code: "not-found" });
  });

  it("nests folders up to 10 levels and refuses cycles", async () => {
    t = await openTestStore();
    const { workspace } = t.api;
    let parent: string | null = null;
    const ids: string[] = [];
    for (let i = 0; i < 10; i++) {
      const f = await workspace.createFolder({ name: `L${i + 1}`, parentId: parent });
      ids.push(f.id);
      parent = f.id;
    }
    await expect(workspace.createFolder({ name: "L11", parentId: parent })).rejects.toMatchObject({ code: "invalid" });
    await expect(workspace.updateFolder(ids[0], { parentId: ids[5] })).rejects.toMatchObject({ code: "invalid" });
    const other = await workspace.createFolder({ name: "Other", parentId: null });
    await expect(workspace.updateFolder(ids[0], { parentId: other.id })).rejects.toMatchObject({ code: "invalid" }); // 1 + 10 levels
    await workspace.updateFolder(ids[1], { parentId: other.id }); // 1 + 9 levels: allowed
    await workspace.updateFolder(ids[1], { parentId: ids[0] });
    const moved = await workspace.updateFolder(ids[9], { parentId: other.id, name: "Leaf", color: "green" });
    expect(moved).toMatchObject({ parentId: other.id, name: "Leaf", color: "green" });
    expect(moved._clk.parentId).toMatch(/^[0-9a-z]{9}\.[0-9a-z]{3}\.01$/);
  });

  it("trashes a folder as one item, hides its files and stars, restores to Drafts or the top level, deletes forever", async () => {
    t = await openTestStore();
    const { workspace } = t.api;
    const parent = await workspace.createFolder({ name: "Parent", parentId: null });
    const child = await workspace.createFolder({ name: "Child", parentId: parent.id });
    const a = await workspace.createFile({ name: "A", folderId: child.id });
    const b = await workspace.createFile({ name: "B", folderId: parent.id });
    await workspace.setStarred({ fileKey: a.fileKey }, true);
    await workspace.setStarred({ folderId: child.id }, true);
    await workspace.recordViewed(a.fileKey);
    const events: WorkspaceEvent[] = [];
    workspace.watch((e) => events.push(e));

    await workspace.trash({ folders: [child.id] });
    await workspace.trash({ folders: [parent.id] });
    expect(events.filter((e) => e.type === "file.trashed")).toEqual([
      { type: "file.trashed", fileKey: a.fileKey, viaFolder: child.id },
      { type: "file.trashed", fileKey: b.fileKey, viaFolder: parent.id },
    ]);
    expect(await workspace.listFiles({ in: "starred" })).toEqual([]);
    expect(await workspace.listFiles({ in: "recents" })).toEqual([]);
    expect(await workspace.listFiles({ in: "trash" })).toEqual([]); // the folder is the item; its files keep their folderId
    expect((await workspace.listFolders()).find((f) => f.id === parent.id)!.trashedAt).not.toBeNull();
    await expect(t.api.files.open(a.fileKey, { mode: "edit" })).rejects.toMatchObject({ code: "trashed" });

    // Restore the child folder: its parent is in Trash too, so it goes to the top level.
    await workspace.restore({ folders: [child.id] });
    expect((await workspace.listFolders()).find((f) => f.id === child.id)!.parentId).toBeNull();
    expect((await workspace.listFiles({ in: "starred" })).map((f) => f.name)).toEqual(["A"]);

    // Trash a file on its own, then its folder; restoring the file sends it to Drafts.
    await workspace.trash({ files: [a.fileKey] });
    await workspace.trash({ folders: [child.id] });
    await workspace.restore({ files: [a.fileKey] });
    expect((await workspace.getFile(a.fileKey)).folderId).toBeNull();

    await expect(workspace.deleteForever({ files: [a.fileKey] })).rejects.toMatchObject({ code: "invalid" });
    await workspace.deleteForever({ folders: [parent.id] });
    expect((await workspace.listFolders()).map((f) => f.id)).toEqual([child.id]);
    await expect(workspace.getFile(b.fileKey)).rejects.toMatchObject({ code: "not-found" });
    expect(existsSync(join(t.dir, "Workspace", "files", b.fileKey))).toBe(false);

    await workspace.trash({ files: [a.fileKey], folders: [child.id] });
    await workspace.emptyTrash();
    expect(await workspace.listFolders()).toEqual([]);
    await expect(workspace.getFile(a.fileKey)).rejects.toMatchObject({ code: "not-found" });
    const prefs = await workspace.getPrefs();
    expect(prefs.starred).toEqual({ files: [], folders: [] });
    expect(prefs.viewedAt[a.fileKey]).toBeUndefined();
  });

  it("keeps the 50 newest recents, removes from recents but remembers when a file was viewed", async () => {
    t = await openTestStore();
    const { workspace } = t.api;
    const keys: string[] = [];
    for (let i = 0; i < 52; i++) {
      const f = await workspace.createFile({ name: `F${i}`, folderId: null });
      keys.push(f.fileKey);
      t.clock.advance(1000);
      await workspace.recordViewed(f.fileKey);
    }
    const recents = await workspace.listFiles({ in: "recents" });
    expect(recents).toHaveLength(50);
    expect(recents[0].name).toBe("F51");
    await workspace.removeFromRecents(keys[51]);
    expect((await workspace.listFiles({ in: "recents" }))[0].name).toBe("F50");
    expect((await workspace.getFile(keys[51])).lastViewedAt).not.toBeNull();
    const prefs = await workspace.setBrowsePrefs({ layout: "list", sort: "alphabetical" });
    expect(prefs.browse).toEqual({ layout: "list", sort: "alphabetical" });
  });

  it("repairs damaged records on start: .bak for workspace.json, Drafts for files of a lost folder, a rebuilt meta.json", async () => {
    t = await openTestStore();
    const { workspace } = t.api;
    const ws = await workspace.updateWorkspace({ teamName: "Burak's team" });
    const folder = await workspace.createFolder({ name: "Gone", parentId: null });
    const f = await workspace.createFile({ name: "Orphan", folderId: folder.id });
    const g = await workspace.createFile({ name: "Damaged", folderId: null });
    await workspace.updateWorkspace({ teamName: "Burak's team 2" });
    await t.close();
    const root = join(t.dir, "Workspace");
    writeFileSync(join(root, "workspace.json"), "{ not json");
    writeFileSync(join(root, "folders", `${folder.id}.json`), "garbage");
    writeFileSync(join(root, "files", g.fileKey, "meta.json"), "");
    t = await t.reopen();
    expect((await t.api.workspace.getWorkspace()).wid).toBe(ws.wid);
    expect((await t.api.workspace.getWorkspace()).teamName).toBe("Burak's team"); // the previous generation
    expect((await t.api.workspace.getFile(f.fileKey)).folderId).toBeNull();
    expect((await t.api.workspace.getFile(g.fileKey)).name).toBe("Recovered file");
  });
});
