// @vitest-environment happy-dom
// Frame status (ours, docs/editor.md "Frame status (ours)") on the real engine: the status in a frame's title opens the
// status menu (the engine's DEV_STATUS → `statusMenu`, as a click on it does; the click itself is the engine's native
// test), which writes the owner's status in pluginData and Figma's sectionStatusInfo with it (Ready to Dev ↔ BUILD,
// Done ↔ COMPLETED, others none) in one undo step; a file with only Figma's field reads as his; Dev Mode writes it
// without leaving viewer mode; plugins can't use the reserved plugin ID.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { act, createElement } from "react";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { Engine } from "@/engine/Engine";
import { EngineStore } from "@/engine/EngineStore";
import { loadEngine } from "@/engine/loadEngine";
import { SAMPLE_DOCUMENT } from "@/engine/sampleDocument";
import type { NodeFields } from "@/engine/codec";
import { $, $$, click, mount, type Mounted } from "../../ds/__tests__/dom";
import { EditorContext, EditorController } from "../controller";
import { memoryDocumentSource } from "../documentSource";
import { StatusMenu } from "../devmode/DevOverlays";
import { canHaveStatus, frameStatusChanged, frameStatusOf, frameStatusSince, setFrameStatus, WORKFLOW_PLUGIN_ID } from "../frameStatus";
import { withStatus } from "../workflowStatus";
import { getPluginData } from "../plugins/api/nodes";

const wasm = join(process.cwd(), "src/renderer/src/engine/wasm/engine.wasm");
const FRAME = "1:1";
const INNER = "1:7";
const STATUSES = ["Done", "R to Merge", "Ready to Dev", "To be done", "Process", "Revised", "Cancelled", "No status"];

beforeAll(async () => {
  globalThis.fetch = async () => new Response(null, { status: 404 });
  const bytes = readFileSync(wasm);
  await loadEngine({ wasmBinary: bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength), printErr: () => {} });
});

let m: Mounted | null = null;
afterEach(() => {
  m?.unmount();
  m = null;
  document.body.innerHTML = "";
});

async function setup() {
  const source = memoryDocumentSource(SAMPLE_DOCUMENT, { fileName: "Test" });
  const engine = await Engine.create(null, { sessionID: 1 });
  engine.load(await source.load());
  engine.setViewport(1280, 800, 1, 1280, 800);
  const ed = new EditorController(engine, new EngineStore(engine), source);
  m = mount(() => createElement(EditorContext.Provider, { value: ed }, createElement(StatusMenu)), {});
  return { ed, engine };
}

type Read = { pluginData?: { pluginID?: string; key?: string; value?: string }[]; sectionStatusInfo?: { status?: string } | null };
const read = (engine: Engine) => engine.readNode(FRAME, { fields: ["pluginData", "sectionStatusInfo"] }) as Read;
const ours = (engine: Engine) => read(engine).pluginData?.find((e) => e.pluginID === WORKFLOW_PLUGIN_ID)?.value ?? null;
const figma = (engine: Engine) => read(engine).sectionStatusInfo?.status ?? null;
const openMenu = (ed: EditorController) => act(() => ed.ui.set({ statusMenu: { ref: FRAME, x: 100, y: 100, width: 40, height: 16 } }));
const rows = () => $$('[role="menuitem"]').filter((r) => r.textContent === "No status" || r.hasAttribute("data-tint"));
const row = (label: string) => rows().find((r) => r.textContent === label)!;

