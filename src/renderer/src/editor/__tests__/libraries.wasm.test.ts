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
import { rpcTestbed } from "../../../../store/testing/rpcHarness";
import { messageToKiwi } from "../../store/engineMessage";
import { openStoreDocument, type StoreDocumentSource } from "../../store/documentSource";
import { memoryStorage } from "../../store/memory/kv";
import { MemoryStore } from "../../store/memory/memoryStore";
import { EditorController } from "../controller";
import { COMPONENTS_DOCUMENT, VARIABLES_DOCUMENT } from "../fixtures";
import { goToComponent } from "../components";
import { acceptUpdates, draftPublish, ensureCopy, hasPublishChanges, insertLibraryComponent, libraryEngine, publishLibrary, publishPlan, restoreRemovedComponent, setHiddenWhenPublishing, setLibraryEnabled, updateId, updateSelectedInstances } from "../libraries";
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

/** A file with a page and nothing else. */
const EMPTY: Message = { type: "NODE_CHANGES", sessionID: 0, nodeChanges: COMPONENTS_DOCUMENT.nodeChanges.filter((n) => n.type === "DOCUMENT" || n.guid === "0:1") };
const RED = [{ type: "SOLID", color: { r: 1, g: 0, b: 0, a: 1 }, opacity: 1, visible: true, blendMode: "NORMAL" }];
const GREEN = [{ type: "SOLID", color: { r: 0, g: 1, b: 0, a: 1 }, opacity: 1, visible: true, blendMode: "NORMAL" }];

