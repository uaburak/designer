// Dev Mode in the editor on the real engine (headless): notes and categories written to Figma's fields through the
// panels' path, the editor's Dev Mode (viewer mode that still takes Dev Mode's own edits, in one undo step each),
// saved measurements through the commands, editInfo stamped on edits making a ready design "Changed", "Done with
// changes", focus view.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { beforeAll, describe, expect, it } from "vitest";
import { Engine } from "@/engine/Engine";
import { EngineStore } from "@/engine/EngineStore";
import { loadEngine } from "@/engine/loadEngine";
import { Status } from "@/engine/abi";
import type { NodeFields } from "@/engine/codec";
import { EditorController } from "../controller";
import { memoryDocumentSource } from "../documentSource";
import { PROTOTYPE_DOCUMENT } from "../fixtures";
import { runEditorCommand } from "../commands";
import { setDevStatusOf } from "../devStatus";
import { closeFocus, ensureCategoryId, modeOf, openFocus, readCategories, readNotes, setMode, writeCategories, writeNotes } from "../devmode/devMode";

const wasm = fileURLToPath(new URL("../../engine/wasm/engine.wasm", import.meta.url));

beforeAll(async () => {
  const g = globalThis as Record<string, unknown>;
  g.window ??= globalThis;
  g.document ??= { querySelector: () => null };
  const bytes = readFileSync(wasm);
  await loadEngine({ wasmBinary: bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength), printErr: () => {} });
});

async function editor() {
  const source = memoryDocumentSource(PROTOTYPE_DOCUMENT, { fileName: "Prototype" });
  const engine = await Engine.create(null, { sessionID: 1 });
  engine.load(await source.load());
  const ed = new EditorController(engine, new EngineStore(engine), source);
  return { engine, ed };
}

