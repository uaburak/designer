// @vitest-environment happy-dom
// Frame status (ours, docs/editor.md "Frame status (ours)") on the real engine: the canvas chip's menu sets a status,
// stored in the frame's pluginData under "designer.workflow"; one undo step restores; the chip shows it; a layer inside
// a frame can't have one; plugins can't use the reserved plugin ID.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { act, createElement } from "react";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { Engine } from "@/engine/Engine";
import { EngineStore } from "@/engine/EngineStore";
import { loadEngine } from "@/engine/loadEngine";
import { SAMPLE_DOCUMENT } from "@/engine/sampleDocument";
import { $, $$, click, mount, type Mounted } from "../../ds/__tests__/dom";
import { EditorContext, EditorController } from "../controller";
import { memoryDocumentSource } from "../documentSource";
import { FrameStatusChips } from "../canvas/FrameStatusChips";
import { canHaveStatus, frameStatusOf, setFrameStatus, WORKFLOW_PLUGIN_ID } from "../frameStatus";
import { getPluginData } from "../plugins/api/nodes";

const wasm = join(process.cwd(), "src/renderer/src/engine/wasm/engine.wasm");
const FRAME = "1:1";
const INNER = "1:7";

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
  m = mount(() => createElement(EditorContext.Provider, { value: ed }, createElement(FrameStatusChips)), {});
  return { ed, engine, host: m.host };
}

const chip = (host: HTMLElement) => $(`[data-frame-id="${FRAME}"]`, host);
const pluginData = (engine: Engine) => (engine.readNode(FRAME, { fields: ["pluginData"] }) as { pluginData?: { pluginID?: string; key?: string; value?: string }[] } | null)?.pluginData ?? [];

describe("Frame status (ours)", () => {
  it("sets a status from the chip's menu, stores it in pluginData, undoes in one step", async () => {
    const { ed, engine, host } = await setup();
    expect(canHaveStatus(ed, FRAME)).toBe(true);
    expect(canHaveStatus(ed, INNER)).toBe(false);
    expect(chip(host)).toBeNull();
    act(() => void engine.setSelection([FRAME]));
    expect(chip(host)?.textContent).toBe("Set status");

    act(() => click(chip(host)));
    const rows = $$('[role="menuitemcheckbox"]');
    expect(rows.map((r) => r.textContent)).toEqual(["Done", "R to Merge", "Ready to Dev", "To be done", "Process", "Revised", "Cancelled", "No status"]);
    expect(rows.at(-1)?.getAttribute("aria-checked")).toBe("true");
    act(() => click(rows[2]));

    expect(pluginData(engine)).toContainEqual(expect.objectContaining({ pluginID: WORKFLOW_PLUGIN_ID, key: "status", value: "ready-to-dev" }));
    expect(frameStatusOf(ed, FRAME)).toBe("ready-to-dev");
    expect(chip(host)?.textContent).toBe("Ready to Dev");
    expect(chip(host)?.dataset.frameStatus).toBe("ready-to-dev");

    // The menu checks the current one.
    act(() => click(chip(host)));
    expect($('[role="menuitemcheckbox"][aria-checked="true"]')?.textContent).toBe("Ready to Dev");
    act(() => click($$('[role="menuitemcheckbox"]')[0]));
    expect(frameStatusOf(ed, FRAME)).toBe("done");

    act(() => void engine.command("UNDO"));
    expect(frameStatusOf(ed, FRAME)).toBe("ready-to-dev");
    expect(chip(host)?.textContent).toBe("Ready to Dev");
    act(() => void engine.command("UNDO"));
    expect(frameStatusOf(ed, FRAME)).toBeNull();

    // Deselected without a status: no chip; with one it stays.
    act(() => setFrameStatus(ed, [FRAME], "cancelled"));
    act(() => void engine.setSelection([]));
    expect(chip(host)?.textContent).toBe("Cancelled");
    act(() => setFrameStatus(ed, [FRAME], null));
    expect(chip(host)).toBeNull();
    engine.destroy();
  });

  it("works in Dev Mode (the engine's viewer mode) and leaves it read-only after", async () => {
    const { ed, engine } = await setup();
    ed.ui.set({ mode: "dev" });
    engine.setViewerMode(true, { devEdits: true });
    setFrameStatus(ed, [FRAME], "revised");
    expect(frameStatusOf(ed, FRAME)).toBe("revised");
    expect(ed.setProps([FRAME], { name: "Renamed" }, "Rename")).not.toBe(0);
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
