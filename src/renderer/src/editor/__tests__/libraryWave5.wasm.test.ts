// Libraries, atlas 12 wave 5, on the real engine (headless) and the dev store's registry: the Updates tab grouped by
// the publishes the updates come from (newest first, each with its description), Update all in Figma's order with
// its progress, the current page's updates and an update's instances, Update instance; Swap library (names matched
// ignoring whitespace, the copies replaced in place by the target's assets, the target added, one undo step).
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
import { COMPONENTS_DOCUMENT } from "../fixtures";
import { acceptUpdates, draftPublish, insertLibraryComponent, instancesOfUpdate, publishLibrary, setLibraryEnabled, swapLibrary, swapMatch, swapPlan, updateGroups, updateInstances } from "../libraries";

const wasm = fileURLToPath(new URL("../../engine/wasm/engine.wasm", import.meta.url));

beforeAll(async () => {
  const g = globalThis as Record<string, unknown>;
  g.window ??= globalThis;
  g.document ??= { querySelector: () => null };
  const bytes = readFileSync(wasm);
  await loadEngine({ wasmBinary: bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength), printErr: () => {} });
});

async function workspace() {
  const store = await MemoryStore.open({ storage: memoryStorage() });
  const api = store.api({});
  const team = await api.workspace.createFolder({ name: "Team", parentId: null });
  const file = async (name: string, doc: Message) => (await store.addFile({ name, folderId: team.id, snapshot: encodeMessage(messageToKiwi(doc)) })).fileKey;
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
  return { file, open };
}

/** A file with a page and nothing else. */
const EMPTY: Message = { type: "NODE_CHANGES", sessionID: 0, nodeChanges: COMPONENTS_DOCUMENT.nodeChanges.filter((n) => n.type === "DOCUMENT" || n.guid === "0:1") };
const fill = (r: number, g: number, b: number) => ({ fillPaints: [{ type: "SOLID", color: { r, g, b, a: 1 }, opacity: 1, visible: true, blendMode: "NORMAL" }] }) as never;

async function publishAll(ed: EditorController, description = "") {
  const d = await draftPublish(ed);
  return publishLibrary(ed, d, { description, selected: new Set([...d.items.map((i) => i.key), ...d.removed.map((r) => r.key)]), moveModes: new Map() });
}

const mainOf = (ed: EditorController, id: string) => (ed.engine.readNode(id) as { symbolData?: { symbolID?: { sessionID: number; localID: number } } } | null)?.symbolData?.symbolID;