describe("Dev Mode in the editor (wasm, headless)", () => {
  it("writes notes with a category and pinned properties; Dev Mode takes them, refuses design edits", async () => {
    const { engine, ed } = await editor();
    // Figma's presets get ids when a note first uses one.
    const cats = readCategories(ed);
    expect(cats.map((c) => c.label)).toEqual(["Development", "Interaction", "Accessibility", "Content"]);
    const dev = ensureCategoryId(ed, cats, 0);
    expect(dev).toMatch(/^\d+:\d+$/);
    expect(readCategories(ed)[0].id).toBe(dev);
    writeNotes(ed, "2:4", [{ markdown: "Tap **opens** the menu", properties: ["WIDTH", "FILL"], categoryId: dev }], "Add annotation");
    expect(readNotes(ed, "2:4")).toEqual([{ markdown: "Tap **opens** the menu", properties: ["WIDTH", "FILL"], categoryId: dev }]);
    const raw = engine.readNode("2:4", { fields: ["annotations"] }) as { annotations?: { label?: string }[] } | null;
    expect(raw?.annotations?.[0]?.label).toBe("Tap opens the menu");
    // Custom categories.
    writeCategories(ed, [...readCategories(ed), { id: null, preset: null, label: "Motion", color: "PINK", custom: true }]);
    expect(readCategories(ed).map((c) => c.label)).toContain("Motion");

    // Dev Mode: viewer mode with Dev Mode's own edits.
    setMode(ed, "dev");
    expect(modeOf(ed)).toBe("dev");
    writeNotes(ed, "2:4", [], "Delete annotation");
    expect(readNotes(ed, "2:4")).toEqual([]);
    expect(engine.setProps(["2:4"], { name: "Renamed" } as NodeFields)).toBe(Status.E_READONLY);
    engine.command("UNDO");
    expect(readNotes(ed, "2:4")).toHaveLength(1);
    // The tools are Dev Mode's too; a design tool isn't.
    expect(engine.setTool("MEASUREMENT")).toBe(Status.OK);
    expect(engine.setTool("RECTANGLE")).toBe(Status.E_READONLY);
    engine.setTool("MOVE");
    setMode(ed, "design");
    expect(engine.setProps(["2:4"], { name: "Renamed" } as NodeFields)).toBe(Status.OK);
    engine.destroy();
  });

  it("measurements: add, edit the text, delete — on the page, in Dev Mode too", async () => {
    const { engine, ed } = await editor();
    setMode(ed, "dev");
    expect(engine.command("MEASUREMENT_ADD", { from: "2:1", side: "LEFT" })).toBe(Status.OK);
    let info = engine.devInfo();
    expect(info.measurements).toHaveLength(1);
    const m = info.measurements[0];
    expect(m.from).toBe("2:1");
    expect(m.to).toBe("2:1");
    const width = (engine.readNode("2:1", { fields: ["size"] })?.size?.x ?? 0) as number;
    expect(m.value).toBeCloseTo(width);
    expect(engine.command("MEASUREMENT_UPDATE", { id: m.id, freeText: "Screen width" })).toBe(Status.OK);
    info = engine.devInfo();
    expect(info.measurements[0].freeText).toBe("Screen width");
    expect(engine.command("MEASUREMENT_DELETE", { id: m.id })).toBe(Status.OK);
    expect(engine.devInfo().measurements).toHaveLength(0);
    engine.command("UNDO");
    expect(engine.devInfo().measurements).toHaveLength(1);
    // Refused outside Dev Mode's edits: a preview viewer.
    engine.setViewerMode(true);
    expect(engine.command("MEASUREMENT_DELETE", { id: m.id })).toBe(Status.E_READONLY);
    engine.destroy();
  });

  it("a ready design edited afterwards shows Changed; Done with changes clears it", async () => {
    const { engine, ed } = await editor();
    engine.setEditTracking(true);
    setDevStatusOf(ed, ["2:1"], "BUILD");
    expect(engine.devInfo().statuses).toEqual([{ ref: "2:1", status: "READY" }]);
    // An edit a second later (the clock is in unix seconds) stamps editInfo on the layer and its design.
    await new Promise((r) => setTimeout(r, 1100));
    writeNotes(ed, "2:1", [{ markdown: "A note", properties: [], categoryId: null }], "Add annotation");
    expect(engine.devInfo().statuses[0].status).toBe("READY"); // a note isn't an edit
    ed.setProps(["2:4"], { opacity: 0.5 } as NodeFields, "Opacity");
    const design = engine.readNode("2:1", { fields: ["editInfo"] }) as { editInfo?: { lastEditedAt?: number } } | null;
    expect(design?.editInfo?.lastEditedAt).toBeGreaterThan(0);
    expect(engine.devInfo().statuses).toEqual([{ ref: "2:1", status: "CHANGED" }]);
    // "Done with changes": Ready again, with the reason.
    await new Promise((r) => setTimeout(r, 1100));
    setDevStatusOf(ed, ["2:1"], "BUILD", { description: "Copy fix", label: "Done with changes" });
    const info = (engine.readNode("2:1", { fields: ["sectionStatusInfo"] }) as { sectionStatusInfo?: Record<string, unknown> } | null)?.sectionStatusInfo;
    expect(info).toMatchObject({ status: "BUILD", description: "Copy fix", prevStatus: "BUILD" });
    expect(engine.devInfo().statuses[0].status).toBe("READY");
    engine.destroy();
  });

  it("focus view: the design alone, Dev Mode, back", async () => {
    const { engine, ed } = await editor();
    openFocus(ed, "2:1");
    expect(modeOf(ed)).toBe("dev");
    expect(ed.ui.get().focus).toBe("2:1");
    expect(engine.devInfo().focus).toBe("2:1");
    closeFocus(ed, { inspectOnPage: true });
    expect(engine.devInfo().focus).toBeNull();
    expect(engine.getSelection().refs).toEqual(["2:1"]);
    // ⇧D leaves Dev Mode.
    expect(runEditorCommand(ed, "view.dev-mode")).toBe(true);
    expect(modeOf(ed)).toBe("design");
    engine.destroy();
  });
});