describe("Frame status (ours)", () => {
  it("the title's menu sets a status in pluginData and Figma's sectionStatusInfo with it, one undo step", async () => {
    const { ed, engine } = await setup();
    expect(canHaveStatus(ed, FRAME)).toBe(true);
    expect(canHaveStatus(ed, INNER)).toBe(false);

    openMenu(ed);
    expect(rows().map((r) => r.textContent)).toEqual(STATUSES);
    // No check column (the owner, 2026-10-28): each status its own glyph and colour.
    expect($$('[role="menuitemcheckbox"]')).toHaveLength(0);
    expect(row("Ready to Dev").style.getPropertyValue("--menu-tint")).toBe("var(--figma-color-bg-success)");
    act(() => click(row("Ready to Dev")));
    expect(ed.ui.get().statusMenu).toBeNull();
    expect(ours(engine)).toBe("ready-to-dev");
    expect(figma(engine)).toBe("BUILD");
    expect(frameStatusOf(ed, FRAME)).toBe("ready-to-dev");
    expect(engine.devInfo().statuses.find((s) => s.ref === FRAME)?.status).toBe("READY");

    // Ready to Dev in Design mode: Figma's own actions first, then the statuses.
    openMenu(ed);
    expect($('[role="menuitem"]')?.textContent).toBe("Open in Dev Mode");
    act(() => click(row("Process")));
    expect(ours(engine)).toBe("process");
    expect(figma(engine)).toBeNull();
    expect(engine.devInfo().statuses.find((s) => s.ref === FRAME)).toBeUndefined();

    // One step back restores both fields; another clears both.
    act(() => void engine.command("UNDO"));
    expect(ours(engine)).toBe("ready-to-dev");
    expect(figma(engine)).toBe("BUILD");
    act(() => void engine.command("UNDO"));
    expect(ours(engine)).toBeNull();
    expect(figma(engine)).toBeNull();

    // Done is Figma's Completed; "No status" clears both.
    openMenu(ed);
    act(() => click(row("Done")));
    expect([ours(engine), figma(engine)]).toEqual(["done", "COMPLETED"]);
    openMenu(ed);
    act(() => click(row("No status")));
    expect([ours(engine), figma(engine)]).toEqual([null, null]);
    engine.destroy();
  });

  it("reads Figma's own status when there is no pluginData (an imported file); pluginData wins", async () => {
    const { ed, engine } = await setup();
    ed.setProps([FRAME], { sectionStatusInfo: { status: "COMPLETED", lastUpdateUnixTimestamp: 1 } } as unknown as NodeFields, "Import");
    expect(frameStatusOf(ed, FRAME)).toBe("done");
    ed.setProps([FRAME], { sectionStatusInfo: { status: "BUILD", lastUpdateUnixTimestamp: 1 } } as unknown as NodeFields, "Import");
    expect(frameStatusOf(ed, FRAME)).toBe("ready-to-dev");
    openMenu(ed);
    act(() => click(row("Revised")));
    expect(frameStatusOf(ed, FRAME)).toBe("revised");
    expect(figma(engine)).toBeNull();
    engine.destroy();
  });

  it("works in Dev Mode (the engine's viewer mode lets Dev Mode write pluginData) and stays read-only", async () => {
    const { ed, engine } = await setup();
    ed.ui.set({ mode: "dev" });
    engine.setViewerMode(true, { devEdits: true });
    setFrameStatus(ed, [FRAME], "ready-to-dev");
    expect([ours(engine), figma(engine)]).toEqual(["ready-to-dev", "BUILD"]);
    // Dev Mode's menu: focus view and Compare changes, then the statuses.
    openMenu(ed);
    expect($$('[role="menuitem"]').map((r) => r.textContent)).toEqual(["Show in focus view", "Compare changes", ...STATUSES]);
    act(() => click(row("Cancelled")));
    expect([ours(engine), figma(engine)]).toEqual(["cancelled", null]);
    expect(ed.setProps([FRAME], { name: "Renamed" }, "Rename")).not.toBe(0);
    engine.destroy();
  });

  it("Done, R to Merge and Ready to Dev keep when they were set; an edit after it is Changed until Done with changes", async () => {
    const { ed, engine } = await setup();
    engine.setEditTracking(true);
    const before = Math.floor(Date.now() / 1000);
    setFrameStatus(ed, [FRAME], "r-to-merge");
    expect(frameStatusSince(ed, FRAME)).toBeGreaterThanOrEqual(before);
    expect(frameStatusChanged(ed, FRAME)).toBe(false);
    // Set a minute ago (editInfo counts whole seconds), then an edit inside the design.
    engine.setProps([FRAME], { pluginData: withStatus(read(engine).pluginData, "r-to-merge", before - 60) } as unknown as NodeFields);
    expect(frameStatusChanged(ed, FRAME)).toBe(false);
    expect(ed.setProps([INNER], { opacity: 0.5 }, "Edit")).toBe(0);
    expect(frameStatusChanged(ed, FRAME)).toBe(true);
    // A status that tracks nothing: no Changed, no `since`.
    setFrameStatus(ed, [FRAME], "process");
    expect(frameStatusChanged(ed, FRAME)).toBe(false);
    expect(frameStatusSince(ed, FRAME)).toBeNull();
    // Set again (Done with changes): its clock restarts.
    setFrameStatus(ed, [FRAME], "done");
    expect(frameStatusChanged(ed, FRAME)).toBe(false);
    expect(figma(engine)).toBe("COMPLETED");
    engine.destroy();
  });

  it("keeps the reserved plugin ID from plugins", async () => {
    const { ed, engine } = await setup();
    setFrameStatus(ed, [FRAME], "process");
    const ctx = { pluginId: WORKFLOW_PLUGIN_ID, engine, ed } as unknown as Parameters<typeof getPluginData>[0];
    expect(() => getPluginData(ctx, FRAME, null, "status")).toThrow(/reserved/);
    engine.destroy();
  });
});
