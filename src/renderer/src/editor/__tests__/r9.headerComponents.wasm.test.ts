// Round 9 on the real engine (headless Wasm), the live capture's layers (`&doc=capture`): Frame ▾ › Section, one
// layer's boolean operations, the instance's and the component's More actions as live, Create property, Multi-edit
// variants' matching layers, an instance's dev status.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { beforeAll, describe, expect, it } from "vitest";
import { Engine } from "@/engine/Engine";
import { EngineStore } from "@/engine/EngineStore";
import { loadEngine } from "@/engine/loadEngine";
import type { Message } from "@/engine/codec";
import { EditorController } from "../controller";
import { memoryDocumentSource } from "../documentSource";
import { CAPTURE_DOCUMENT } from "../fixtures";
import { runEditorCommand } from "../commands";
import { statusTargets } from "../devStatus";
import { nestedInstancesOf, readC } from "../components";
import { convertFrameKind, offeredKinds } from "../panels/design/frameKind";
import { componentMoreMenu, createPropertyMenu, instanceMoreMenu, instanceTitle } from "../panels/design/Component";
import { moreActionsMenu } from "../panels/design/Header";
import { matchingInVariants, setMultiEdit } from "../panels/design/multiEdit";
import type { PanelNode } from "../panels/design/shared";

const wasm = fileURLToPath(new URL("../../engine/wasm/engine.wasm", import.meta.url));

beforeAll(async () => {
  const g = globalThis as Record<string, unknown>;
  g.window ??= globalThis;
  g.document ??= { querySelector: () => null };
  const bytes = readFileSync(wasm);
  await loadEngine({ wasmBinary: bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength), printErr: () => {} });
});

async function editor(doc: Message = CAPTURE_DOCUMENT) {
  const source = memoryDocumentSource(doc, { fileName: "Untitled" });
  const engine = await Engine.create(null, { sessionID: 1 });
  engine.load(await source.load());
  const ed = new EditorController(engine, new EngineStore(engine), source);
  return { ed, engine };
}

const ids = (entries: ReturnType<typeof instanceMoreMenu>) => entries.map((e) => (e === "-" ? "-" : "id" in e ? e.id : `[${e.header}]`));
const node = (ed: EditorController, id: string) => ed.withRealType(ed.engine.readNode(id)!) as PanelNode;

