// Libraries end to end on the real engine (headless) and the dev store's registry (the store's own rules): a library
// file publishes its components, styles and variables; another file enables it, inserts a remote component (an
// instance of a read-only copy under the internal canvas) and applies a remote style and variable; the library
// changes and publishes again; the consumer sees the update, reviews it and accepts it (one undo step); removed and
// moved assets; Hide when publishing; Drafts can't publish.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { beforeAll, describe, expect, it } from "vitest";
import { Engine } from "@/engine/Engine";
import { EngineStore } from "@/engine/EngineStore";
import { loadEngine } from "@/engine/loadEngine";
import type { Message } from "@/engine/codec";
import { encodeMessage } from "../../../../shared/schema/codec";
import { messageToKiwi } from "../../store/engineMessage";
import { openStoreDocument, type StoreDocumentSource } from "../../store/documentSource";
import { memoryStorage } from "../../store/memory/kv";
import { MemoryStore } from "../../store/memory/memoryStore";
import { EditorController } from "../controller";
import { COMPONENTS_DOCUMENT, VARIABLES_DOCUMENT } from "../fixtures";
import { acceptUpdates, draftPublish, ensureCopy, insertLibraryComponent, libraryEngine, publishLibrary, restoreRemovedComponent, setHiddenWhenPublishing, setLibraryEnabled, updateSelectedInstances } from "../libraries";
import { applyStyle, bindVariable } from "../variables";

const wasm = fileURLToPath(new URL("../../engine/wasm/engine.wasm", import.meta.url));

beforeAll(async () => {
  const g = globalThis as Record<string, unknown>;
  g.window ??= globalThis;
  g.document ??= { querySelector: () => null };
  const bytes = readFileSync(wasm);
  await loadEngine({ wasmBinary: bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength), printErr: () => {} });
});

type Any = Record<string, unknown>;

async function workspace() {
  const store = await MemoryStore.open({ storage: memoryStorage() });
  const api = store.api({});
  const team = await api.workspace.createFolder({ name: "Team", parentId: null });
  const file = async (name: string, doc: Message, folderId: string | null = team.id) => (await store.addFile({ name, folderId, snapshot: encodeMessage(messageToKiwi(doc)) })).fileKey;
  const open = async (fileKey: string) => {
    const source: StoreDocumentSource = await openStoreDocument(store.api({}), fileKey, { recordViewed: false });
    const engine = await Engine.create(null, { sessionID: source.sessionID });
    engine.load(await source.load());
    engine.setViewport(1280, 800, 1, 1280, 800);
    const ed = new EditorController(engine, new EngineStore(engine), source);
    engine.onDocumentChanged((_, e) => source.onChanges(e.message, { kind: e.kind, label: e.label }));
    await ed.libraries.refresh();
    return { ed, engine, source };
  };
  return { store, api, team, file, open };
}

const read = (ed: EditorController, id: string) => ed.engine.readNode(id, { childIds: true }) as unknown as Any & { childIds?: string[] };
const copyOfKey = (ed: EditorController, lib: string, name: string) => ed.libraries.copies().find((c) => c.library === lib && c.name === name);

