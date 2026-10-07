// Library bookkeeping (docs/schema.md §8.1: a local asset's key, published version and pending move) follows
// publishes — not Duplicate, not undo, not Restore version — on the release wasm and both stores: the libraries review's
// second round (Duplicate gives new assets; a removed asset brought back by undo or a restore is not published;
// restore brings Hide when publishing back and leaves nothing over; Restore component over several copies; bookkeeping
// writes wait for an open step; Update counts what it updated).
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { Engine } from "@/engine/Engine";
import { EngineStore } from "@/engine/EngineStore";
import { loadEngine } from "@/engine/loadEngine";
import { runEngineCommand } from "../engineCompat";
import type { Message } from "@/engine/codec";
import { decodeMessage, encodeMessage } from "../../../../shared/schema/codec";
import type { StoreApi } from "../../../../shared/store/repositories";
import { rpcTestbed } from "../../../../store/testing/rpcHarness";
import { messageToKiwi } from "../../store/engineMessage";
import { openStoreDocument, type StoreDocumentSource } from "../../store/documentSource";
import { memoryStorage } from "../../store/memory/kv";
import { MemoryStore } from "../../store/memory/memoryStore";
import { EditorController } from "../controller";
import { COMPONENTS_DOCUMENT } from "../fixtures";
import { acceptUpdates, BOOKKEEPING_WAIT, draftPublish, insertLibraryComponent, isHiddenWhenPublishing, publishLibrary, RESTORE_VERSION, restoreRemovedComponent, setHiddenWhenPublishing, setLibraryEnabled, updateSelectedInstances } from "../libraries";

const wasm = fileURLToPath(new URL("../../engine/wasm/engine.wasm", import.meta.url));

beforeAll(async () => {
  const g = globalThis as Record<string, unknown>;
  g.window ??= globalThis;
  g.document ??= { querySelector: () => null };
  const bytes = readFileSync(wasm);
  await loadEngine({ wasmBinary: bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength), printErr: () => {} });
});

const WAIT = { ...BOOKKEEPING_WAIT };
afterEach(() => Object.assign(BOOKKEEPING_WAIT, WAIT));

type Any = Record<string, unknown>;
type Opened = { ed: EditorController; engine: Engine; source: StoreDocumentSource };

/** Opens a file of a store as the editor does. */
async function openWith(api: StoreApi, fileKey: string): Promise<Opened> {
  const source = await openStoreDocument(api, fileKey, { recordViewed: false });
  const engine = await Engine.create(null, { sessionID: source.sessionID });
  engine.load(await source.load());
  engine.setViewport(1280, 800, 1, 1280, 800);
  const ed = new EditorController(engine, new EngineStore(engine), source);
  engine.onDocumentChanged((_, e) => source.onChanges(e.message, { kind: e.kind, label: e.label }));
  await ed.libraries.refresh();
  return { ed, engine, source };
}

/** The dev store (MemoryStore) with a team folder. */
async function devWorkspace() {
  const store = await MemoryStore.open({ storage: memoryStorage() });
  const api = store.api({});
  const team = await api.workspace.createFolder({ name: "Team", parentId: null });
  const file = async (name: string, doc: Message = COMPONENTS_DOCUMENT) => (await store.addFile({ name, folderId: team.id, snapshot: encodeMessage(messageToKiwi(doc)) })).fileKey;
  return { store, api, file, open: (k: string) => openWith(store.api({}), k) };
}

/** A file with a page and nothing else. */
const EMPTY: Message = { type: "NODE_CHANGES", sessionID: 0, nodeChanges: COMPONENTS_DOCUMENT.nodeChanges.filter((n) => n.type === "DOCUMENT" || n.guid === "0:1") };
const HEART = "1:21";
const BUTTON = "1:1";

/** Publishes everything that changed (the Publish dialog's default selection). */
async function publishAll(ed: EditorController) {
  const d = await draftPublish(ed);
  const v = await publishLibrary(ed, d, { description: "", selected: new Set([...d.items.map((i) => i.key), ...d.removed.map((r) => r.key)]), moveModes: new Map() });
  return { d, v };
}