describe("round 9 on the engine", () => {
  it("Frame ▾ › Section: the frame becomes a section in its place, its layers kept, one undo step", async () => {
    const { ed, engine } = await editor();
    const frame = node(ed, "7:20");
    expect(offeredKinds(ed, [frame])).toEqual({ Section: true, Frame: true, Group: true });
    // A layer inside a frame can't become a section (sections sit on the page or in a section).
    expect(offeredKinds(ed, [node(ed, "7:2")]).Section).toBe(false);
    expect(convertFrameKind(ed, [frame], "Section")).toBe(true);
    const section = engine.getSelection().refs[0];
    const s = engine.readNode(section)!;
    expect(s.type).toBe("SECTION");
    expect(s.name).toBe("AL_horizontal");
    expect(s.transform).toMatchObject({ m02: 420, m12: 0 });
    expect(s.size).toEqual({ x: 232, y: 72 });
    expect(engine.readNode("7:21")!.parentIndex?.guid).toBe(section);
    expect(engine.readNode("7:21")!.transform).toMatchObject({ m02: 16, m12: 16 });
    expect(engine.readNode("7:20")).toBeNull();
    engine.undo();
    expect(engine.readNode("7:20")!.type).toBe("FRAME");
    expect(engine.readNode("7:21")!.parentIndex?.guid).toBe("7:20");
    expect(engine.readNode(section)).toBeNull();
    // Frame → Group and back stay field changes.
    expect(convertFrameKind(ed, [frame], "Group")).toBe(true);
    expect(engine.readNode("7:20")!.resizeToFit).toBe(true);
    engine.destroy();
  });

  it("boolean operations run on one layer (live: the rectangle's menu offers them)", async () => {
    const { ed, engine } = await editor();
    engine.setSelection(["7:60"]);
    expect(runEditorCommand(ed, "vector.union")).toBe(true);
    const b = engine.getSelection().refs[0];
    expect(engine.readNode(b)!.type).toBe("BOOLEAN_OPERATION");
    expect(engine.readNode("7:60")!.parentIndex?.guid).toBe(b);
    // A rectangle in a frame: More actions holds Edit object, then the boolean group, Flatten.
    engine.undo();
    engine.setSelection(["7:51"]);
    expect(ids(moreActionsMenu(ed, [node(ed, "7:51")], ["object.create-component", "object.use-as-mask"])).filter((x) => x !== "-")).toEqual(
      expect.arrayContaining(["vector.union", "vector.subtract", "vector.intersect", "vector.exclude", "vector.flatten"])
    );
    engine.destroy();
  });

  it("the instance's More actions as live (instance-more-actions-menu.txt), Reset name for its own name", async () => {
    const { ed, engine } = await editor();
    engine.setSelection(["8:60"]);
    const inst = readC(ed, "8:60")!;
    expect(inst.name).toBe("Button instance");
    expect(instanceTitle(ed, inst)).toBe("Button");
    expect(statusTargets(ed)).toEqual(["8:60"]);
    expect(ids(instanceMoreMenu(ed, inst))).toEqual([
      "-",
      "ready-for-dev",
      "-",
      "object.create-component",
      "object.detach-instance",
      "object.reset-all-changes",
      "reset-name",
      "-",
      "object.use-as-mask",
      "-",
      "vector.union",
      "vector.subtract",
      "vector.intersect",
      "vector.exclude",
      "flatten-instance",
    ]);
    // Every item carries a glyph (the label column at 44).
    expect(instanceMoreMenu(ed, inst).every((e) => e === "-" || !("id" in e) || !!e.icon)).toBe(true);
    // A variant's instance is named after its set.
    expect(instanceTitle(ed, readC(ed, "8:61")!)).toBe("Chip");
    engine.destroy();
  });

  it("the component's Create property menu and More actions", async () => {
    const { ed, engine } = await editor();
    engine.setSelection(["8:1"]);
    const button = readC(ed, "8:1")!;
    const nested = nestedInstancesOf(ed, button);
    expect(nested.map((x) => x.guid)).toEqual(["8:2"]);
    const menu = createPropertyMenu(ed, button, nested);
    expect(ids(menu)).toEqual(["[Create property]", "VARIANT", "TEXT", "BOOL", "INSTANCE_SWAP", "SLOT", "-", "[Expose properties from]", "submenu:nested"]);
    expect(menu.at(-1)).toMatchObject({ label: "Nested instances", disabled: false });
    // (A main component isn't flattened: what can't run is left out.)
    expect(ids(componentMoreMenu(ed)).filter((x) => x !== "-")).toEqual(["ready-for-dev", "object.use-as-mask", "vector.union", "vector.subtract", "vector.intersect", "vector.exclude"]);
    engine.destroy();
  });

  it("Multi-edit variants: a layer in one variant matches the same layer in the others", async () => {
    const doc = structuredClone(CAPTURE_DOCUMENT);
    const label = (guid: string, parent: string) =>
      ({ guid, phase: "CREATED", type: "TEXT", name: "Label", parentIndex: { guid: parent, position: "!" }, size: { x: 30, y: 14 }, transform: { m00: 1, m01: 0, m02: 8, m10: 0, m11: 1, m12: 8 }, textData: { characters: "Chip" }, fontSize: 11 }) as unknown as Message["nodeChanges"][number];
    doc.nodeChanges.push(label("9:1", "8:41"), label("9:2", "8:42"), label("9:3", "8:43"));
    const { ed, engine } = await editor(doc);
    expect(matchingInVariants(ed, "9:1")).toBeNull();
    setMultiEdit("8:40", true);
    expect(matchingInVariants(ed, "9:1")).toEqual(["9:1", "9:2", "9:3"]);
    // The variant itself isn't a layer inside one.
    expect(matchingInVariants(ed, "8:41")).toBeNull();
    setMultiEdit("8:40", false);
    expect(matchingInVariants(ed, "9:2")).toBeNull();
    engine.destroy();
  });
});