describe("libraries (docs/data.md §9)", () => {
  it("publish → enable in another file → insert → change → publish → review → update", async () => {
    const w = await workspace();
    const libKey = await w.file("Design System", COMPONENTS_DOCUMENT);
    const appKey = await w.file("App", { type: "NODE_CHANGES", sessionID: 0, nodeChanges: COMPONENTS_DOCUMENT.nodeChanges.filter((n) => n.type === "DOCUMENT" || n.guid === "0:1") });

    // ---- The library publishes.
    const lib = await w.open(libKey);
    const draft = await draftPublish(lib.ed);
    const listed = draft.items.filter((i) => !i.dependencyOnly);
    expect(listed.map((i) => i.asset.name).sort()).toEqual(["Button", "Chip", "Icons/Heart", "Icons/Star"]);
    expect(listed.every((i) => i.status === "created")).toBe(true);
    const button = listed.find((i) => i.asset.name === "Button")!;
    expect(button.dependencies).toEqual([listed.find((i) => i.asset.name === "Icons/Star")!.key]); // the nested instance's main
    const v1 = await publishLibrary(lib.ed, draft, { description: "First release", selected: new Set(listed.map((i) => i.key)), moveModes: new Map() });
    expect(v1.version).toBe(1);
    expect(v1.description).toBe("First release");
    // Keys and published versions are written into the assets; a second draft has nothing to publish.
    expect(read(lib.ed, button.asset.guid).key).toBe(button.key);
    expect(read(lib.ed, button.asset.guid).publishedVersion).toBe(button.versionHash);
    const again = await draftPublish(lib.ed);
    expect(again.items.filter((i) => i.status === "created" || i.status === "modified")).toEqual([]);
    expect(lib.ed.libraries.get().own?.latestVersion).toBe(1);

    // ---- The app enables it and inserts the Button: a copy under the internal canvas (with the nested Star), one step.
    const app = await w.open(appKey);
    expect(app.ed.libraries.get().available.map((l) => l.name)).toEqual(["Design System"]);
    await setLibraryEnabled(app.ed, libKey, true);
    expect(app.ed.libraries.get().enabled).toEqual([libKey]);
    expect((app.engine.readNode("0:0") as unknown as Any).librarySubscriptions).toEqual([{ libraryKey: libKey, name: "Design System" }]);
    const remoteButton = app.ed.libraries.get().manifests.get(libKey)!.assets.find((a) => a.name === "Button")!;
    const inst = await insertLibraryComponent(app.ed, libKey, remoteButton);
    expect(inst).toBeTruthy();
    const instance = read(app.ed, inst!);
    expect(instance.type).toBe("INSTANCE");
    const copy = copyOfKey(app.ed, libKey, "Button")!;
    expect(copy).toMatchObject({ key: remoteButton.key, version: remoteButton.versionHash, kind: "COMPONENT" });
    expect(read(app.ed, (read(app.ed, copy.guid).parentIndex as { guid: string }).guid)).toMatchObject({ type: "CANVAS", internalOnly: true });
    expect(copyOfKey(app.ed, libKey, "Icons/Star")).toBeTruthy(); // its dependency came along
    expect((instance.childIds ?? []).length).toBeGreaterThan(0); // materialized from the copy
    app.engine.undo();
    expect(app.engine.readNode(inst!)).toBeNull(); // one step (the engine's import is a SYSTEM change; the editor's shares the step)
    app.engine.redo();
    expect(app.engine.readNode(inst!)).not.toBeNull();
    await app.ed.libraries.refresh();
    expect(app.ed.libraries.pendingCount()).toBe(0);

    // ---- The library changes the Button (its fill) and publishes v2; the Star is removed (hidden).
    lib.ed.setProps([button.asset.guid], { fillPaints: [{ type: "SOLID", color: { r: 1, g: 0, b: 0, a: 1 }, opacity: 1, visible: true, blendMode: "NORMAL" }] } as never, "Fill");
    const star = listed.find((i) => i.asset.name === "Icons/Heart")!;
    setHiddenWhenPublishing(lib.ed, star.asset.guid, true);
    const d2 = await draftPublish(lib.ed);
    expect(d2.items.find((i) => i.key === button.key)!.status).toBe("modified");
    expect(d2.removed.map((r) => r.name)).toEqual(["Icons/Heart"]);
    await publishLibrary(lib.ed, d2, { description: "Red button", selected: new Set([button.key, ...d2.removed.map((r) => r.key)]), moveModes: new Map() });

    // ---- The app finds the update, reviews it, accepts it in one step; the instance follows.
    await app.ed.libraries.refresh();
    const updates = app.ed.libraries.updates();
    expect(updates.map((u) => [u.copy.name, u.kind])).toEqual([["Button", "modified"]]);
    expect(app.ed.libraries.pendingCount()).toBe(1);
    const n = await acceptUpdates(app.ed, updates);
    expect(n).toBeGreaterThan(0);
    const updated = copyOfKey(app.ed, libKey, "Button")!;
    expect(updated.guid).toBe(copy.guid); // updated in place: instances keep pointing at it
    expect(updated.version).not.toBe(copy.version);
    expect((read(app.ed, copy.guid).fillPaints as { color: { r: number } }[])[0].color.r).toBe(1);
    expect((read(app.ed, inst!).fillPaints as { color: { r: number } }[])[0].color.r).toBe(1);
    expect(app.ed.libraries.pendingCount()).toBe(0);
    app.engine.undo();
    expect(read(app.ed, copy.guid).version).toBe(copy.version);
    app.engine.redo();

    // ---- Removing the library keeps what is used.
    await setLibraryEnabled(app.ed, libKey, false);
    expect(app.engine.readNode(copy.guid)).not.toBeNull();
    expect(app.engine.readNode(inst!)).not.toBeNull();
  });

  it("Update selected instance moves only the selection onto the new version", async () => {
    const w = await workspace();
    const libKey = await w.file("Kit", COMPONENTS_DOCUMENT);
    const appKey = await w.file("App", { type: "NODE_CHANGES", sessionID: 0, nodeChanges: COMPONENTS_DOCUMENT.nodeChanges.filter((n) => n.type === "DOCUMENT" || n.guid === "0:1") });
    const lib = await w.open(libKey);
    let d = await draftPublish(lib.ed);
    await publishLibrary(lib.ed, d, { description: "", selected: new Set(d.items.map((i) => i.key)), moveModes: new Map() });
    const app = await w.open(appKey);
    await setLibraryEnabled(app.ed, libKey, true);
    const asset = app.ed.libraries.get().manifests.get(libKey)!.assets.find((a) => a.name === "Icons/Star")!;
    const a = (await insertLibraryComponent(app.ed, libKey, asset))!;
    const b = (await insertLibraryComponent(app.ed, libKey, asset))!;
    const star = d.items.find((i) => i.asset.name === "Icons/Star")!;
    lib.ed.setProps([star.asset.guid], { size: { x: 24, y: 24 } } as never, "Resize");
    d = await draftPublish(lib.ed);
    await publishLibrary(lib.ed, d, { description: "", selected: new Set([star.key]), moveModes: new Map() });
    await app.ed.libraries.refresh();
    const [u] = app.ed.libraries.updates();
    app.engine.setSelection([a]);
    expect(await updateSelectedInstances(app.ed, u)).toBe(1);
    const stars = app.ed.libraries.copies().filter((c) => c.name === "Icons/Star");
    expect(stars).toHaveLength(2);
    const mainOf = (id: string) => (read(app.ed, id).symbolData as { symbolID: { sessionID: number; localID: number } }).symbolID;
    expect(mainOf(a)).not.toEqual(mainOf(b));
    expect((read(app.ed, a).size as { x: number }).x).toBe(24);
    expect((read(app.ed, b).size as { x: number }).x).toBe(16);
    expect(app.ed.libraries.pendingCount()).toBe(1); // b still has the update waiting
  });

  it("remote styles and variables are applied through their copies; Drafts can't publish", async () => {
    const w = await workspace();
    const libKey = await w.file("Tokens", VARIABLES_DOCUMENT);
    const draftKey = await w.file("Scratch", VARIABLES_DOCUMENT, null);
    const appKey = await w.file("App", { type: "NODE_CHANGES", sessionID: 0, nodeChanges: COMPONENTS_DOCUMENT.nodeChanges.filter((n) => n.type === "DOCUMENT" || n.guid === "0:1" || n.parentIndex?.guid === "0:1") });
    const scratch = await w.open(draftKey);
    expect(scratch.ed.libraries.get().inDrafts).toBe(true);
    const sd = await draftPublish(scratch.ed);
    await expect(publishLibrary(scratch.ed, sd, { description: "", selected: new Set(sd.items.map((i) => i.key)), moveModes: new Map() })).rejects.toMatchObject({ code: "draft-cannot-publish" });

    const lib = await w.open(libKey);
    const d = await draftPublish(lib.ed);
    const kinds = new Set(d.items.filter((i) => !i.dependencyOnly).map((i) => i.asset.kind));
    expect(kinds).toEqual(new Set(["STYLE", "VARIABLE_COLLECTION", "VARIABLE"]));
    await publishLibrary(lib.ed, d, { description: "", selected: new Set(d.items.map((i) => i.key)), moveModes: new Map() });

    const app = await w.open(appKey);
    await setLibraryEnabled(app.ed, libKey, true);
    const manifest = app.ed.libraries.get().manifests.get(libKey)!;
    const colorStyle = manifest.assets.find((a) => a.kind === "STYLE" && a.styleType === "FILL")!;
    const styleCopy = (await ensureCopy(app.ed, libKey, colorStyle.key))!;
    expect(styleCopy).toBeTruthy();
    const target = app.ed.engine.readNode("0:1", { childIds: true })!.childIds![0];
    applyStyle(app.ed, [target], "fill", styleCopy);
    expect(((read(app.ed, target).styleIdForFill as { guid: unknown }).guid as unknown)).toBeTruthy();
    // The local lists leave library copies out.
    expect(app.ed.variables.get().styles.some((s) => s.id === styleCopy)).toBe(false);
    const colorVar = manifest.assets.find((a) => a.kind === "VARIABLE" && a.resolvedType === "FLOAT")!;
    const varCopy = (await ensureCopy(app.ed, libKey, colorVar.key))!;
    expect(app.ed.libraries.copies().some((c) => c.kind === "VARIABLE_COLLECTION")).toBe(true); // its collection came along
    bindVariable(app.ed, [target], ["CORNER_RADIUS"], varCopy);
    expect(app.ed.variables.get().lookup.variable(varCopy)).toBeTruthy(); // pills still find the name
  });

  it("a published component pasted into another file is marked moved; Publish offers Move to this file", async () => {
    const w = await workspace();
    const oldKey = await w.file("Old kit", COMPONENTS_DOCUMENT);
    const newKey = await w.file("New kit", { type: "NODE_CHANGES", sessionID: 0, nodeChanges: COMPONENTS_DOCUMENT.nodeChanges.filter((n) => n.type === "DOCUMENT" || n.guid === "0:1") });
    const old = await w.open(oldKey);
    const d = await draftPublish(old.ed);
    await publishLibrary(old.ed, d, { description: "", selected: new Set(d.items.map((i) => i.key)), moveModes: new Map() });
    const star = d.items.find((i) => i.asset.name === "Icons/Heart")!;
    old.engine.setSelection([star.asset.guid]);
    // Cut (⌘X) in the old kit, pasted in the new one: the engine moves it here (libraryMoveInfo, no key yet).
    const cut = old.engine.encodeSelection({ cut: true })! as Message & { pasteFileKey?: string; isCut?: boolean };
    expect(cut).toMatchObject({ pasteFileKey: oldKey, isCut: true });
    const next = await w.open(newKey);
    next.engine.paste(cut);
    const pasted = next.ed.selection[0];
    expect(read(next.ed, pasted).libraryMoveInfo).toEqual({ oldKey: star.key, pasteFileKey: oldKey });
    const nd = await draftPublish(next.ed);
    expect(nd.moves.map((m) => [m.fromKey, m.fromName])).toEqual([[star.key, "Old kit"]]);
    await publishLibrary(next.ed, nd, { description: "", selected: new Set(nd.items.map((i) => i.key)), moveModes: new Map([[star.key, "move"]]) });
    expect((await w.api.libraries.getRecord(newKey))!.movedIn.map((r) => r.fromKey)).toEqual([star.key]);
    expect(read(next.ed, pasted).libraryMoveInfo).toBeUndefined();

    // The old kit publishes without it: listed as moved, not removed.
    setHiddenWhenPublishing(old.ed, star.asset.guid, true);
    const od = await draftPublish(old.ed);
    expect(od.removed).toEqual([]);
    expect(od.preview.moved.map((m) => m.toLibraryFileKey)).toEqual([newKey]);
    await publishLibrary(old.ed, od, { description: "", selected: new Set(), moveModes: new Map() });
    // A consumer of the old kit sees it as moved; accepting re-points the copy to the new kit (enabled for it).
    const appKey = await w.file("App", { type: "NODE_CHANGES", sessionID: 0, nodeChanges: COMPONENTS_DOCUMENT.nodeChanges.filter((n) => n.type === "DOCUMENT" || n.guid === "0:1") });
    // (the app took the Heart from the old kit before it moved)
    const app = await w.open(appKey);
    await setLibraryEnabled(app.ed, oldKey, true);
    const heart = (await w.api.libraries.getVersion(oldKey, 1)).assets.find((a) => a.name === "Icons/Heart")!;
    const inst = (await insertLibraryComponent(app.ed, oldKey, heart))!;
    await app.ed.libraries.refresh();
    const u = app.ed.libraries.updates().find((x) => x.kind === "moved")!;
    expect(u.redirect!.toLibraryFileKey).toBe(newKey);
    await acceptUpdates(app.ed, [u]);
    const c = app.ed.libraries.copies().find((x) => x.guid === u.copy.guid)!;
    expect(c.library).toBe(newKey);
    expect(app.ed.libraries.get().enabled).toContain(newKey);
    expect(app.engine.readNode(inst)).not.toBeNull();

    // Removed from its library: the consumer keeps it; Restore component makes it a local main its instances use.
    const restored = restoreRemovedComponent(app.ed, c.guid)!;
    expect(restored).toBeTruthy();
    expect(read(app.ed, restored)).toMatchObject({ type: "SYMBOL", parentIndex: { guid: app.ed.store.page } });
    expect(read(app.ed, restored).sourceLibraryKey).toBeUndefined();
    const main = (read(app.ed, inst).symbolData as { symbolID: { sessionID: number; localID: number } }).symbolID;
    expect(`${main.sessionID}:${main.localID}`).toBe(restored);
  });

  it("between files on the engine: a copied instance of a published main pastes as an instance of a library copy; a cut main moves", async () => {
    const w = await workspace();
    const kitKey = await w.file("Kit", COMPONENTS_DOCUMENT);
    const empty = { type: "NODE_CHANGES" as const, sessionID: 0, nodeChanges: COMPONENTS_DOCUMENT.nodeChanges.filter((n) => n.type === "DOCUMENT" || n.guid === "0:1") };
    const appKey = await w.file("App", empty);
    const kit = await w.open(kitKey);
    expect(libraryEngine(kit.ed)).toBe(true);
    const d = await draftPublish(kit.ed);
    await publishLibrary(kit.ed, d, { description: "", selected: new Set(d.items.map((i) => i.key)), moveModes: new Map() });
    const app = await w.open(appKey);
    // Copy an instance of the published Button ("2:2") and paste it in the App.
    kit.engine.setSelection(["2:2"]);
    const copied = kit.engine.encodeSelection({ cut: false }) as Message & { pasteFileKey?: string };
    expect(copied.pasteFileKey).toBe(kitKey);
    app.engine.paste(copied);
    await app.ed.libraries.refresh();
    const pasted = read(app.ed, app.ed.selection[0]);
    expect(pasted.type).toBe("INSTANCE");
    const main = (pasted.symbolData as { symbolID: { sessionID: number; localID: number } }).symbolID;
    const copy = app.ed.libraries.copies().find((c) => c.guid === `${main.sessionID}:${main.localID}`);
    expect(copy).toMatchObject({ library: kitKey, name: "Button" });
    // Cut a published main (Icons/Heart) and paste it in a third file: it is moved there.
    const nextKey = await w.file("Next", empty);
    const next = await w.open(nextKey);
    const heart = d.items.find((i) => i.asset.name === "Icons/Heart")!;
    kit.engine.setSelection([heart.asset.guid]);
    const cut = kit.engine.encodeSelection({ cut: true })!;
    next.engine.paste(cut);
    const moved = next.ed.selection.map((id) => read(next.ed, id)).find((n) => n.type === "SYMBOL");
    expect(moved?.libraryMoveInfo).toEqual({ oldKey: heart.key, pasteFileKey: kitKey });
    const nd = await draftPublish(next.ed);
    expect(nd.moves.map((m) => [m.fromKey, m.fromName])).toEqual([[heart.key, "Kit"]]);
  });
});
