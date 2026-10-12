// @vitest-environment happy-dom
// Dev Mode round 5 on the real engine (docs/editor.md "Dev Mode — round 5"): the playground's scratch document (an
// instance, a main, a variant; its controls; the file, its journal and undo untouched), the Ready for dev view's model,
// status reports, and the agents' get_code_connect_map.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import { Engine } from "@/engine/Engine";
import { EngineStore } from "@/engine/EngineStore";
import { loadEngine } from "@/engine/loadEngine";
import type { DevStatusReport } from "@shared/devmode/types";
import { EditorController } from "../controller";
import { memoryDocumentSource } from "../documentSource";
import { COMPONENTS_DOCUMENT } from "../fixtures";
import { buildScratch, setScratchProperty } from "../devmode/scratch";
import { filterReady, readyItems, sortReady } from "../devmode/readyFeed";
import { reportDevStatus, setDevStatusOf } from "../devStatus";
import { ViewerDoc } from "../../../../viewer/viewerDoc";

beforeAll(async () => {
  globalThis.fetch = async () => new Response(null, { status: 404 });
  const bytes = readFileSync(join(process.cwd(), "src/renderer/src/engine/wasm/engine.wasm"));
  await loadEngine({ wasmBinary: bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength), printErr: () => {} });
});

async function editor() {
  const source = memoryDocumentSource(COMPONENTS_DOCUMENT, { fileName: "Components" });
  const engine = await Engine.create(null, { sessionID: 1 });
  engine.load(await source.load());
  engine.setViewport(1280, 800, 1, 1280, 800);
  const ed = new EditorController(engine, new EngineStore(engine), source);
  const changes: unknown[] = [];
  engine.onDocumentChanged((_, e) => changes.push(e.message));
  return { ed, engine, changes };
}

describe("the playground's scratch document", () => {
  it("an instance: its properties change in the scratch engine only", async () => {
    const { ed, engine, changes } = await editor();
    engine.setSelection(["2:3"]);
    const s = await buildScratch(engine, "2:2", null, null);
    expect(s).not.toBeNull();
    expect(engine.getSelection().refs).toEqual(["2:3"]);
    const info = s!.engine.componentInfo(s!.instance)!;
    expect(info.kind).toBe("INSTANCE");
    const label = info.properties.find((p) => p.name === "Label")!;
    expect(label.value).toBe("Sign in");
    expect(setScratchProperty(s!, label, "Log in")).toBe(true);
    expect(s!.engine.componentInfo(s!.instance)!.properties.find((p) => p.name === "Label")!.value).toBe("Log in");
    expect(engine.componentInfo("2:2")!.properties.find((p) => p.name === "Label")!.value).toBe("Sign in");
    expect(changes).toEqual([]);
    expect(ed.store.undo.canUndo).toBe(false);
    s!.engine.destroy();
  });

  it("a main component and a variant get an instance of their own", async () => {
    const { engine } = await editor();
    const main = await buildScratch(engine, "1:1", null, null);
    expect(main && main.engine.componentInfo(main.instance)?.kind).toBe("INSTANCE");
    const variant = await buildScratch(engine, "1:41", null, null);
    const vi = variant!.engine.componentInfo(variant!.instance)!;
    expect(vi.kind).toBe("INSTANCE");
    expect(vi.variantProperties).toEqual({ State: "Default", Size: "Small" });
    const size = vi.properties.find((p) => p.name === "Size")!;
    expect(setScratchProperty(variant!, size, "Large")).toBe(true);
    expect(variant!.engine.componentInfo(variant!.instance)!.variantProperties).toEqual({ State: "Default", Size: "Large" });
    main!.engine.destroy();
    variant!.engine.destroy();
  });
});