describe("libraries, atlas 12 wave 5", () => {
  it("groups updates by publish, newest first; Update all in Figma's order with its progress; the page's updates; Update instance", async () => {
    const w = await workspace();
    const libKey = await w.file("Design System", COMPONENTS_DOCUMENT);
    const lib = await w.open(libKey);
    await publishAll(lib.ed, "First release");
    const app = await w.open(await w.file("App", EMPTY));
    await setLibraryEnabled(app.ed, libKey, true);
    const remote = (name: string) => app.ed.libraries.get().manifests.get(libKey)!.assets.find((a) => a.name === name)!;
    const b1 = (await insertLibraryComponent(app.ed, libKey, remote("Button")))!;
    const b2 = (await insertLibraryComponent(app.ed, libKey, remote("Button")))!;
    await insertLibraryComponent(app.ed, libKey, remote("Chip"));
    // v2 changes the Button, v3 the Chip.
    const local = (name: string) => lib.ed.engine.localAssets().find((a) => a.name === name)!.id;
    lib.ed.setProps([local("Button")], fill(1, 0, 0), "Fill");
    await publishAll(lib.ed, "Red button");
    lib.ed.setProps([local("Chip")], fill(0, 1, 0), "Fill");
    await publishAll(lib.ed, "Green chip");
    await app.ed.libraries.refresh();
    const groups = updateGroups(app.ed.libraries.updates());
    expect(groups.map((g) => [g.publish?.version, g.publish?.description, g.items.map((u) => u.copy.name)])).toEqual([
      [3, "Green chip", ["Chip"]],
      [2, "Red button", ["Button"]],
    ]);
    // The Button's instances, one at a time: Update instance moves only that one.
    const button = app.ed.libraries.updates().find((u) => u.copy.name === "Button")!;
    expect(instancesOfUpdate(app.ed, button, "current").map((i) => i.id).sort()).toEqual([b1, b2].sort());
    expect(app.ed.libraries.updatesIn("current").map((u) => u.copy.name).sort()).toEqual(["Button", "Chip"]);
    expect(await updateInstances(app.ed, button, [b1])).toBe(1);
    expect(mainOf(app.ed, b1)).not.toEqual(mainOf(app.ed, b2));
    await app.ed.libraries.refresh();
    expect(app.ed.libraries.pendingCount()).toBe(2); // the other Button instance still waits, and the Chip
    // Update all: components first, the payloads five at a time with the progress.
    const progress: string[] = [];
    expect(await acceptUpdates(app.ed, app.ed.libraries.updates(), (done, total) => progress.push(`${done}/${total}`))).toBe(2);
    expect(progress).toEqual(["0/2", "2/2"]);
    expect(app.ed.store.undo.undoLabel).toBe("Update library assets");
    await app.ed.libraries.refresh();
    expect(app.ed.libraries.pendingCount()).toBe(0);
  });

  it("swaps a library: names matched ignoring whitespace, the copies become the target's, the target added; one undo step", async () => {
    expect(swapMatch({ kind: "COMPONENT", name: "Icons / Heart" }, [{ kind: "COMPONENT_SET", name: "Icons/Heart", dependencyOnly: false } as never])).toMatchObject({ kind: "COMPONENT_SET" });
    expect(swapMatch({ kind: "STYLE", name: "Brand", styleType: "FILL" }, [{ kind: "STYLE", name: "Brand", styleType: "TEXT", dependencyOnly: false } as never])).toBeNull();
    expect(swapMatch({ kind: "COMPONENT", name: "button" }, [{ kind: "COMPONENT", name: "Button", dependencyOnly: false } as never])).toBeNull(); // case kept
    const w = await workspace();
    const aKey = await w.file("Kit A", COMPONENTS_DOCUMENT);
    const bKey = await w.file("Kit B", COMPONENTS_DOCUMENT);
    const A = await w.open(aKey);
    const B = await w.open(bKey);
    await publishAll(A.ed);
    B.ed.setProps([B.ed.engine.localAssets().find((a) => a.name === "Button")!.id], fill(0, 0, 1), "Fill");
    await publishAll(B.ed);
    const app = await w.open(await w.file("App", EMPTY));
    await setLibraryEnabled(app.ed, aKey, true);
    const inst = (await insertLibraryComponent(app.ed, aKey, app.ed.libraries.get().manifests.get(aKey)!.assets.find((a) => a.name === "Button")!))!;
    const before = app.ed.libraries.copies().find((c) => c.name === "Button")!;
    const plan = (await swapPlan(app.ed, aKey, bKey))!;
    expect(plan.rows.map((r) => [r.copy.name, r.match?.name ?? null])).toEqual([["Button", "Button"], ["Icons/Star", "Icons/Star"]]);
    const done = await swapLibrary(app.ed, plan, { keys: new Set(plan.rows.map((r) => r.copy.key)), swapDefaults: true });
    expect(done.assets).toBe(2);
    const after = app.ed.libraries.copies().find((c) => c.name === "Button")!;
    expect(after).toMatchObject({ guid: before.guid, library: bKey }); // replaced in place: the instance stays linked
    expect((app.engine.readNode(inst) as { fillPaints?: { color: { b: number } }[] }).fillPaints?.[0].color.b).toBe(1);
    expect(app.ed.libraries.get().enabled).toContain(bKey);
    expect(app.ed.store.undo.undoLabel).toBe("Swap library");
    app.engine.undo();
    expect(app.ed.libraries.copies().find((c) => c.name === "Button")).toMatchObject({ guid: before.guid, library: aKey });
  });
});
