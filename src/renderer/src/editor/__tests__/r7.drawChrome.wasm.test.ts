// Round 7c — Draw's chrome on the real engine (the committed Wasm build, headless; its Draw calls are still round 7b's
// stubs): the canvas menu's Create brush ▸ in Draw, Switch to Draw on Move, the Brush only in Draw, the Actions
// palette's new tools — and nothing throws while the engine hasn't got Draw's calls.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { beforeAll, describe, expect, it } from "vitest";
import type { MenuEntry, MenuItem } from "@/ds";
import { Engine } from "@/engine/Engine";
import { EngineStore } from "@/engine/EngineStore";
import { loadEngine } from "@/engine/loadEngine";
import { SAMPLE_DOCUMENT } from "@/engine/sampleDocument";
import { EditorController } from "../controller";
import { memoryDocumentSource } from "../documentSource";
import { runEditorCommand } from "../commands";
import { actionItems, canvasMenu } from "../menus";
import { attachDrawTools, drawToolsOf, setPencil } from "../draw/drawTools";

const wasm = fileURLToPath(new URL("../../engine/wasm/engine.wasm", import.meta.url));

beforeAll(async () => {
  const g = globalThis as Record<string, unknown>;
  g.window ??= globalThis;
  g.document ??= { querySelector: () => null };
  const bytes = readFileSync(wasm);
  await loadEngine({ wasmBinary: bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength), printErr: () => {} });
});

async function editor() {
  const source = memoryDocumentSource(SAMPLE_DOCUMENT, { fileName: "Test" });
  const engine = await Engine.create(null, { sessionID: 1 });
  engine.load(await source.load());
  engine.setViewport(1280, 800, 1, 1280, 800);
  const ed = new EditorController(engine, new EngineStore(engine), source);
  return { ed, engine };
}

const items = (entries: readonly MenuEntry[]): MenuItem[] => entries.filter((e): e is MenuItem => typeof e === "object" && "id" in e);

describe("round 7c: Draw's chrome on the engine", () => {
  it("Create brush ▸ in Draw's canvas menu for one vector-like layer, after Outline stroke", async () => {
    const { ed, engine } = await editor();
    engine.setSelection(["1:3"]);
    expect(items(canvasMenu(ed, [])).map((i) => i.label)).not.toContain("Create brush");
    runEditorCommand(ed, "view.switch-to-draw");
    const menu = items(canvasMenu(ed, []));
    const at = menu.findIndex((i) => i.label === "Create brush");
    // After Flatten and Outline stroke (a row that can't run is gone: Atlas 03 §4).
    expect(["Flatten", "Outline stroke"]).toContain(menu[at - 1].label);
    expect(menu[at].items!.map((i) => (i as MenuItem).label)).toEqual(["Stretch brush", "Scatter brush"]);
    // The engine's CREATE_BRUSH comes with round 7b: listed, disabled until then.
    expect((menu[at].items as MenuItem[]).every((i) => i.disabled === !(engine.commandState("CREATE_BRUSH") & 1))).toBe(true);
    engine.setSelection(["1:1"]);
    expect(items(canvasMenu(ed, [])).map((i) => i.label)).not.toContain("Create brush");
  });

  it("Switch to Draw starts on Move; the Brush is Draw's; the settings survive the stubs", async () => {
    const { ed } = await editor();
    const off = attachDrawTools(ed);
    ed.setTool("PENCIL");
    runEditorCommand(ed, "view.switch-to-draw");
    expect(ed.ui.get().mode).toBe("draw");
    expect(ed.store.tool).toBe("MOVE");
    setPencil(ed, { weight: 3 });
    expect(drawToolsOf(ed).settings.pencil.weight).toBe(3);
    runEditorCommand(ed, "view.switch-to-draw");
    expect(ed.ui.get().mode).toBe("design");
    expect(runEditorCommand(ed, "tool.brush")).toBe(false);
    off();
  });

  it("the Actions palette lists Brush and Text on path with the tools", async () => {
    const { ed } = await editor();
    const tools = actionItems(ed).filter((a) => a.section === "Tools").map((a) => a.label);
    expect(tools).toEqual(expect.arrayContaining(["Pencil", "Brush", "Text", "Text on path"]));
    expect(tools.indexOf("Brush")).toBe(tools.indexOf("Pencil") + 1);
  });
});
