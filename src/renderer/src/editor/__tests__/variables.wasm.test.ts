// Variables, modes and styles on the real engine (headless): `&doc=variables` — the index of collections,
// variables and styles; creating, renaming, valuing, aliasing (no cycles), duplicating, grouping, reordering and
// deleting variables; modes (add, rename, duplicate, default, delete); binding fields and paints with their resolved
// copies; Apply variable mode; styles (create, apply, detach, edit reaching every user, delete). Each check holds
// with the engine's variable commands (when the build has them) and with the editor's fallbacks; each action is
// one undo step.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { beforeAll, describe, expect, it } from "vitest";
import { Engine } from "@/engine/Engine";
import { EngineStore } from "@/engine/EngineStore";
import { loadEngine } from "@/engine/loadEngine";
import type { Paint } from "@/engine/codec";
import { EditorController } from "../controller";
import { memoryDocumentSource } from "../documentSource";
import { EMPTY_DOCUMENT, VARIABLES_DOCUMENT } from "../fixtures";
import { command, runEditorCommand } from "../commands";
import { mainMenu } from "../menus";
import { hasCommand } from "../engineCompat";
import {
  addMode,
  applyStyle,
  bindPaint,
  bindVariable,
  createCollection,
  createStyle,
  createVariable,
  deleteCollection,
  deleteMode,
  deleteStyle,
  deleteVariables,
  duplicateStyle,
  engineResolves,
  duplicateVariables,
  extendCollection,
  isOverridden,
  resetOverride,
  groupVariables,
  modesAt,
  moveVariables,
  renameGroup,
  renameMode,
  renameVariable,
  resolveAt,
  setDefaultMode,
  setExplicitMode,
  setVariableValue,
  updateStyle,
  updateVariable,
} from "../variables";
import { paintVariable, valueIn, variableBindings } from "../model/variables";
import { bindPropertyVariable, instanceInfo, readC } from "../components";
import { styleIdOf } from "../model/styles";
import { colorToHex } from "../model/color";

const wasm = fileURLToPath(new URL("../../engine/wasm/engine.wasm", import.meta.url));

beforeAll(async () => {
  const g = globalThis as Record<string, unknown>;
  g.window ??= globalThis;
  g.document ??= { querySelector: () => null };
  const bytes = readFileSync(wasm);
  await loadEngine({ wasmBinary: bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength), printErr: () => {} });
});

/** "fallback": the engine's variable reads hidden, so the editor's own writes run (as with a build before E6 variables). */
let mode: "engine" | "fallback" = "engine";

async function editor(doc = VARIABLES_DOCUMENT) {
  const source = memoryDocumentSource(doc, { fileName: "Variables" });
  const engine = await Engine.create(null, { sessionID: 1 });
  if (mode === "fallback") Object.defineProperty(engine, "variableCollections", { value: undefined });
  engine.load(await source.load());
  engine.setViewport(1280, 800, 1, 1280, 800);
  const store = new EngineStore(engine);
  const ed = new EditorController(engine, store, source);
  engine.onDocumentChanged((_, e) => source.onChanges(e.message));
  return { ed, engine, source };
}

type Any = Record<string, unknown>;
const read = (ed: EditorController, id: string) => ed.engine.readNode(id) as unknown as Any & { fillPaints?: Paint[] };
const fillHex = (ed: EditorController, id: string) => colorToHex(read(ed, id).fillPaints![0].color!);
const undoSteps = (ed: EditorController) => {
  let n = 0;
  while (ed.store.undo.canUndo && n < 50) {
    ed.engine.undo();
    n++;
  }
  return n;
};