/** Publishes everything that changed (the Publish dialog's default selection). */
async function publishAll(ed: EditorController, description = "") {
  const d = await draftPublish(ed);
  const v = await publishLibrary(ed, d, { description, selected: new Set([...d.items.map((i) => i.key), ...d.removed.map((r) => r.key)]), moveModes: new Map() });
  return { d, v };
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

  // ---- The review of the libraries round (docs/engine-build.md "Libraries — review fixes") ----

  it("Update selected instance makes a complete second copy (layers, variants); Update all then brings every copy forward, one undo step (findings 6, 9, 10, 21)", async () => {
    const w = await workspace();
    const libKey = await w.file("Kit", COMPONENTS_DOCUMENT);
    const appKey = await w.file("App", EMPTY);
    const lib = await w.open(libKey);
    await publishAll(lib.ed);
    const app = await w.open(appKey);
    await setLibraryEnabled(app.ed, libKey, true);
    const remote = (name: string) => app.ed.libraries.get().manifests.get(libKey)!.assets.find((a) => a.name === name)!;
    const a = (await insertLibraryComponent(app.ed, libKey, remote("Button")))!;
    const b = (await insertLibraryComponent(app.ed, libKey, remote("Button")))!;
    const c1 = (await insertLibraryComponent(app.ed, libKey, remote("Chip")))!;
    const c2 = (await insertLibraryComponent(app.ed, libKey, remote("Chip")))!;
    const layers = (id: string) => (read(app.ed, id).childIds ?? []).length;
    const bLayers = layers(b);
    expect(bLayers).toBeGreaterThan(1); // the Star instance and the Label
    // v2: the Button and a Chip variant change.
    lib.ed.setProps(["1:1"], { fillPaints: RED } as never, "Fill");
    lib.ed.setProps(["1:41"], { fillPaints: RED } as never, "Fill");
    await publishAll(lib.ed);
    await app.ed.libraries.refresh();
    const ups = app.ed.libraries.updates();
    expect(ups.map((u) => [u.copy.name, u.kind]).sort()).toEqual([["Button", "modified"], ["Chip", "modified"]]);

    // Update selected instance on a Button: a whole second copy, a swapped onto it with its layers; b stays.
    app.engine.setSelection([a]);
    expect(await updateSelectedInstances(app.ed, ups.find((u) => u.copy.name === "Button")!)).toBe(1);
    const buttons = app.ed.libraries.copies().filter((c) => c.name === "Button");
    expect(buttons).toHaveLength(2);
    expect(new Set(buttons.map((c) => layers(c.guid)))).toEqual(new Set([layers(buttons[0].guid)])); // same layers in both copies
    expect(layers(a)).toBe(bLayers);
    expect((read(app.ed, a).fillPaints as { color: { r: number } }[])[0].color.r).toBe(1);
    expect((read(app.ed, b).fillPaints as { color: { r: number } }[])[0].color.r).not.toBe(1);
    // …and on a Chip (a set): a second set with every variant, c1 on the variant of the same name.
    const mainName = (id: string) => {
      const m = read(app.ed, id).symbolData as { symbolID: { sessionID: number; localID: number } };
      return read(app.ed, `${m.symbolID.sessionID}:${m.symbolID.localID}`).name;
    };
    const c1Variant = mainName(c1);
    app.engine.setSelection([c1]);
    expect(await updateSelectedInstances(app.ed, app.ed.libraries.updates().find((u) => u.copy.name === "Chip")!)).toBe(1);
    const chips = app.ed.libraries.copies().filter((c) => c.name === "Chip");
    expect(chips).toHaveLength(2);
    expect(chips.map((c) => layers(c.guid))).toEqual([4, 4]);
    expect(mainName(c1)).toBe(c1Variant);
    // Still one update per asset (the instances left on the old copies), one row each.
    await app.ed.libraries.refresh();
    expect(app.ed.libraries.updates().map((u) => [u.copy.name, u.copies.length]).sort()).toEqual([["Button", 1], ["Chip", 1]]);
    expect(app.ed.libraries.pendingCount()).toBe(2);

    // v3: the Button again — one row for both its copies (no duplicates, distinct ids), the badge counts assets.
    lib.ed.setProps(["1:1"], { fillPaints: GREEN } as never, "Fill");
    const { v: v3 } = await publishAll(lib.ed);
    await app.ed.libraries.refresh();
    const ups3 = app.ed.libraries.updates();
    expect(ups3.map((u) => [u.copy.name, u.copies.length]).sort()).toEqual([["Button", 2], ["Chip", 1]]);
    expect(new Set(ups3.map(updateId)).size).toBe(ups3.length);
    expect(app.ed.libraries.pendingCount()).toBe(2);
    const versionsBefore = new Map(app.ed.libraries.copies().map((c) => [c.guid, c.version]));
    // Update all: every copy of every asset at the latest version, one undo step.
    expect(await acceptUpdates(app.ed, ups3)).toBe(2);
    const latest = (name: string) => v3.assets.find((x) => x.name === name)!.versionHash;
    expect(app.ed.libraries.copies().filter((c) => c.name === "Button").map((c) => c.version)).toEqual([latest("Button"), latest("Button")]);
    expect(app.ed.libraries.copies().filter((c) => c.name === "Chip").map((c) => c.version)).toEqual([latest("Chip"), latest("Chip")]);
    for (const id of [a, b]) expect((read(app.ed, id).fillPaints as { color: { g: number } }[])[0].color.g).toBe(1);
    expect(read(app.ed, c2).childIds?.length ?? 0).toBe(read(app.ed, c1).childIds?.length ?? 0);
    await app.ed.libraries.refresh();
    expect(app.ed.libraries.pendingCount()).toBe(0);
    expect(app.engine.undo()).toBe(true);
    expect(new Map(app.ed.libraries.copies().map((c) => [c.guid, c.version]))).toEqual(versionsBefore);
  });

  it("what a published asset uses goes with it: a deselected new or modified dependency ships at the version inside it (findings 7, 17)", async () => {
    const w = await workspace();
    const libKey = await w.file("Kit", COMPONENTS_DOCUMENT);
    const lib = await w.open(libKey);
    let d = await draftPublish(lib.ed);
    const star = d.items.find((i) => i.asset.name === "Icons/Star")!;
    const button = d.items.find((i) => i.asset.name === "Button")!;
    // The Star is deselected; the Button, which nests it, is published: the Star goes with it ("Used by Button").
    const selected = new Set(d.items.filter((i) => i.key !== star.key).map((i) => i.key));
    const plan = publishPlan(d, selected);
    expect(plan.chosen.has(star.key)).toBe(true);
    expect(plan.usedBy.get(star.key)).toEqual(["Button"]);
    const v1 = await publishLibrary(lib.ed, d, { description: "", selected, moveModes: new Map() });
    expect(v1.assets.find((a) => a.key === star.key)).toMatchObject({ versionHash: star.versionHash, dependencyOnly: false });
    expect(read(lib.ed, star.asset.guid).publishedVersion).toBe(star.versionHash);
    // A consumer inserting the Button gets the Star with it and no phantom "Removed".
    const app = await w.open(await w.file("App", EMPTY));
    await setLibraryEnabled(app.ed, libKey, true);
    await insertLibraryComponent(app.ed, libKey, app.ed.libraries.get().manifests.get(libKey)!.assets.find((a) => a.key === button.key)!);
    await app.ed.libraries.refresh();
    expect(app.ed.libraries.copies().map((c) => c.name).sort()).toEqual(["Button", "Icons/Star"]);
    expect(app.ed.libraries.updates()).toEqual([]);

    // Both change; only the Button is selected: the Star goes out at its new version (the one inside the Button).
    lib.ed.setProps([star.asset.guid], { size: { x: 24, y: 24 } } as never, "Resize");
    lib.ed.setProps([button.asset.guid], { fillPaints: RED } as never, "Fill");
    d = await draftPublish(lib.ed);
    const star2 = d.items.find((i) => i.key === star.key)!;
    expect(star2.status).toBe("modified");
    const v2 = await publishLibrary(lib.ed, d, { description: "", selected: new Set([button.key]), moveModes: new Map() });
    expect(v2.assets.find((a) => a.key === star.key)!.versionHash).toBe(star2.versionHash);
    // A fresh consumer has nothing to update; the first one updates both, the Star forward (never back).
    const fresh = await w.open(await w.file("App 2", EMPTY));
    await setLibraryEnabled(fresh.ed, libKey, true);
    await insertLibraryComponent(fresh.ed, libKey, v2.assets.find((a) => a.key === button.key)!);
    await fresh.ed.libraries.refresh();
    expect(fresh.ed.libraries.updates()).toEqual([]);
    await app.ed.libraries.refresh();
    expect(app.ed.libraries.updates().map((u) => u.copy.name).sort()).toEqual(["Button", "Icons/Star"]);
    await acceptUpdates(app.ed, app.ed.libraries.updates());
    const starCopy = app.ed.libraries.copies().find((c) => c.name === "Icons/Star")!;
    expect((read(app.ed, starCopy.guid).size as { x: number }).x).toBe(24);
    expect(starCopy.version).toBe(star2.versionHash);
  });

  it("a hidden component a published one still uses: Removed ships it unlisted, deselected keeps it listed — never twice (findings 8, 16)", async () => {
    const w = await workspace();
    const libKey = await w.file("Kit", COMPONENTS_DOCUMENT);
    const lib = await w.open(libKey);
    const { d: d1 } = await publishAll(lib.ed);
    const star = d1.items.find((i) => i.asset.name === "Icons/Star")!;
    const app = await w.open(await w.file("App", EMPTY));
    await setLibraryEnabled(app.ed, libKey, true);
    await insertLibraryComponent(app.ed, libKey, app.ed.libraries.get().manifests.get(libKey)!.assets.find((a) => a.name === "Icons/Star")!);
    // The Star is hidden (the Button nests it); the Chip changes too.
    setHiddenWhenPublishing(lib.ed, star.asset.guid, true);
    lib.ed.setProps(["1:41"], { fillPaints: RED } as never, "Fill");
    let d = await draftPublish(lib.ed);
    expect(d.removed.map((r) => r.name)).toEqual(["Icons/Star"]);
    expect(d.items.find((i) => i.key === star.key)!.status).toBe("dependency");
    expect(publishPlan(d, new Set()).usedBy.get(star.key)).toEqual(["Button"]); // the dialog: "Used by Button"
    // Its Removed row deselected (keep it published) with another change selected: it stays listed, once.
    const chip = d.items.find((i) => i.asset.name === "Chip")!;
    const v2 = await publishLibrary(lib.ed, d, { description: "", selected: new Set([chip.key]), moveModes: new Map() });
    expect(v2.assets.filter((a) => a.key === star.key)).toMatchObject([{ dependencyOnly: false }]);
    expect(v2.changes.removed).toEqual([]);
    // Selected: removed from the library's list, still shipped for the Button (unlisted) — consumers keep its updates.
    d = await draftPublish(lib.ed);
    const v3 = await publishLibrary(lib.ed, d, { description: "", selected: new Set(d.removed.map((r) => r.key)), moveModes: new Map() });
    expect(v3.assets.filter((a) => a.key === star.key)).toMatchObject([{ dependencyOnly: true }]);
    expect(v3.changes.removed).toEqual([star.key]);
    expect(read(lib.ed, star.asset.guid).publishedVersion).toBe(star.versionHash); // still published (as a dependency)
    await app.ed.libraries.refresh();
    expect(app.ed.libraries.updates().filter((u) => u.key === star.key)).toEqual([]);
  });

  it("a removed asset is no longer published in the library file; Move to this file reaches the old library's consumers (findings 14, 15)", async () => {
    const w = await workspace();
    const oldKey = await w.file("Old kit", COMPONENTS_DOCUMENT);
    const newKey = await w.file("New kit", EMPTY);
    const old = await w.open(oldKey);
    const { d } = await publishAll(old.ed);
    const heart = d.items.find((i) => i.asset.name === "Icons/Heart")!;
    const app = await w.open(await w.file("App", EMPTY));
    await setLibraryEnabled(app.ed, oldKey, true);
    await insertLibraryComponent(app.ed, oldKey, app.ed.libraries.get().manifests.get(oldKey)!.assets.find((a) => a.key === heart.key)!);
    // ⌘X in the old kit (the engine's DELETE after the copy), ⌘V in the new one, which publishes with Move to this file.
    old.engine.setSelection([heart.asset.guid]);
    const cut = old.engine.encodeSelection({ cut: true })!;
    old.engine.command("DELETE");
    expect(old.engine.readNode(heart.asset.guid)).toBeNull();
    const next = await w.open(newKey);
    next.engine.paste(cut);
    await publishAll(next.ed);
    // The old kit's consumers see the move right away…
    await app.ed.libraries.refresh();
    expect(app.ed.libraries.updates().map((u) => [u.copy.name, u.kind])).toEqual([["Icons/Heart", "moved"]]);
    // …and the old kit's Publish shows it moved out, not removed; with every other change deselected (the Button's
    // Icon property lists the Heart, so it changed too), the move alone still publishes.
    const od = await draftPublish(old.ed);
    expect(od.removed).toEqual([]);
    expect(od.movedOut.map((m) => [m.name, m.toName])).toEqual([["Icons/Heart", "New kit"]]);
    expect(hasPublishChanges({ ...od, items: od.items.map((i) => ({ ...i, status: "unchanged" as const })) })).toBe(true);
    const v2 = await publishLibrary(old.ed, od, { description: "", selected: new Set(), moveModes: new Map() });
    expect(v2.changes.moved.map((m) => m.fromKey)).toEqual([heart.key]);
    expect(v2.changes.modified).toEqual([]);
    expect(v2.assets.some((a) => a.key === heart.key)).toBe(false);
    // A component hidden and published as removed is no longer published here (a paste elsewhere copies it in).
    const chip = d.items.find((i) => i.asset.name === "Chip")!;
    setHiddenWhenPublishing(old.ed, chip.asset.guid, true);
    await publishAll(old.ed);
    expect(read(old.ed, chip.asset.guid).publishedVersion).toBeUndefined();
  });

  it("library bookkeeping is never an undo step: Add to file, Remove from file, publishing a move (findings 13, 19)", async () => {
    const w = await workspace();
    const oldKey = await w.file("Old kit", COMPONENTS_DOCUMENT);
    const newKey = await w.file("New kit", EMPTY);
    const old = await w.open(oldKey);
    const { d } = await publishAll(old.ed);
    const app = await w.open(await w.file("App", EMPTY));
    await setLibraryEnabled(app.ed, oldKey, true);
    expect((app.engine.readNode("0:0") as unknown as Any).librarySubscriptions).toEqual([{ libraryKey: oldKey, name: "Old kit" }]);
    expect(app.ed.store.undo.canUndo).toBe(false);
    app.engine.undo(); // nothing to undo: the document's list stays with the store's
    expect((app.engine.readNode("0:0") as unknown as Any).librarySubscriptions).toEqual([{ libraryKey: oldKey, name: "Old kit" }]);
    await setLibraryEnabled(app.ed, oldKey, false);
    expect(app.ed.store.undo.canUndo).toBe(false);
    expect((app.engine.readNode("0:0") as unknown as Any).librarySubscriptions ?? []).toEqual([]);
    // Journaled all the same: the reopened file has the list the store has.
    await setLibraryEnabled(app.ed, oldKey, true);
    await app.source.flush();
    await app.source.close();
    const again = await w.open(app.source.fileKey);
    expect((again.engine.readNode("0:0") as unknown as Any).librarySubscriptions).toEqual([{ libraryKey: oldKey, name: "Old kit" }]);

    // Publishing a moved component: the move is recorded, and ⌘Z after it undoes the paste, not the bookkeeping.
    const heart = d.items.find((i) => i.asset.name === "Icons/Heart")!;
    old.engine.setSelection([heart.asset.guid]);
    const cut = old.engine.encodeSelection({ cut: true })!;
    const next = await w.open(newKey);
    next.engine.paste(cut);
    const pasted = next.ed.selection[0];
    expect(next.ed.store.undo.undoLabel).toBe("Paste");
    await publishAll(next.ed);
    expect(read(next.ed, pasted).libraryMoveInfo).toBeUndefined();
    expect(next.ed.store.undo.undoLabel).toBe("Paste");
    expect((await draftPublish(next.ed)).moves).toEqual([]);
    next.engine.undo();
    expect(next.engine.readNode(pasted)).toBeNull();
    expect((await w.api.libraries.getRecord(newKey))!.movedIn).toHaveLength(1);
  });

  it("Update all over two libraries and a moved asset is one undo step (finding 20)", async () => {
    const w = await workspace();
    const aKey = await w.file("Lib A", COMPONENTS_DOCUMENT);
    const bKey = await w.file("Lib B", COMPONENTS_DOCUMENT);
    const cKey = await w.file("Lib C", EMPTY);
    const A = await w.open(aKey);
    const B = await w.open(bKey);
    const { d } = await publishAll(A.ed);
    await publishAll(B.ed);
    const app = await w.open(await w.file("App", EMPTY));
    await setLibraryEnabled(app.ed, aKey, true);
    await setLibraryEnabled(app.ed, bKey, true);
    const remote = (lib: string, name: string) => app.ed.libraries.get().manifests.get(lib)!.assets.find((a) => a.name === name)!;
    await insertLibraryComponent(app.ed, aKey, remote(aKey, "Button"));
    await insertLibraryComponent(app.ed, bKey, remote(bKey, "Button"));
    await insertLibraryComponent(app.ed, aKey, remote(aKey, "Icons/Heart"));
    // Both Buttons change; A's Heart moves to C.
    A.ed.setProps(["1:1"], { fillPaints: RED } as never, "Fill");
    B.ed.setProps(["1:1"], { fillPaints: RED } as never, "Fill");
    await publishAll(A.ed);
    await publishAll(B.ed);
    const heart = d.items.find((i) => i.asset.name === "Icons/Heart")!;
    A.engine.setSelection([heart.asset.guid]);
    const cut = A.engine.encodeSelection({ cut: true })!;
    const C = await w.open(cKey);
    C.engine.paste(cut);
    await publishAll(C.ed);
    await app.ed.libraries.refresh();
    const ups = app.ed.libraries.updates();
    expect(ups.map((u) => [u.libraryName, u.copy.name, u.kind]).sort()).toEqual([["Lib A", "Button", "modified"], ["Lib A", "Icons/Heart", "moved"], ["Lib B", "Button", "modified"]]);
    const before = app.ed.libraries.copies().map((c) => [c.guid, c.library, c.version]).sort();
    expect(await acceptUpdates(app.ed, ups)).toBe(3);
    await app.ed.libraries.refresh();
    expect(app.ed.libraries.pendingCount()).toBe(0);
    expect(app.ed.libraries.get().enabled).toContain(cKey);
    expect(app.ed.store.undo.undoLabel).toBe("Update library assets");
    expect(app.engine.undo()).toBe(true);
    expect(app.ed.libraries.copies().map((c) => [c.guid, c.library, c.version]).sort()).toEqual(before);
    expect(app.ed.store.undo.canUndo).toBe(true); // the instances' insert, not another part of the update
    expect(app.ed.store.undo.undoLabel).not.toBe("Update library assets");
  });

  it("Assets' Go to main component shows the component: its page, selected, zoomed into view (finding 12)", async () => {
    const w = await workspace();
    const kit = await w.open(await w.file("Kit", COMPONENTS_DOCUMENT));
    for (const [id, page] of [["1:20", "0:3"], ["1:40", "0:3"]] as const) {
      kit.engine.setCurrentPage("0:1");
      kit.engine.setSelection([]);
      kit.engine.setCamera({ x: 50000, y: 50000, zoom: 1 });
      expect(goToComponent(kit.ed, id)).toBe(true);
      expect(kit.ed.store.page).toBe(page);
      expect(kit.ed.selection).toEqual([id]);
      expect(kit.engine.getCamera().x).not.toBe(50000);
    }
  });

  it("an image inside a library component: the consumer's file keeps a reference to it (inserted and updated)", async () => {
    const w = await workspace();
    const png = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10, 1, 2, 3, 4]);
    const put = await w.api.blobs.put(png, { mime: "image/png" });
    const hash = put.sha1.match(/../g)!.map((h) => parseInt(h, 16));
    const at = { m00: 1, m01: 0, m02: 0, m10: 0, m11: 1, m12: 0 };
    const libKey = await w.file("Kit", {
      type: "NODE_CHANGES",
      sessionID: 0,
      nodeChanges: [
        ...EMPTY.nodeChanges,
        { guid: "1:1", phase: "CREATED", type: "SYMBOL", name: "Photo", parentIndex: { guid: "0:1", position: "!" }, size: { x: 40, y: 40 }, transform: at } as never,
        { guid: "1:2", phase: "CREATED", type: "ROUNDED_RECTANGLE", name: "Image", parentIndex: { guid: "1:1", position: "!" }, size: { x: 40, y: 40 }, transform: at, fillPaints: [{ type: "IMAGE", image: { hash }, imageScaleMode: "FILL", visible: true, opacity: 1 }] } as never,
      ],
    });
    const lib = await w.open(libKey);
    await publishAll(lib.ed);
    const appKey = await w.file("App", EMPTY);
    const app = await w.open(appKey);
    await setLibraryEnabled(app.ed, libKey, true);
    expect(await insertLibraryComponent(app.ed, libKey, app.ed.libraries.get().manifests.get(libKey)!.assets[0])).toBeTruthy();
    await app.source.flush();
    expect(w.store.fileData(appKey).blobRefs).toContain(put.sha1);
  });

  it("the desktop store too: the consumer's file keeps a reference to a library image; libraries over LocalLibraries", async () => {
    const bed = await rpcTestbed();
    try {
      const api = await bed.connect("editor");
      const team = await api.workspace.createFolder({ name: "Team", parentId: null });
      const png = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10, 5, 6, 7, 8]);
      const put = await api.blobs.put(png, { mime: "image/png" });
      const open = async (fileKey: string) => {
        const source = await openStoreDocument(api, fileKey, { recordViewed: false });
        const engine = await Engine.create(null, { sessionID: source.sessionID });
        engine.load(await source.load());
        engine.setViewport(1280, 800, 1, 1280, 800);
        const ed = new EditorController(engine, new EngineStore(engine), source);
        engine.onDocumentChanged((_, e) => source.onChanges(e.message, { kind: e.kind, label: e.label }));
        await ed.libraries.refresh();
        return { ed, engine, source };
      };
      const libKey = (await api.workspace.createFile({ name: "Kit", folderId: team.id })).fileKey;
      const lib = await open(libKey);
      const at = { m00: 1, m01: 0, m02: 0, m10: 0, m11: 1, m12: 0 };
      const hash = put.sha1.match(/../g)!.map((h) => parseInt(h, 16));
      lib.engine.applyChanges({
        type: "NODE_CHANGES",
        sessionID: lib.source.sessionID,
        nodeChanges: [
          { guid: `${lib.source.sessionID}:1`, phase: "CREATED", type: "SYMBOL", name: "Photo", parentIndex: { guid: "0:1", position: "!" }, size: { x: 40, y: 40 }, transform: at } as never,
          { guid: `${lib.source.sessionID}:2`, phase: "CREATED", type: "ROUNDED_RECTANGLE", name: "Image", parentIndex: { guid: `${lib.source.sessionID}:1`, position: "!" }, size: { x: 40, y: 40 }, transform: at, fillPaints: [{ type: "IMAGE", image: { hash }, imageScaleMode: "FILL", visible: true, opacity: 1 }] } as never,
        ],
      });
      await publishAll(lib.ed);
      const appKey = (await api.workspace.createFile({ name: "App", folderId: team.id })).fileKey;
      const app = await open(appKey);
      await setLibraryEnabled(app.ed, libKey, true);
      const photo = app.ed.libraries.get().manifests.get(libKey)!.assets.find((a) => a.name === "Photo")!;
      expect(await insertLibraryComponent(app.ed, libKey, photo)).toBeTruthy();
      // The library resizes it; the consumer updates (one step) and still references the image.
      lib.ed.setProps([`${lib.source.sessionID}:1`], { size: { x: 48, y: 48 } } as never, "Resize");
      await publishAll(lib.ed);
      await app.ed.libraries.refresh();
      expect(await acceptUpdates(app.ed, app.ed.libraries.updates())).toBe(1);
      await app.source.flush();
      await bed.t.store.idle();
      expect(await bed.t.store.files.blobRefsOf(appKey)).toContain(put.sha1);
      await lib.source.close();
      await app.source.close();
    } finally {
      await bed.close();
    }
  });
});
