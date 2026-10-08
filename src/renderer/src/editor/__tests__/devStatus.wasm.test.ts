// Dev Mode statuses from Design (devStatus.ts) on the real engine: "Mark as ready for dev" on a top-level frame writes
// the schema's sectionStatusInfo (BUILD), the canvas menu offers the status menu's next items, one undo step each; a
// layer inside a frame gets none.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { beforeAll, describe, expect, it } from "vitest";
import { Engine } from "@/engine/Engine";
import { EngineStore } from "@/engine/EngineStore";
import { loadEngine } from "@/engine/loadEngine";
import { EditorController } from "../controller";
import { memoryDocumentSource } from "../documentSource";
import { PROTOTYPE_DOCUMENT } from "../fixtures";
import { canvasMenu } from "../menus";
import { runEditorCommand } from "../commands";
import { statusOfTargets, statusTargets } from "../devStatus";

const wasm = fileURLToPath(new URL("../../engine/wasm/engine.wasm", import.meta.url));

beforeAll(async () => {
  const g = globalThis as Record<string, unknown>;
  g.window ??= globalThis;
  g.document ??= { querySelector: () => null };
  const bytes = readFileSync(wasm);
  await loadEngine({ wasmBinary: bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength), printErr: () => {} });
});

const ids = (entries: ReturnType<typeof canvasMenu>) => entries.flatMap((e) => (typeof e === "object" && "id" in e && e.id ? [e.id] : []));

describe("Dev Mode statuses (wasm, headless)", () => {
  it("marks a frame ready for dev, then completed, then removes the status", async () => {
    const source = memoryDocumentSource(PROTOTYPE_DOCUMENT, { fileName: "Prototype" });
    const engine = await Engine.create(null, { sessionID: 1 });
    engine.load(await source.load());
    const ed = new EditorController(engine, new EngineStore(engine), source);
    engine.setSelection(["2:4"]); // a button inside Home: no status
    expect(statusTargets(ed)).toEqual([]);
    engine.setSelection(["2:1"]);
    expect(statusTargets(ed)).toEqual(["2:1"]);
    expect(ids(canvasMenu(ed, []))).toContain("object.mark-ready-for-dev");
    expect(runEditorCommand(ed, "object.mark-ready-for-dev")).toBe(true);
    const read = () => (engine.readNode("2:1", { fields: ["sectionStatusInfo"] }) as { sectionStatusInfo?: { status?: string; lastUpdateUnixTimestamp?: number } } | null)?.sectionStatusInfo;
    expect(read()).toMatchObject({ status: "BUILD" });
    expect(read()?.lastUpdateUnixTimestamp).toBeGreaterThan(0);
    expect(ids(canvasMenu(ed, []))).toEqual(expect.arrayContaining(["object.mark-completed", "object.remove-dev-status"]));
    runEditorCommand(ed, "object.mark-completed");
    expect(statusOfTargets(ed, ["2:1"])).toBe("COMPLETED");
    runEditorCommand(ed, "object.remove-dev-status");
    expect(read()).toBeUndefined();
    engine.command("UNDO");
    expect(statusOfTargets(ed, ["2:1"])).toBe("COMPLETED");
    engine.destroy();
  });
});
