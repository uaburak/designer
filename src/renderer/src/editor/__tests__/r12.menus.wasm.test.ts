// Round 12 — main-menu and context-menu geometry (docs/editor.md "Round 12 — Main-menu and context-menu geometry"):
// the widths live measured (menus/main-*.txt) are held by the entries; Preferences keeps its 5 below; an instance's
// canvas menu is 203 wide; a right click on an instance's nested layer opens the instance's menu.
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
import { MAIN_MENU_WIDTH, canvasMenuWidth, mainMenu } from "../menus";

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

describe("round 12: the Figma menu's submenus hold live's widths", () => {
  it("File 198, Edit 190, View 201.4 (live 201, its Panels at 416), Object 185, Text 199, Arrange 220, Vector 198, Plugins 181, Widgets 152, Preferences 235, Help 178", async () => {
    const { ed } = await editor();
    const main = items(mainMenu(ed));
    const width = (l: string) => main.find((i) => i.label === l)!.width;
    expect(["File", "Edit", "Object", "Text", "Arrange", "Vector", "Plugins", "Widgets", "Preferences", "Help and account"].map(width)).toEqual([198, 190, 185, 199, 220, 198, 181, 152, 235, 178]);
    expect(Math.round(width("View")!)).toBe(201);
    // live's Panels submenu at 416: the main menu's edge (12 + 194.4) + 4, the View menu's width, + 4
    expect(Math.round(12 + MAIN_MENU_WIDTH + 4 + width("View")! + 4)).toBe(416);
  });

  it("Preferences keeps live's 5 below (132 + 763 in 900), the others 8", async () => {
    const { ed } = await editor();
    const main = items(mainMenu(ed));
    expect(main.find((i) => i.label === "Preferences")!.edgeBottom).toBe(5);
    expect(main.filter((i) => i.items && i.label !== "Preferences").every((i) => i.edgeBottom === undefined)).toBe(true);
  });
});

describe("round 12: an instance's menu", () => {
  it("is 203 wide where it offers Detach instance (live context-instance.txt)", () => {
    expect(canvasMenuWidth([{ id: "object.detach-instance", label: "Detach instance" }])).toBe(203);
    expect(canvasMenuWidth([{ id: "edit.copy", label: "Copy" }])).toBeUndefined();
  });
});
