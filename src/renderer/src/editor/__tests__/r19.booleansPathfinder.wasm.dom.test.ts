// @vitest-environment happy-dom
/**
 * Round 19 on the real engine (headless Wasm): a boolean group's Appearance — one Corner radius (Individual corners
 * there but disabled, as live boolean-radius.txt) and corner smoothing beside it; the boolean split menu with Figma's
 * five, a line and our "Pathfinder ›" (Illustrator's six, Pathfinder options…); Object › Boolean groups and Actions (⌘K)
 * list them; the commands (one undo step, Illustrator's names, the result selected) with the Pathfinder Options; the
 * agents' `pathfinder` tool; Dev Mode's box model shows the boolean's radius.
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { act, createElement } from "react";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { Engine } from "@/engine/Engine";
import { EngineStore } from "@/engine/EngineStore";
import { loadEngine } from "@/engine/loadEngine";
import type { MenuEntry, MenuItem } from "@/ds";
import { $, $$, mount, type Mounted } from "@/ds/__tests__/dom";
import { TOOL_BY_NAME } from "@shared/agents/tools";
import { MENU_LAYOUT } from "@shared/commands";
import { TR } from "@shared/i18n/tr";
import { EditorContext, EditorController } from "../controller";
import { memoryDocumentSource } from "../documentSource";
import { PAINTS_DOCUMENT } from "../fixtures";
import { runEditorCommand, isEnabled, command } from "../commands";
import { actionItems, mainMenu } from "../menus";
import { booleanMenu } from "../panels/design/Header";
import { AppearanceSection } from "../panels/design/Sections";
import type { PanelNode } from "../panels/design/shared";
import { DEFAULT_PATHFINDER, PATHFINDERS, PATHFINDER_OPTIONS_ID, loadPathfinderOptions, pathfinderOptions, setPathfinderOptions } from "../pathfinder";
import { runTool, type ToolEnv } from "../agents/mcpTools";
import { AgentTurns } from "../agents/turns";
import { cornersOf } from "../../../../viewer/inspect/model";

const wasm = resolve(process.cwd(), "src/renderer/src/engine/wasm/engine.wasm");
beforeAll(async () => {
  const bytes = readFileSync(wasm);
  await loadEngine({
    wasmBinary: bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength),
    printErr: () => {},
  });
});

let view: Mounted | null = null;
afterEach(() => {
  view?.unmount();
  view = null;
  localStorage.clear();
});

async function editor() {
  const source = memoryDocumentSource(PAINTS_DOCUMENT, {
    fileName: "Round 19",
  });
  const engine = await Engine.create(null, { sessionID: 1 });
  engine.load(await source.load());
  const ed = new EditorController(engine, new EngineStore(engine), source);
  // "Inner shadow" moved over "Drop shadow" so the two overlap (60 × 40 in common).
  ed.setProps(
    ["2:11"],
    {
      transform: { m00: 1, m01: 0, m02: 60, m10: 0, m11: 1, m12: 240 },
    } as never,
    "Move"
  );
  return { ed, engine };
}
const node = (ed: EditorController, id: string) => ed.withRealType(ed.engine.readNode(id)!) as PanelNode;
const ids = (entries: MenuEntry[]) => entries.map((e) => (e === "-" ? "-" : "id" in e ? e.id : `[${e.header}]`));

describe("round 19a: a boolean group's corner radius in the Design panel", () => {
  it("one radius (Individual corners disabled) and corner smoothing beside it; Dev Mode's box model shows it", async () => {
    const { ed, engine } = await editor();
    ed.setProps(["2:30"], { cornerRadius: 20 } as never, "Corner radius");
    const b = node(ed, "2:30");
    expect(b.cornerRadius).toBe(20);
    view = mount(() => createElement(EditorContext.Provider, { value: ed }, createElement(AppearanceSection, { nodes: [b] })), {});
    const corners = $('button[aria-label="Individual corners"]', view.host) as HTMLButtonElement;
    expect(corners).toBeTruthy();
    expect(corners.disabled).toBe(true);
    expect($('button[aria-label="Corner smoothing"]', view.host)).toBeTruthy();
    expect(($('input[aria-label="Corner radius"]', view.host) as HTMLInputElement).value).toBe("20");
    // No per-corner rows for a boolean, even after a click on the disabled button.
    act(() => corners.click());
    expect($$("[data-corner-row]", view.host).length).toBe(0);
    // Dev Mode's box model: the boolean's own radius on each corner.
    expect(cornersOf(engine.readNode("2:30")!)).toEqual({
      tl: 20,
      tr: 20,
      br: 20,
      bl: 20,
    });
    // Flatten bakes it: a VECTOR with radius 0, one undo step.
    engine.setSelection(["2:30"]);
    expect(runEditorCommand(ed, "vector.flatten")).toBe(true);
    expect(engine.readNode("2:30")!.type).toBe("VECTOR");
    expect(engine.readNode("2:30")!.cornerRadius ?? 0).toBe(0);
  });
});

describe("round 19b: Illustrator's Pathfinders", () => {
  it("the boolean split menu: Figma's five, a line, Pathfinder › the six and Pathfinder options…", async () => {
    const { ed, engine } = await editor();
    engine.setSelection(["2:10", "2:11"]);
    const menu = booleanMenu(ed, false);
    expect(ids(menu)).toEqual(["vector.union", "vector.subtract", "vector.intersect", "vector.exclude", "vector.flatten", "-", "pathfinder"]);
    const sub = menu[6] as MenuItem;
    expect(sub.label).toBe("Pathfinder");
    expect(ids(sub.items!)).toEqual([...PATHFINDERS.map((p) => p.id), "-", PATHFINDER_OPTIONS_ID]);
    const items = sub.items!.filter((e): e is MenuItem => e !== "-" && "id" in e);
    expect(items.map((i) => i.label)).toEqual(["Divide", "Trim", "Merge", "Crop", "Outline", "Minus Back", "Pathfinder options…"]);
    expect(items.every((i) => !!i.icon)).toBe(true);
    expect(items.every((i) => !i.disabled)).toBe(true);
    // Object › Boolean groups › Pathfinder, and Actions (⌘K) finds them.
    const object = mainMenu(ed).find((e): e is MenuItem => e !== "-" && "label" in e && e.label === "Object")!;
    const groups = object.items!.find((e): e is MenuItem => e !== "-" && "label" in e && e.label === "Boolean groups")!;
    const pf = groups.items!.find((e): e is MenuItem => e !== "-" && "label" in e && e.label === "Pathfinder")!;
    expect(ids(pf.items!)).toEqual([...PATHFINDERS.map((p) => p.id), "-", PATHFINDER_OPTIONS_ID]);
    const actions = actionItems(ed).map((a) => a.id);
    for (const p of PATHFINDERS) expect(actions).toContain(p.id);
    // The menu bar (native) has the same submenu.
    expect(JSON.stringify(MENU_LAYOUT.Vector)).toContain("vector.pathfinder-minus-back");
    // Turkish for every new label.
    for (const s of [
      "Pathfinder",
      "Divide",
      "Trim",
      "Merge",
      "Crop",
      "Outline",
      "Minus Back",
      "Pathfinder options…",
      "Pathfinder options",
      "Precision",
      "Remove redundant points",
      "Divide and Outline will remove unpainted artwork",
      "Defaults",
    ])
      expect(TR[s], s).toBeTruthy();
  });

  it("Divide: a group of vectors in their place, one undo step named Divide, the result selected", async () => {
    const { ed, engine } = await editor();
    engine.setSelection(["2:10", "2:11"]);
    expect(isEnabled(ed, command("vector.pathfinder-divide"))).toBe(true);
    expect(runEditorCommand(ed, "vector.pathfinder-divide")).toBe(true);
    expect(ed.store.undo.undoLabel).toBe("Divide");
    const [g] = engine.getSelection().refs;
    const group = engine.readNode(g, { childIds: true })!;
    expect(group.type === "GROUP" || (group.type === "FRAME" && group.resizeToFit)).toBe(true);
    const kids = (group as { childIds?: string[] }).childIds ?? [];
    expect(kids.length).toBe(3);
    expect(kids.every((k) => engine.readNode(k)!.type === "VECTOR")).toBe(true);
    expect(engine.readNode("2:10")).toBeNull();
    engine.undo();
    expect(engine.readNode("2:10")).not.toBeNull();
    expect(engine.readNode(g)).toBeNull();
  });

  it("Pathfinder options: kept per machine, Illustrator's defaults, passed to the commands", async () => {
    const { ed, engine } = await editor();
    expect(pathfinderOptions(ed)).toEqual(DEFAULT_PATHFINDER);
    setPathfinderOptions(ed, {
      precision: 0,
      removeRedundantPoints: false,
      removeUnpainted: true,
    });
    expect(loadPathfinderOptions()).toEqual({
      precision: 0.001,
      removeRedundantPoints: false,
      removeUnpainted: true,
    });
    expect(isEnabled(ed, command(PATHFINDER_OPTIONS_ID))).toBe(true);
    runEditorCommand(ed, PATHFINDER_OPTIONS_ID);
    expect(ed.ui.get().pathfinderDialog).toBe(true);
    // Minus Back with them: one vector, the front one's look and name.
    engine.setSelection(["2:10", "2:11"]);
    expect(runEditorCommand(ed, "vector.pathfinder-minus-back")).toBe(true);
    expect(ed.store.undo.undoLabel).toBe("Minus Back");
    const [v] = engine.getSelection().refs;
    expect(engine.readNode(v)!.type).toBe("VECTOR");
    expect(engine.readNode(v)!.name).toBe("Inner shadow");
  });

  it("the agents' pathfinder tool runs one on the layers it names", async () => {
    const { ed, engine } = await editor();
    expect(TOOL_BY_NAME.get("pathfinder")?.write).toBe(true);
    const turns = new AgentTurns(ed);
    const env: ToolEnv = {
      ed,
      write: (_l, fn, refs) => turns.write(null, "Claude Code", fn, refs),
    };
    const r = await runTool(env, "pathfinder", {
      operation: "trim",
      nodeIds: ["2:10", "2:11"],
    });
    expect(r.isError ?? false).toBe(false);
    const out = JSON.parse(r.content.map((c) => (c.type === "text" ? c.text : "")).join(""));
    expect(out.ran).toBe("PATHFINDER_TRIM");
    expect(engine.readNode("2:10")).toBeNull();
    const bad = await runTool(env, "pathfinder", {
      operation: "SHAPE_BUILDER",
      nodeIds: ["2:12"],
    });
    expect(bad.isError).toBe(true);
  });
});