describe("Ready for dev and status reports", () => {
  it("lists every page's designs; filters and sorts", async () => {
    const { ed, engine } = await editor();
    const pages = engine.pages();
    const page = pages.find((p) => p.guid === "0:3")!.guid;
    const tops = (engine.readNode(page, { childIds: true }) as { childIds?: string[] }).childIds ?? [];
    expect(tops.length).toBeGreaterThan(1);
    const reports: DevStatusReport[] = [];
    const repo = { reportStatus: async (_k: string, r: DevStatusReport) => void reports.push(r) };
    setDevStatusOf(ed, [tops[0]], "BUILD");
    setDevStatusOf(ed, [tops[1]], "COMPLETED");
    reportDevStatus(Object.assign(Object.create(ed), { source: { fileKey: "f1" } }) as EditorController, [tops[0]], "BUILD", "ready", undefined, repo);
    reportDevStatus(Object.assign(Object.create(ed), { source: { fileKey: "f1" } }) as EditorController, [tops[1]], null, "removed", undefined, repo);
    expect(reports.map((r) => [r.status, r.kind])).toEqual([
      ["READY_FOR_DEV", "ready"],
      ["NONE", "removed"],
    ]);
    const doc = new ViewerDoc(engine);
    const items = readyItems({ pages: () => engine.pages(), statuses: (p) => doc.statuses(p), times: (ids) => ids.map(() => ({ editedAt: 0, statusAt: 0 })) });
    expect(items.length).toBeGreaterThanOrEqual(2);
    expect(filterReady(items, "done").map((i) => i.id)).toEqual([tops[1]]);
    expect(filterReady(items, "ready-to-dev").map((i) => i.id)).toContain(tops[0]);
    const byName = sortReady(items, "name").map((i) => i.name);
    expect(byName).toEqual([...byName].sort((a, b) => a.localeCompare(b, undefined, { sensitivity: "base", numeric: true })));
  });
});

describe("the agents' Code Connect", () => {
  it("get_code_connect_map answers Figma's shape; get_design_context carries the snippet", async () => {
    const { ed } = await editor();
    const { runTool } = await import("../agents/mcpTools");
    const { createSandbox } = await import("../plugins");
    const mappings = [
      { fileKey: "f1", nodeId: "1:1", label: "React", language: "tsx", origin: "ui" as const, source: "src/Button.tsx", component: "Button", template: null, imports: [], nestable: true, instructions: "Use the design system's Button.", updatedBy: null, updatedAt: 0 },
      { fileKey: "f1", nodeId: "1:20", label: "React", language: "tsx", origin: "cli" as const, source: "src/Star.tsx", component: "StarIcon", template: "export default { example: figma.code`<StarIcon />`, imports: ['import { StarIcon } from \"./Star\"'] }", imports: [], nestable: true, instructions: "", updatedBy: null, updatedAt: 0 },
    ];
    const env = { ed, write: <T,>(_l: string, fn: () => T) => fn(), codeConnect: { fileKey: "f1", mappings: async (k: string) => mappings.filter((m) => m.fileKey === k), sandbox: createSandbox } };
    const text = (r: { content: { type: string; text?: string }[]; isError?: boolean }) => {
      expect(r.isError).toBeFalsy();
      return JSON.parse(r.content.find((c) => c.type === "text")!.text!);
    };
    const map = text(await runTool(env, "get_code_connect_map", { nodeId: "2:2" }));
    expect(map["2:2"]).toMatchObject({ componentName: "Button", source: "src/Button.tsx", version: "UI", label: "React", instructions: "Use the design system's Button." });
    expect(map["2:2"].snippet).toContain("<Button");
    expect(map["I2:2;1:2"]).toMatchObject({ componentName: "StarIcon", version: "CLI", snippet: 'import { StarIcon } from "./Star"\n\n<StarIcon />', snippetImports: ['import { StarIcon } from "./Star"'], snippetNestedFunctions: [] });
    const ctx = text(await runTool(env, "get_design_context", { nodeId: "2:2" }));
    expect(ctx.nodes[0].codeConnect).toMatchObject({ componentName: "Button", version: "UI" });
  });
});

// Found running round 5 end to end (2026-10-12): Dev Mode's Layers / Ready for development lists didn't follow a
// shared file's other people — their frames reach the engine as a remote apply, which fires no DOCUMENT_CHANGED.
describe("Dev Mode's panels follow changes applied from outside", () => {
  it("a remote rename and a remote new layer reach onDevDocumentChange", async () => {
    const { ed, engine } = await editor();
    const { onDevDocumentChange } = await import("../devmode/DevPanels");
    let calls = 0;
    const off = onDevDocumentChange(ed, () => calls++, 0);
    engine.applyChanges({ type: "NODE_CHANGES", sessionID: 7, nodeChanges: [{ guid: "2:2", name: "Renamed remotely" } as never] }, "remote");
    await new Promise((r) => setTimeout(r, 10));
    expect(calls).toBe(1);
    engine.applyChanges({ type: "NODE_CHANGES", sessionID: 7, nodeChanges: [{ guid: "7:1", phase: "CREATED", type: "FRAME", name: "From Alice", parentIndex: { guid: "0:1", position: "~" }, size: { x: 10, y: 10 } } as never] }, "remote");
    await new Promise((r) => setTimeout(r, 10));
    expect(calls).toBe(2);
    off();
  });
});
