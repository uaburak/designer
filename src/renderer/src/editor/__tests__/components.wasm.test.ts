// Components on the real engine (headless): `&doc=components` — Layers (instance layers, set glyph, purple),
// Assets, the instance panel's rows, property values, a variant switch, a swap, Reset, a main's properties
// (add / rename / delete / bind), Go to main component and back, inserting an instance, the menus. Each check
// holds with the engine's E6 commands (when the build has them) and with the editor's fallbacks.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { beforeAll, describe, expect, it } from "vitest";
import type { MenuEntry, MenuItem } from "@/ds";
import { Engine } from "@/engine/Engine";
import { EngineStore } from "@/engine/EngineStore";
import { loadEngine } from "@/engine/loadEngine";
import { EditorController } from "../controller";
import { memoryDocumentSource } from "../documentSource";
import { COMPONENTS_DOCUMENT } from "../fixtures";
import { command, isEnabled, runEditorCommand } from "../commands";
import { canvasMenu, mainMenu, runMenuItem } from "../menus";
import { layerIcon } from "../panels/Layers";
import { visibleRows } from "../model/layerTree";
import { hasCommand } from "../engineCompat";
import {
  COMPONENT_COMMAND,
  addProperty,
  bindLayer,
  boundProperty,
  deleteProperty,
  goToMainComponent,
  insertInstance,
  instanceChanges,
  instanceInfo,
  readC,
  resetChanges,
  returnToInstance,
  setPropertyValue,
  setVariant,
  swapInstance,
  updateProperty,
} from "../components";
import { guidStr, type CNode } from "../model/components";

const wasm = fileURLToPath(new URL("../../engine/wasm/engine.wasm", import.meta.url));

beforeAll(async () => {
  const g = globalThis as Record<string, unknown>;
  g.window ??= globalThis;
  g.document ??= { querySelector: () => null };
  const bytes = readFileSync(wasm);
  await loadEngine({ wasmBinary: bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength), printErr: () => {} });
});

async function editor() {
  const source = memoryDocumentSource(COMPONENTS_DOCUMENT, { fileName: "Components" });
  const engine = await Engine.create(null, { sessionID: 1 });
  engine.load(await source.load());
  engine.setViewport(1280, 800, 1, 1280, 800);
  const store = new EngineStore(engine);
  const ed = new EditorController(engine, store, source);
  engine.onDocumentChanged((_, e) => source.onChanges(e.message));
  return { ed, engine, source };
}

const node = (ed: EditorController, id: string) => readC(ed, id) as CNode;
const items = (entries: MenuEntry[]): MenuItem[] => entries.filter((e): e is MenuItem => typeof e === "object" && "id" in e);
const labels = (entries: MenuEntry[]): string[] => items(entries).map((i) => i.label);