const read = (ed: EditorController, id: string) => ed.engine.readNode(id, { childIds: true }) as unknown as Any & { childIds?: string[] };
const keysOf = (ed: EditorController) => new Map(ed.engine.localAssets().map((a) => [a.id, a.key]));
const mainOf = (ed: EditorController, id: string) => {
  const s = (read(ed, id).symbolData as { symbolID: string | { sessionID: number; localID: number } }).symbolID;
  return typeof s === "string" ? s : `${s.sessionID}:${s.localID}`;
};
/** What a copy + paste of `ids` from one file into another gives (the clipboard between files). */
function copyInto(from: Opened, ids: string[], to: Opened, cut = false): string[] {
  from.engine.setSelection(ids);
  to.engine.paste(from.engine.encodeSelection({ cut })!);
  return [...to.ed.selection];
}

describe("library bookkeeping follows publishes (docs/schema.md §8.1, docs/data.md §9)", () => {
  it("Duplicate file and Duplicate version: the copy's assets are new — no key, published version or move — and library copies keep theirs (dev store and desktop store)", async () => {
    const bed = await rpcTestbed();
    try {
      const dev = await devWorkspace();
      const desktopApi = await bed.connect("editor");
      const team = await desktopApi.workspace.createFolder({ name: "Team", parentId: null });
      const desktop = {
        api: desktopApi as unknown as StoreApi,
        // A new file holding the fixture: its nodes written into an empty file.
        file: async (name: string) => {
          const fileKey = (await desktopApi.workspace.createFile({ name, folderId: team.id })).fileKey;
          const o = await openWith(desktopApi as unknown as StoreApi, fileKey);
          o.engine.applyChanges({ type: "NODE_CHANGES", sessionID: o.source.sessionID, nodeChanges: COMPONENTS_DOCUMENT.nodeChanges.filter((n) => n.type !== "DOCUMENT" && n.guid !== "0:1" && n.type !== "CANVAS") });
          await o.source.close();
          return fileKey;
        },
        open: (k: string) => openWith(desktopApi as unknown as StoreApi, k),
      };
      for (const w of [{ api: dev.api as StoreApi, file: (n: string) => dev.file(n), open: dev.open }, desktop]) {
        const kit = await w.open(await w.file("Kit"));
        const { v: kitV1 } = await publishAll(kit.ed);
        // Kit 2 publishes its own components, uses Kit's Button, and has a component cut from Kit, not published yet.
        const kit2Key = await w.file("Kit 2");
        const kit2 = await w.open(kit2Key);
        const { v: kit2V1 } = await publishAll(kit2.ed);
        await setLibraryEnabled(kit2.ed, kit.source.fileKey, true);
        const kitButton = kitV1.assets.find((a) => a.name === "Button")!;
        expect(await insertLibraryComponent(kit2.ed, kit.source.fileKey, kitButton)).toBeTruthy();
        const [moved] = copyInto(kit, [HEART], kit2, true);
        expect(read(kit2.ed, moved).libraryMoveInfo).toBeTruthy();
        const saved = await kit2.source.saveVersion({ title: "Before duplicating" });
        await kit2.source.flush();

        const dupFile = await w.api.workspace.duplicateFile(kit2Key);
        const dupVersion = await w.api.files.duplicateVersion(kit2Key, saved.id);
        for (const meta of [dupFile, dupVersion]) {
          const dup = await w.open(meta.fileKey);
          const assets = dup.engine.localAssets();
          expect(assets.length).toBeGreaterThan(4);
          expect(assets.filter((a) => a.key || a.publishedVersion)).toEqual([]);
          expect(assets.filter((a) => read(dup.ed, a.id).libraryMoveInfo)).toEqual([]);
          // Kit's copy is still Kit's Button, at the version it was copied at.
          const copy = dup.ed.libraries.copies().find((c) => c.name === "Button")!;
          expect(copy).toMatchObject({ library: kit.source.fileKey, key: kitButton.key, version: kitButton.versionHash });
          expect(dup.ed.libraries.pendingCount()).toBe(0);
          await dup.source.close();
        }
        // The duplicate publishes as a new library: its own keys, no move claimed.
        const dup = await w.open(dupFile.fileKey);
        const d = await draftPublish(dup.ed);
        expect(d.moves).toEqual([]);
        const original = new Set(kit2V1.assets.map((a) => a.key));
        expect(d.items.length).toBeGreaterThan(0);
        expect(d.items.filter((i) => original.has(i.key))).toEqual([]);
        // The original is untouched: its keys, published versions and the pending move.
        expect(kit2.engine.localAssets().filter((a) => a.key && original.has(a.key) && a.publishedVersion).length).toBe(kit2V1.assets.length);
        expect(read(kit2.ed, moved).libraryMoveInfo).toBeTruthy();
        for (const o of [kit, kit2, dup]) await o.source.close();
      }
    } finally {
      await bed.close();
    }
  });

  it("delete → publish (removed) → undo: the main comes back unpublished at once — a paste elsewhere is a new main, a cut no move (finding 15)", async () => {
    const w = await devWorkspace();
    const lib = await w.open(await w.file("L"));
    const { v: v1 } = await publishAll(lib.ed);
    const heartKey = v1.assets.find((a) => a.name === "Icons/Heart")!.key;
    lib.engine.setSelection([HEART]);
    lib.engine.command("DELETE");
    expect(lib.engine.readNode(HEART)).toBeNull();
    const { v: v2 } = await publishAll(lib.ed);
    expect(v2.assets.some((a) => a.key === heartKey)).toBe(false);
    expect(lib.engine.undo()).toBe(true);
    // Checked against the latest manifest as the undo lands (no wait for the store).
    expect(read(lib.ed, HEART).publishedVersion).toBeUndefined();
    expect(read(lib.ed, HEART).key).toBe(heartKey);
    expect(lib.ed.store.undo.undoLabel).not.toBe("Publish");
    const d3 = await draftPublish(lib.ed);
    expect(d3.items.find((i) => i.key === heartKey)!.status).toBe("created");
    const f = await w.open(await w.file("F", EMPTY));
    const [pasted] = copyInto(lib, [HEART], f);
    expect(read(f.ed, pasted)).toMatchObject({ type: "SYMBOL" });
    expect(f.ed.libraries.copies()).toEqual([]);
    const g = await w.open(await w.file("G", EMPTY));
    const [cut] = copyInto(lib, [HEART], g, true);
    expect(read(g.ed, cut).libraryMoveInfo).toBeUndefined();
    expect((await draftPublish(g.ed)).moves).toEqual([]);
    // Redo (deleted again) and undo again: still not published; and after reopening.
    lib.engine.redo();
    lib.engine.undo();
    expect(read(lib.ed, HEART).publishedVersion).toBeUndefined();
    await lib.source.close();
    const again = await w.open(lib.source.fileKey);
    expect(read(again.ed, HEART).publishedVersion).toBeUndefined();
  });

  it("Restore version: the content and Hide when publishing come back; keys and published versions stay as published; nothing is left over (findings 15, 22)", async () => {
    const w = await devWorkspace();
    const libKey = await w.file("L");
    const lib = await w.open(libKey);
    const beforePublish = await lib.source.saveVersion({ title: "Before the first publish" });
    const { v: v1 } = await publishAll(lib.ed);
    const heartKey = v1.assets.find((a) => a.name === "Icons/Heart")!.key;
    const saved = await lib.source.saveVersion({ title: "v1" });
    setHiddenWhenPublishing(lib.ed, HEART, true);
    const { v: v2 } = await publishAll(lib.ed);
    expect(v2.assets.some((a) => a.key === heartKey)).toBe(false);
    const keys = keysOf(lib.ed);
    const restore = async (id: string) => {
      await lib.source.flush();
      await lib.source.restoreVersion(id, (diff) => lib.ed.batch(RESTORE_VERSION, () => void lib.engine.applyChanges(diff, "restore")));
    };

    await restore(saved.id);
    expect(isHiddenWhenPublishing(lib.ed, HEART)).toBe(false); // the hide is undone with the rest
    expect(read(lib.ed, HEART).publishedVersion).toBeUndefined(); // v2 removed it
    expect(keysOf(lib.ed)).toEqual(keys);
    expect(lib.ed.store.undo.undoLabel).toBe(RESTORE_VERSION);
    expect((await draftPublish(lib.ed)).items.find((i) => i.key === heartKey)!.status).toBe("created");
    const f = await w.open(await w.file("F", EMPTY));
    expect(read(f.ed, copyInto(lib, [HEART], f)[0]).type).toBe("SYMBOL");
    // The store's head is the version now: no diff left (no clears of defaults, no bookkeeping).
    await lib.source.flush();
    expect(decodeMessage(await w.api.files.restoreDiff(libKey, saved.id)).nodeChanges).toEqual([]);

    // A version saved before the first publish: content back, keys and published versions kept.
    const published = new Map(lib.engine.localAssets().map((a) => [a.id, a.publishedVersion]));
    await restore(beforePublish.id);
    expect(keysOf(lib.ed)).toEqual(keys);
    expect(new Map(lib.engine.localAssets().map((a) => [a.id, a.publishedVersion]))).toEqual(published);
    await lib.source.close();
    const again = await w.open(libKey);
    expect(isHiddenWhenPublishing(again.ed, HEART)).toBe(false);
    expect(keysOf(again.ed)).toEqual(keys);
  });

  it("Restore version in a consumer whose copy was updated: the copy's fields go back to their defaults, nothing left over (finding 22)", async () => {
    const w = await devWorkspace();
    const kitKey = await w.file("Kit");
    const kit = await w.open(kitKey);
    await publishAll(kit.ed);
    const appKey = await w.file("App", EMPTY);
    const app = await w.open(appKey);
    await setLibraryEnabled(app.ed, kitKey, true);
    const inst = (await insertLibraryComponent(app.ed, kitKey, app.ed.libraries.get().manifests.get(kitKey)!.assets.find((a) => a.name === "Button")!))!;
    const copy = app.ed.libraries.copies().find((c) => c.name === "Button")!;
    const saved = await app.source.saveVersion({ title: "Before the update" });
    // The library sets fields that were at their defaults (opacity, effects) and publishes; the app updates.
    const shadow = { type: "DROP_SHADOW", color: { r: 0, g: 0, b: 0, a: 0.25 }, offset: { x: 0, y: 4 }, radius: 4, spread: 0, visible: true, blendMode: "NORMAL" };
    kit.ed.setProps([BUTTON], { opacity: 0.5, effects: [shadow] } as never, "Style");
    await publishAll(kit.ed);
    await app.ed.libraries.refresh();
    expect(await acceptUpdates(app.ed, app.ed.libraries.updates())).toBe(1);
    expect(read(app.ed, copy.guid).opacity).toBe(0.5);
    await app.source.flush();
    await app.source.restoreVersion(saved.id, (diff) => app.ed.batch(RESTORE_VERSION, () => void app.engine.applyChanges(diff, "restore")));
    const restored = read(app.ed, copy.guid);
    expect(restored.opacity ?? 1).toBe(1);
    expect((restored.effects as unknown[] | undefined) ?? []).toEqual([]);
    expect(read(app.ed, inst).opacity ?? 1).toBe(1);
    expect(app.ed.libraries.copies().find((c) => c.guid === copy.guid)!.version).toBe(copy.version);
    await app.source.flush();
    expect(decodeMessage(await w.api.files.restoreDiff(appKey, saved.id)).nodeChanges).toEqual([]);
    await app.source.close();
    const again = await w.open(appKey);
    expect(read(again.ed, copy.guid).opacity ?? 1).toBe(1);
    await again.ed.libraries.refresh();
    expect(again.ed.libraries.pendingCount()).toBe(1); // the update is offered again
  });

  it("Restore component on a removed asset with several copies: every copy's instances follow the restored main, one undo step", async () => {
    const w = await devWorkspace();
    const kitKey = await w.file("Kit");
    const kit = await w.open(kitKey);
    const { v } = await publishAll(kit.ed);
    const app = await w.open(await w.file("App", EMPTY));
    await setLibraryEnabled(app.ed, kitKey, true);
    const heart = v.assets.find((a) => a.name === "Icons/Heart")!;
    const a = (await insertLibraryComponent(app.ed, kitKey, heart))!;
    // A second copy of the Heart (as Update selected instance leaves), with an instance of its own.
    const payloads = await app.source.libraries!.payloads(kitKey, [{ key: heart.key, versionHash: heart.versionHash }], { withDependencies: true });
    const second = app.engine.importLibraryAssets(payloads.map((p) => p.message), { libraryKey: kitKey, asNew: true, keys: [heart.key] }).assets.find((x) => x.key === heart.key && x.created)!.id;
    runEngineCommand(app.engine, "INSERT_INSTANCE", { main: second, x: 300, y: 300 });
    const b = app.ed.selection[0];
    expect(mainOf(app.ed, b)).toBe(second);
    // The Kit removes the Heart.
    setHiddenWhenPublishing(kit.ed, HEART, true);
    await publishAll(kit.ed);
    await app.ed.libraries.refresh();
    const [u] = app.ed.libraries.updates();
    expect([u.kind, u.copies.length]).toEqual(["removed", 2]);
    const restored = restoreRemovedComponent(app.ed, u.copy.guid)!;
    expect(restored).toBeTruthy();
    expect(read(app.ed, restored).sourceLibraryKey).toBeUndefined();
    expect([mainOf(app.ed, a), mainOf(app.ed, b)]).toEqual([restored, restored]);
    expect(app.engine.readNode(second)).toBeNull();
    expect(app.ed.libraries.copies().filter((c) => c.key === heart.key)).toEqual([]);
    await app.ed.libraries.refresh();
    expect(app.ed.libraries.updates()).toEqual([]);
    expect(app.ed.store.undo.undoLabel).toBe("Restore component");
    expect(app.engine.undo()).toBe(true);
    expect(mainOf(app.ed, b)).toBe(second);
    expect(read(app.ed, u.copy.guid).sourceLibraryKey).toBe(kitKey);
  });

  it("bookkeeping writes wait for an open step to close: publishing, Add to file (markPublished / system changes refused with E_BUSY)", async () => {
    const w = await devWorkspace();
    const libKey = await w.file("L");
    const lib = await w.open(libKey);
    const draft = await draftPublish(lib.ed);
    const all = { description: "", selected: new Set(draft.items.map((i) => i.key)), moveModes: new Map<string, "move" | "copy">() };
    // A scrub is open while the store publishes: the version is recorded once it closes, outside that step.
    lib.engine.txnBegin("Opacity");
    lib.ed.setProps([BUTTON], { opacity: 0.8 } as never, "Opacity");
    const publishing = publishLibrary(lib.ed, draft, all);
    await new Promise((r) => setTimeout(r, 30));
    expect(read(lib.ed, BUTTON).publishedVersion).toBeUndefined();
    lib.engine.txnCommit();
    const v1 = await publishing;
    expect(v1.recorded).toBe(true);
    expect(read(lib.ed, BUTTON).publishedVersion).toBe(v1.assets.find((a) => a.name === "Button")!.versionHash);
    expect(lib.ed.store.undo.undoLabel).toBe("Opacity");
    lib.engine.undo();
    expect(read(lib.ed, BUTTON).publishedVersion).toBeTruthy(); // not part of the scrub's step

    // Held open past the wait: the publish says it isn't recorded; the index records it later.
    Object.assign(BOOKKEEPING_WAIT, { tries: 2, ms: 5 });
    lib.ed.setProps([BUTTON], { opacity: 0.6 } as never, "Opacity");
    const d2 = await draftPublish(lib.ed);
    lib.engine.txnBegin("Rename");
    lib.ed.setProps([BUTTON], { name: "Button 2" } as never, "Rename");
    const v2 = await publishLibrary(lib.ed, d2, { ...all, selected: new Set(d2.items.map((i) => i.key)) });
    expect(v2.recorded).toBe(false);
    lib.engine.txnCommit();
    await lib.ed.libraries.reconcile();
    expect(read(lib.ed, BUTTON).publishedVersion).toBe(v2.assets.find((a) => a.name === "Button")!.versionHash);

    // Add to file during an open step: the document's list follows once it closes, not undoable.
    Object.assign(BOOKKEEPING_WAIT, WAIT);
    const app = await w.open(await w.file("App", EMPTY));
    app.engine.txnBegin("Move");
    const adding = setLibraryEnabled(app.ed, libKey, true);
    await new Promise((r) => setTimeout(r, 30));
    app.engine.txnCommit();
    await adding;
    expect((app.engine.readNode("0:0") as unknown as Any).librarySubscriptions).toEqual([{ libraryKey: libKey, name: "L" }]);
    expect(app.ed.libraries.get().enabled).toEqual([libKey]);
  });

  it("accepting one asset brings the hidden assets it uses: a Button bound to a hidden variable shows the variable's new value (Update, Update selected instance)", async () => {
    const w = await devWorkspace();
    const kitKey = await w.file("Kit");
    const kit = await w.open(kitKey);
    // The Button's fill is bound to `_Tokens/x`: a hidden collection, shipped only with what uses it.
    const [tokens, mode] = kit.engine.runCommand("CREATE_VARIABLE_COLLECTION", { name: "_Tokens" }).created;
    const x = kit.engine.runCommand("CREATE_VARIABLE", { collection: tokens, type: "COLOR", name: "x", value: { r: 1, g: 0, b: 0, a: 1 } }).created[0];
    expect(kit.engine.command("BIND_VARIABLE", { refs: [BUTTON], target: "fillPaints[0].color", variable: x })).toBe(0);
    const { v: v1 } = await publishAll(kit.ed);
    expect(v1.assets.filter((a) => a.dependencyOnly).map((a) => a.name).sort()).toEqual(["_Tokens", "x"]);
    const app = await w.open(await w.file("App", EMPTY));
    await setLibraryEnabled(app.ed, kitKey, true);
    const button = v1.assets.find((a) => a.name === "Button")!;
    const a = (await insertLibraryComponent(app.ed, kitKey, button))!;
    const b = (await insertLibraryComponent(app.ed, kitKey, button))!;
    const red = (id: string) => (read(app.ed, id).fillPaints as { color: { r: number; g: number } }[])[0].color;
    expect(red(a)).toMatchObject({ r: 1, g: 0 });
    // The library gives x a new value and publishes: the Button is modified (its hash folds the hidden x in).
    expect(kit.engine.command("SET_VARIABLE_VALUE", { variable: x, mode, value: { r: 0, g: 1, b: 0, a: 1 } })).toBe(0);
    const { d: d2 } = await publishAll(kit.ed);
    expect(d2.items.find((i) => i.key === button.key)!.status).toBe("modified");
    await app.ed.libraries.refresh();
    const item = app.ed.libraries.updates().find((u) => u.key === button.key)!;
    expect(item.kind).toBe("modified");
    // Update selected instance on a: a new Button copy and a new x with it; b keeps the old value.
    app.engine.setSelection([a]);
    expect(await updateSelectedInstances(app.ed, item)).toBe(1);
    expect(red(a)).toMatchObject({ r: 0, g: 1 });
    expect(red(b)).toMatchObject({ r: 1, g: 0 });
    app.engine.undo();
    expect(red(a)).toMatchObject({ r: 1, g: 0 });
    // The Button alone (its row's Update): every copy, the hidden x with it — one step.
    await app.ed.libraries.refresh();
    expect(await acceptUpdates(app.ed, [app.ed.libraries.updates().find((u) => u.key === button.key)!])).toBe(1);
    expect(red(a)).toMatchObject({ r: 0, g: 1 });
    expect(red(b)).toMatchObject({ r: 0, g: 1 });
    expect(app.ed.store.undo.undoLabel).toBe("Update library assets");
    await app.ed.libraries.refresh();
    expect(app.ed.libraries.pendingCount()).toBe(0);
  });

  it("a variant the library deleted while an instance here uses it: listed as removed after the update, Restore component works", async () => {
    const w = await devWorkspace();
    const kitKey = await w.file("Kit");
    const kit = await w.open(kitKey);
    const { v: v1 } = await publishAll(kit.ed);
    const app = await w.open(await w.file("App", EMPTY));
    await setLibraryEnabled(app.ed, kitKey, true);
    const chip = v1.assets.find((a) => a.name === "Chip")!;
    const inst = (await insertLibraryComponent(app.ed, kitKey, chip))!;
    const set = app.ed.libraries.copies().find((c) => c.key === chip.key)!.guid;
    const variants = read(app.ed, set).childIds!;
    const used = variants.find((id) => id !== mainOf(app.ed, inst))!;
    const usedName = read(app.ed, used).name as string;
    expect(app.engine.command("SWAP_INSTANCE", { main: used, ref: inst })).toBe(0);
    // The Kit deletes that variant and publishes; the app updates the Chip.
    const gone = (read(kit.ed, "1:40").childIds ?? []).find((id) => read(kit.ed, id).name === usedName)!;
    kit.engine.setSelection([gone]);
    kit.engine.command("DELETE");
    await publishAll(kit.ed);
    await app.ed.libraries.refresh();
    expect(await acceptUpdates(app.ed, app.ed.libraries.updates())).toBe(1);
    await app.ed.libraries.refresh();
    // The instance keeps its variant, now a copy of its own that the library no longer has: a "removed" row.
    const row = app.ed.libraries.updates().find((u) => u.kind === "removed")!;
    expect(row).toBeTruthy();
    expect(row.copy.name).toBe(usedName);
    expect(mainOf(app.ed, inst)).toBe(row.copy.guid);
    const restored = restoreRemovedComponent(app.ed, row.copy.guid)!;
    expect(restored).toBeTruthy();
    expect(read(app.ed, restored).sourceLibraryKey).toBeUndefined();
    expect(mainOf(app.ed, inst)).toBe(restored);
    await app.ed.libraries.refresh();
    expect(app.ed.libraries.updates().filter((u) => u.kind === "removed")).toEqual([]);
  });

  it("Update counts the assets the engine actually updated; Show when publishing is kept after reopening", async () => {
    const w = await devWorkspace();
    const kitKey = await w.file("Kit");
    const kit = await w.open(kitKey);
    await publishAll(kit.ed);
    const app = await w.open(await w.file("App", EMPTY));
    await setLibraryEnabled(app.ed, kitKey, true);
    await insertLibraryComponent(app.ed, kitKey, app.ed.libraries.get().manifests.get(kitKey)!.assets.find((a) => a.name === "Button")!);
    kit.ed.setProps([BUTTON], { opacity: 0.5 } as never, "Opacity");
    await publishAll(kit.ed);
    await app.ed.libraries.refresh();
    const items = app.ed.libraries.updates();
    expect(await acceptUpdates(app.ed, items)).toBe(1);
    expect(await acceptUpdates(app.ed, items)).toBe(0); // the same items again: the copy is at that version, nothing written

    setHiddenWhenPublishing(kit.ed, HEART, true);
    setHiddenWhenPublishing(kit.ed, HEART, false);
    expect(isHiddenWhenPublishing(kit.ed, HEART)).toBe(false);
    await kit.source.close();
    const again = await w.open(kitKey);
    expect(isHiddenWhenPublishing(again.ed, HEART)).toBe(false);
  });
});