describe.each(["engine", "fallback"] as const)("variables and styles on the engine (wasm, headless): %s", (which) => {
  beforeAll(() => {
    mode = which;
  });

  it("reads the file's collections, variables (by collection and position) and styles", async () => {
    const { ed } = await editor();
    // The engine's variables build is used when it is there; the fallback otherwise.
    expect(engineResolves(ed)).toBe(which === "engine" && hasCommand("BIND_VARIABLE"));
    const a = ed.variables.get();
    expect(a.internal).toBe("0:2");
    expect(a.collections.map((c) => c.name)).toEqual(["Primitives", "Theme"]);
    expect(a.collections[1].modes.map((m) => m.name)).toEqual(["Light", "Dark"]);
    expect(a.variables.filter((v) => v.collection === "7:2").map((v) => v.name)).toEqual(["bg/primary", "bg/brand", "text/primary", "radius/card", "label/cta", "feature/beta"]);
    expect(a.styles.map((s) => `${s.kind}:${s.name}`)).toEqual(expect.arrayContaining(["TEXT:Heading/H1", "FILL:Brand/Primary", "EFFECT:Shadow/Small", "GRID:Grid/8pt"]));
    // Aliases resolve in the consumer's mode: the light card's bg is gray/50, the dark card's gray/900.
    expect(colorToHex(resolveAt(ed, "5:20", "2:1") as never)).toBe("#f5f5f5");
    expect(colorToHex(resolveAt(ed, "5:20", "2:10") as never)).toBe("#1e1e1e");
    expect(resolveAt(ed, "5:23", "2:10")).toBe(16);
    expect(modesAt(ed, "2:10").get("7:2")).toMatchObject({ explicit: true, mode: "5:201" });
    expect(modesAt(ed, "2:11").get("7:2")).toMatchObject({ explicit: false, mode: "5:201", inherited: "5:201" });
  });

  it("creates a collection, a variable of each type, renames into groups, sets values and aliases (never a cycle)", async () => {
    const { ed, source } = await editor(EMPTY_DOCUMENT);
    const before = source.changes.length;
    const c = createCollection(ed)!;
    expect(ed.variables.get().lookup.collection(c)?.name).toBe("Collection");
    expect(ed.variables.get().lookup.collection(c)?.modes.map((m) => m.name)).toEqual(["Mode 1"]);
    const color = createVariable(ed, c, "COLOR")!;
    const num = createVariable(ed, c, "FLOAT")!;
    const num2 = createVariable(ed, c, "FLOAT")!;
    createVariable(ed, c, "STRING");
    createVariable(ed, c, "BOOLEAN");
    expect(ed.variables.get().variables.map((v) => v.name)).toEqual(["Color", "Number", "Number 2", "String", "Boolean"]);
    expect(source.changes.length).toBeGreaterThan(before);
    expect(renameVariable(ed, color, "brand / primary")).toBe(true);
    expect(ed.variables.get().lookup.variable(color)?.name).toBe("brand/primary");
    expect(renameVariable(ed, num, "a.b")).toBe(false);
    const m = ed.variables.get().lookup.collection(c)!.defaultMode;
    setVariableValue(ed, num, m, { kind: "literal", value: 12 });
    setVariableValue(ed, num2, m, { kind: "alias", id: num });
    expect(resolveAt(ed, num2, null)).toBe(12);
    // num → num2 → num would cycle: refused.
    expect(setVariableValue(ed, num, m, { kind: "alias", id: num2 })).toBe(false);
    expect(setVariableValue(ed, num, m, { kind: "alias", id: color })).toBe(false);
    updateVariable(ed, num, { description: "Base unit", scopes: ["GAP"], codeSyntax: [{ platform: "WEB", value: "--unit" }], hidden: true });
    const v = ed.variables.get().lookup.variable(num)!;
    expect(v).toMatchObject({ description: "Base unit", scopes: ["GAP"], hidden: true });
    expect(v.codeSyntax).toEqual([{ platform: "WEB", value: "--unit" }]);
  });

  it("modes: new (values copied), rename, duplicate, set as default, delete", async () => {
    const { ed } = await editor();
    const theme = "7:2";
    const added = addMode(ed, theme)!;
    let c = ed.variables.get().lookup.collection(theme)!;
    expect(c.modes.map((m) => m.name)).toEqual(["Light", "Dark", "Mode 3"]);
    expect(ed.variables.get().lookup.variable("5:22")!.values.get(added)).toEqual({ kind: "literal", value: expect.objectContaining({ r: expect.any(Number) }) });
    renameMode(ed, theme, added, "High contrast");
    const dup = addMode(ed, theme, "5:201")!;
    c = ed.variables.get().lookup.collection(theme)!;
    expect(c.modes.map((m) => m.name)).toEqual(["Light", "Dark", "Dark 2", "High contrast"].map((n) => (n === "Dark 2" ? c.modes[2].name : n)));
    expect(c.modes[2].id).toBe(dup);
    setDefaultMode(ed, theme, "5:201");
    c = ed.variables.get().lookup.collection(theme)!;
    expect(c.modes[0].name).toBe("Dark");
    // The light card (Auto) follows the new default.
    expect(fillHex(ed, "2:1")).toBe("#1e1e1e");
    deleteMode(ed, theme, "5:201");
    c = ed.variables.get().lookup.collection(theme)!;
    expect(c.modes.map((m) => m.name)).not.toContain("Dark");
    expect(ed.variables.get().lookup.variable("5:20")!.values.has("5:201")).toBe(false);
    // The dark card's mode is gone: it falls back to the default (Light).
    expect(fillHex(ed, "2:10")).toBe("#f5f5f5");
  });

  it("binds a field and a paint (the resolved copy written in the same step), detaches keeping the value", async () => {
    const { ed } = await editor();
    ed.batch("noop", () => {});
    bindVariable(ed, ["2:3"], "CORNER_RADIUS", "5:15");
    expect(read(ed, "2:3").cornerRadius).toBe(16);
    expect(variableBindings(read(ed, "2:3") as never).get("CORNER_RADIUS")).toBe("5:15");
    bindPaint(ed, ["2:3"], "fillPaints", 0, "5:21");
    expect(paintVariable(read(ed, "2:3").fillPaints![0])).toBe("5:21");
    expect(fillHex(ed, "2:3")).toBe("#0d99ff");
    // Binding a fill leaves the colour style.
    expect(styleIdOf(read(ed, "2:3") as never, "fill")).toBeNull();
    bindVariable(ed, ["2:3"], "CORNER_RADIUS", null);
    expect(variableBindings(read(ed, "2:3") as never).has("CORNER_RADIUS")).toBe(false);
    expect(read(ed, "2:3").cornerRadius).toBe(16);
    bindPaint(ed, ["2:3"], "fillPaints", 0, null);
    expect(paintVariable(read(ed, "2:3").fillPaints![0])).toBeNull();
    expect(fillHex(ed, "2:3")).toBe("#0d99ff");
    // Each action was one step (plus the no-op batch).
    expect(undoSteps(ed)).toBeGreaterThanOrEqual(4);
    expect(variableBindings(read(ed, "2:3") as never).size).toBe(0);
    expect(read(ed, "2:3").cornerRadius).toBe(8);
  });

  it("a value change reaches every bound layer in its mode, in one undo step", async () => {
    const { ed } = await editor();
    setVariableValue(ed, "5:4", "5:100", { kind: "literal", value: { r: 1, g: 0, b: 0, a: 1 } });
    expect(fillHex(ed, "2:1")).toBe("#ff0000");
    expect(fillHex(ed, "2:10")).toBe("#1e1e1e");
    setVariableValue(ed, "5:22", "5:201", { kind: "literal", value: { r: 0, g: 1, b: 0, a: 1 } });
    expect(fillHex(ed, "2:11")).toBe("#00ff00");
    ed.engine.undo();
    expect(fillHex(ed, "2:11")).toBe("#ffffff");
    ed.engine.undo();
    expect(fillHex(ed, "2:1")).toBe("#f5f5f5");
  });

  it("Apply variable mode: a frame set to Dark, then back to Auto", async () => {
    const { ed } = await editor();
    setExplicitMode(ed, ["2:1"], "7:2", "5:201");
    expect(fillHex(ed, "2:1")).toBe("#1e1e1e");
    expect(fillHex(ed, "2:2")).toBe("#ffffff");
    expect(read(ed, "2:1").cornerRadius).toBe(16);
    setExplicitMode(ed, ["2:1"], "7:2", null);
    expect(fillHex(ed, "2:1")).toBe("#f5f5f5");
    expect(modesAt(ed, "2:1").get("7:2")?.explicit).toBe(false);
    // On the page: every Auto layer follows.
    setExplicitMode(ed, ["0:1"], "7:2", "5:201");
    expect(fillHex(ed, "2:1")).toBe("#1e1e1e");
  });

  it("variables: duplicate, group, rename a group, reorder, delete (a used one is kept soft-deleted)", async () => {
    const { ed } = await editor();
    const [copy] = duplicateVariables(ed, ["5:24"]);
    expect(ed.variables.get().lookup.variable(copy)?.name).toBe("label/cta copy");
    const names = () => ed.variables.get().variables.filter((v) => v.collection === "7:2").map((v) => v.name);
    expect(names().indexOf("label/cta copy")).toBe(names().indexOf("label/cta") + 1);
    const group = groupVariables(ed, ["5:24", copy]);
    expect(group).toBe("label/Group");
    expect(ed.variables.get().lookup.variable("5:24")?.name).toBe("label/Group/cta");
    renameGroup(ed, "7:2", "label", "copy");
    expect(ed.variables.get().lookup.variable("5:24")?.name).toBe("copy/Group/cta");
    moveVariables(ed, ["5:25"], "5:20");
    expect(names()[0]).toBe("feature/beta");
    deleteVariables(ed, [copy, "5:22"]);
    expect(ed.variables.get().lookup.variable(copy)).toBeUndefined();
    expect(ed.engine.readNode(copy)).toBeNull();
    // text/primary is bound on the titles: kept (soft-deleted) so they keep resolving.
    expect(ed.variables.get().lookup.variable("5:22")).toBeUndefined();
    expect((read(ed, "5:22") as Any).isSoftDeleted).toBe(true);
    deleteCollection(ed, "7:1");
    expect(ed.variables.get().collections.map((c) => c.name)).toEqual(["Theme"]);
  });

  it("styles: create from a layer and apply, detach, edit (users follow), duplicate, delete", async () => {
    const { ed } = await editor();
    const s = createStyle(ed, "FILL", "Brand/Danger", "2:3", "fill", ["2:3"])!;
    expect(ed.variables.get().style(s)?.name).toBe("Brand/Danger");
    expect(styleIdOf(read(ed, "2:3") as never, "fill")).toBe(s);
    applyStyle(ed, ["2:12"], "fill", s);
    updateStyle(ed, s, { fillPaints: [{ type: "SOLID", color: { r: 1, g: 0, b: 0, a: 1 }, opacity: 1, visible: true }] });
    expect(fillHex(ed, "2:3")).toBe("#ff0000");
    expect(fillHex(ed, "2:12")).toBe("#ff0000");
    applyStyle(ed, ["2:12"], "fill", null);
    expect(styleIdOf(read(ed, "2:12") as never, "fill")).toBeNull();
    expect(fillHex(ed, "2:12")).toBe("#ff0000");
    const copy = duplicateStyle(ed, "6:2")!;
    expect(ed.variables.get().style(copy)?.name).toBe("Heading/H2 copy");
    applyStyle(ed, ["2:2"], "text", "6:1");
    expect(read(ed, "2:2").fontSize).toBe(32);
    deleteStyle(ed, "6:1");
    expect(ed.variables.get().style("6:1")).toBeUndefined();
    expect(styleIdOf(read(ed, "2:2") as never, "text")).toBeNull();
    expect(read(ed, "2:2").fontSize).toBe(32);
    const text = createStyle(ed, "TEXT", "Caption")!;
    expect(ed.variables.get().style(text)?.node.fontSize).toBe(12);
  });

  it("the menus open Local variables", async () => {
    const { ed } = await editor();
    expect(command("view.local-variables").label).toBe("Local variables");
    runEditorCommand(ed, "view.local-variables");
    expect(ed.ui.get().variablesOpen).toBe(true);
    const view = mainMenu(ed).find((e) => typeof e === "object" && "label" in e && e.label === "View") as { items: { id: string }[] };
    expect(view.items.some((i) => i.id === "view.local-variables")).toBe(true);
  });
});