describe("components on the engine (wasm, headless)", () => {
  it("Layers: an instance's layers below it, a set's glyph, component purple", async () => {
    const { ed } = await editor();
    const tree = ed.getTree();
    const rows = visibleRows(tree, new Set(["2:1", "2:2", "I2:2;1:2"]));
    expect(rows.map((r) => r.id)).toEqual(expect.arrayContaining(["2:2", "I2:2;1:3", "I2:2;1:2", "I2:2;1:2;1:22"]));
    expect(tree.nodes.get("I2:2;1:3")?.derived).toBe(true);
    expect(layerIcon(tree.nodes.get("2:2")!)).toBe("16.instance");
    ed.engine.setCurrentPage("0:3");
    const page = ed.getTree();
    expect(layerIcon(page.nodes.get("1:40")!)).toBe("16.component.set");
    expect(layerIcon(page.nodes.get("1:1")!)).toBe("16.component");
  });

  it("Assets: the file's components and sets, by page and frame", async () => {
    const { ed } = await editor();
    const assets = ed.components.assets();
    expect(assets.map((a) => `${a.name}:${a.kind}:${a.frameName ?? "-"}`).sort()).toEqual(["Button:component:-", "Chip:set:-", "Icons/Heart:component:Icons", "Icons/Star:component:Icons"]);
    expect(assets.find((a) => a.kind === "set")?.target).toBe("1:41"); // the top-left variant
  });

  it("the instance panel: Boolean, Text, Instance swap with the instance's values; the exposed nested instance", async () => {
    const { ed } = await editor();
    const info = instanceInfo(ed, node(ed, "2:2"));
    expect(info.main?.guid).toBe("1:1");
    expect(info.rows.map((r) => [r.def.name, r.def.type])).toEqual([
      ["Show icon", "BOOL"],
      ["Label", "TEXT"],
      ["Icon", "INSTANCE_SWAP"],
    ]);
    expect(info.rows[1].value?.textValue?.characters).toBe("Sign in");
    expect(info.nested.map((n) => n.name)).toEqual(["Icons/Star"]);
    expect(info.nested[0].info.rows.map((r) => r.def.name)).toEqual(["Filled"]);
    const chip = instanceInfo(ed, node(ed, "2:3"));
    expect(chip.rows.map((r) => [r.def.name, r.variantValue, r.options])).toEqual([
      ["State", "Default", ["Default", "Hover"]],
      ["Size", "Small", ["Small", "Large"]],
    ]);
  });

  it("a property value is one undo step; a variant pick switches the variant; a swap", async () => {
    const { ed, engine } = await editor();
    const label = instanceInfo(ed, node(ed, "2:2")).rows[1].def;
    setPropertyValue(ed, node(ed, "2:2"), label, { textValue: { characters: "Log in" } });
    expect(instanceInfo(ed, node(ed, "2:2")).rows[1].value?.textValue?.characters).toBe("Log in");
    engine.undo();
    expect(instanceInfo(ed, node(ed, "2:2")).rows[1].value?.textValue?.characters).toBe("Sign in");

    expect(setVariant(ed, node(ed, "2:3"), "Size", "Large")).toBe(true);
    expect(guidStr(node(ed, "2:3").symbolData?.symbolID)).toBe("1:43");
    expect(instanceInfo(ed, node(ed, "2:3")).rows.map((r) => r.variantValue)).toEqual(["Default", "Large"]);

    swapInstance(ed, ["2:3"], "1:20");
    expect(guidStr(node(ed, "2:3").symbolData?.symbolID)).toBe("1:20");
  });

  it("Reset ▸ lists the changes; Reset all changes clears them in one step", async () => {
    const { ed, engine } = await editor();
    expect(instanceChanges(ed, node(ed, "2:2")).map((g) => g.label)).toEqual(expect.arrayContaining(["Fill", "Text style", "Properties"]));
    engine.setSelection(["2:2"]);
    const reset = items(mainMenu(ed)).find((i) => i.label === "Object")!.items!;
    expect(labels(reset)).toEqual(expect.arrayContaining(["Create component", "Detach instance", "Main component"]));
    expect(runMenuItem(ed, "reset-changes:fillPaints")).toBe(true);
    expect(instanceChanges(ed, node(ed, "2:2")).map((g) => g.label)).not.toContain("Fill");
    resetChanges(ed, node(ed, "2:2"), null);
    expect(instanceChanges(ed, node(ed, "2:2"))).toEqual([]);
    engine.undo();
    expect(instanceChanges(ed, node(ed, "2:2")).length).toBeGreaterThan(0);
  });

  it("a main's properties: add (bound), rename a variant property, delete, bind and detach", async () => {
    const { ed } = await editor();
    const made = addProperty(ed, node(ed, "1:1"), "BOOL", { name: "Show label", value: { boolValue: true }, bind: { layer: node(ed, "1:3"), field: "VISIBLE" } });
    expect(made?.name).toBe("Show label");
    expect(node(ed, "1:1").componentPropDefs?.map((d) => d.name)).toContain("Show label");
    expect(boundProperty(node(ed, "1:3"), "VISIBLE", node(ed, "1:1").componentPropDefs ?? [])?.name).toBe("Show label");

    const label = node(ed, "1:1").componentPropDefs!.find((d) => d.name === "Label")!;
    bindLayer(ed, node(ed, "1:3"), "TEXT_DATA", null);
    expect(boundProperty(node(ed, "1:3"), "TEXT_DATA", node(ed, "1:1").componentPropDefs ?? [])).toBeNull();
    bindLayer(ed, node(ed, "1:3"), "TEXT_DATA", label);
    expect(boundProperty(node(ed, "1:3"), "TEXT_DATA", node(ed, "1:1").componentPropDefs ?? [])?.name).toBe("Label");
    expect(deleteProperty(ed, node(ed, "1:1"), label)).toBe(true);
    expect(node(ed, "1:1").componentPropDefs?.map((d) => d.name)).not.toContain("Label");
    expect(boundProperty(node(ed, "1:3"), "TEXT_DATA", node(ed, "1:1").componentPropDefs ?? [])).toBeNull();

    const state = node(ed, "1:40").componentPropDefs!.find((d) => d.name === "State")!;
    updateProperty(ed, node(ed, "1:40"), state, { name: "Status" }, "Rename property");
    expect(node(ed, "1:41").name).toBe("Status=Default, Size=Small");
    expect(node(ed, "1:40").componentPropDefs?.map((d) => d.name)).toEqual(["Status", "Size"]);
  });

  it("Go to main component (⌃⌥⌘K) and Return to instance", async () => {
    const { ed } = await editor();
    ed.engine.setSelection(["2:2"]);
    expect(isEnabled(ed, command("object.go-to-main-component"))).toBe(true);
    expect(goToMainComponent(ed)).toBe(true);
    expect(ed.store.page).toBe("0:3");
    expect(ed.selection).toEqual(["1:1"]);
    expect(ed.ui.get().returnToInstance?.instance).toBe("2:2");
    returnToInstance(ed);
    expect(ed.store.page).toBe("0:1");
    expect(ed.selection).toEqual(["2:2"]);
    expect(ed.ui.get().returnToInstance).toBeNull();
  });

  it("inserting an instance from Assets: one step, selected, linked to the main", async () => {
    const { ed, engine, source } = await editor();
    const before = source.changes.length;
    const made = insertInstance(ed, "1:1");
    expect(made).toBeTruthy();
    const n = node(ed, made!);
    expect(n.type).toBe("INSTANCE");
    expect(guidStr(n.symbolData?.symbolID)).toBe("1:1");
    expect(source.changes.length).toBe(before + 1);
    engine.undo();
    expect(readC(ed, made!)).toBeNull();
  });

  it("menus and commands: the canvas menu's component items; structural ones follow the engine", async () => {
    const { ed } = await editor();
    ed.engine.setSelection(["2:2"]);
    expect(labels(canvasMenu(ed, []))).toEqual(expect.arrayContaining(["Go to main component", "Push changes to main component", "Reset", "Detach instance"]));
    ed.engine.setCurrentPage("0:3");
    ed.engine.setSelection(["1:20", "1:21"]);
    expect(labels(canvasMenu(ed, []))).toContain("Combine as variants");
    for (const [id, name] of [
      ["object.create-component", COMPONENT_COMMAND.create],
      ["object.detach-instance", COMPONENT_COMMAND.detach],
      ["object.combine-as-variants", COMPONENT_COMMAND.combine],
    ] as const) {
      if (!hasCommand(name)) expect(isEnabled(ed, command(id))).toBe(false);
    }
    // Without its command a structural action doesn't run (never an error).
    if (!hasCommand(COMPONENT_COMMAND.combine)) expect(runEditorCommand(ed, "object.combine-as-variants")).toBe(false);
  });
});