describe("variables round 5 on the engine (wasm, headless)", () => {
  beforeAll(() => {
    mode = "engine";
  });

  it("Extend collection: inherited variables and modes, an override in blue, Reset change, Apply variable mode", async () => {
    const { ed } = await editor();
    const theme = "7:2";
    const ext = extendCollection(ed, theme)!;
    expect(ext).toBeTruthy();
    let a = ed.variables.get();
    const c = a.lookup.collection(ext)!;
    expect(c.parent).toBe(theme);
    expect(c.parentCollection?.id).toBe(theme);
    expect(c.modes.map((m) => m.name)).toEqual(["Light", "Dark"]);
    const dark = c.modes[1].id;
    // Not overridden: the parent's value; an edit in the extension's Dark overrides only it.
    expect(isOverridden(c, "5:20", dark)).toBe(false);
    expect(setVariableValue(ed, "5:20", dark, { kind: "literal", value: { r: 1, g: 0, b: 0, a: 1 } })).toBe(true);
    a = ed.variables.get();
    const after = a.lookup.collection(ext)!;
    expect(isOverridden(after, "5:20", dark)).toBe(true);
    expect(valueIn(a.lookup.variable("5:20")!, dark, after)).toEqual({ kind: "literal", value: { r: 1, g: 0, b: 0, a: 1 } });
    expect(a.lookup.collection(theme)!.overrides.size).toBe(0);
    // The dark card in the extension's Dark: the override reaches it.
    setExplicitMode(ed, ["2:10"], ext, dark);
    expect(modesAt(ed, "2:10").get(ext)).toMatchObject({ explicit: true, mode: dark });
    expect(fillHex(ed, "2:10")).toBe("#ff0000");
    // The engine's read: the variable lists the extension's modes and which it overrides.
    const info = ed.engine.variable("5:20")!;
    expect(info.overriddenModes).toEqual([dark]);
    expect(ed.engine.variableCollections().find((x) => x.id === ext)).toMatchObject({ isExtension: true, parentCollectionId: theme, rootCollectionId: theme });
    expect(resetOverride(ed, ext, "5:20", dark)).toBe(true);
    expect(fillHex(ed, "2:10")).toBe("#1e1e1e");
  });

  it("Assign variable: a string variable picks an instance's variant per mode; a default bound to a boolean", async () => {
    const { ed } = await editor(EMPTY_DOCUMENT);
    // A set with Size = S | L and an instance of S inside a frame.
    ed.engine.applyChanges(
      {
        type: "NODE_CHANGES",
        nodeChanges: [
          { guid: "9:1", phase: "CREATED", type: "FRAME", name: "Size", parentIndex: { guid: "0:1", position: "a" }, size: { x: 200, y: 100 }, isStateGroup: true,
            componentPropDefs: [{ id: { sessionID: 9, localID: 9 }, name: "Size", type: "VARIANT", initialValue: { textValue: { characters: "S" } } }] },
          { guid: "9:2", phase: "CREATED", type: "SYMBOL", name: "Size=S", parentIndex: { guid: "9:1", position: "a" }, size: { x: 20, y: 20 }, variantPropSpecs: [{ propDefId: { sessionID: 9, localID: 9 }, value: "S" }] },
          { guid: "9:3", phase: "CREATED", type: "SYMBOL", name: "Size=L", parentIndex: { guid: "9:1", position: "b" }, size: { x: 40, y: 40 }, transform: { m00: 1, m01: 0, m02: 100, m10: 0, m11: 1, m12: 0 },
            variantPropSpecs: [{ propDefId: { sessionID: 9, localID: 9 }, value: "L" }] },
          { guid: "9:4", phase: "CREATED", type: "FRAME", name: "Screen", parentIndex: { guid: "0:1", position: "b" }, size: { x: 300, y: 300 } },
          { guid: "9:5", phase: "CREATED", type: "INSTANCE", name: "Size", parentIndex: { guid: "9:4", position: "a" }, size: { x: 20, y: 20 }, symbolData: { symbolID: { sessionID: 9, localID: 2 } } },
        ],
      } as never,
      "user"
    );
    const c = createCollection(ed)!;
    const second = addMode(ed, c)!;
    const v = createVariable(ed, c, "STRING")!;
    const first = ed.variables.get().lookup.collection(c)!.defaultMode;
    setVariableValue(ed, v, first, { kind: "literal", value: "S" });
    setVariableValue(ed, v, second, { kind: "literal", value: "L" });
    expect(bindPropertyVariable(ed, "9:5", "Size", v)).toBe(true);
    const row = instanceInfo(ed, readC(ed, "9:5")!).rows[0];
    expect(row.variable).toBe(v);
    setExplicitMode(ed, ["9:4"], c, second);
    expect((read(ed, "9:5").symbolData as { symbolID: unknown }).symbolID).toMatchObject({ sessionID: 9, localID: 3 });
    expect((read(ed, "9:5").size as { x: number }).x).toBe(40);
    setExplicitMode(ed, ["9:4"], c, null);
    expect((read(ed, "9:5").symbolData as { symbolID: unknown }).symbolID).toMatchObject({ sessionID: 9, localID: 2 });
    expect(bindPropertyVariable(ed, "9:5", "Size", null)).toBe(true);
    expect(instanceInfo(ed, readC(ed, "9:5")!).rows[0].variable).toBeNull();
  });
});
