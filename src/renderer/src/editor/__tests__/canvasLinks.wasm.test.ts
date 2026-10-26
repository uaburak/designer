// Canvas links and buttons (ours, model/canvasLinks.ts + model/canvasButtons.ts): links to websites and to layers of
// this or another file; a text's link to a layer kept as Figma's Hyperlink.guid; canvas buttons stored as plugin data,
// their links named by the outermost frame they go to — on the real engine (the committed Wasm build, headless).
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { beforeAll, describe, expect, it } from "vitest";
import { Engine } from "@/engine/Engine";
import { EngineStore } from "@/engine/EngineStore";
import { loadEngine } from "@/engine/loadEngine";
import type { Message } from "@/engine/codec";
import { EditorController } from "../controller";
import { memoryDocumentSource } from "../documentSource";
import { CAPTURE_DOCUMENT } from "../fixtures";
import { createNodes } from "../agents/mcpTools";
import { hyperlinkOf, hyperlinkTarget, nodeLink, parseLinkTarget, placeName } from "../model/canvasLinks";
import { addButton, buttonAmong, buttonEntry, newButtonLink, readButton, writeButton } from "../model/canvasButtons";

const wasm = fileURLToPath(new URL("../../engine/wasm/engine.wasm", import.meta.url));

beforeAll(async () => {
  const g = globalThis as Record<string, unknown>;
  g.window ??= globalThis;
  g.document ??= { querySelector: () => null };
  const bytes = readFileSync(wasm);
  await loadEngine({ wasmBinary: bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength), printErr: () => {} });
});

async function editor(doc: Message = CAPTURE_DOCUMENT) {
  const source = memoryDocumentSource(doc, { fileName: "Capture" });
  const engine = await Engine.create(null, { sessionID: 1 });
  engine.load(await source.load());
  engine.setViewport(1280, 800, 1, 1280, 800);
  const ed = new EditorController(engine, new EngineStore(engine), source);
  (source as unknown as { fileKey: string }).fileKey = "HERE";
  engine.setCurrentPage("0:1");
  return { ed, engine };
}

describe("link targets", () => {
  it("reads websites, layer links of this file and of others, editor addresses and bare ids", () => {
    expect(parseLinkTarget("figma.com", "HERE")).toEqual({ kind: "url", url: "https://figma.com" });
    expect(parseLinkTarget(nodeLink("HERE", "1:2"), "HERE")).toEqual({ kind: "node", fileKey: null, nodeId: "1:2" });
    expect(parseLinkTarget(nodeLink("OTHER", "12:345", "/home"), "HERE")).toEqual({ kind: "node", fileKey: "OTHER", nodeId: "12:345" });
    expect(parseLinkTarget("app://x/?editor&file=OTHER&node-id=3-4", "HERE")).toEqual({ kind: "node", fileKey: "OTHER", nodeId: "3:4" });
    expect(parseLinkTarget("7:8", "HERE")).toEqual({ kind: "node", fileKey: null, nodeId: "7:8" });
    expect(parseLinkTarget("not a link", "HERE")).toBeNull();
  });

  it("keeps a link to this file's layer as Figma's guid, another file's as its link", () => {
    expect(hyperlinkOf({ kind: "node", fileKey: null, nodeId: "1:2" }, "HERE")).toEqual({ guid: { sessionID: 1, localID: 2 } });
    expect(hyperlinkOf({ kind: "node", fileKey: "OTHER", nodeId: "1:2" }, "HERE")).toEqual({ url: nodeLink("OTHER", "1:2") });
    expect(hyperlinkTarget({ guid: { sessionID: 1, localID: 2 } }, "HERE")).toEqual({ kind: "node", fileKey: null, nodeId: "1:2" });
    expect(hyperlinkTarget({ url: nodeLink("OTHER", "5:6") }, "HERE")).toEqual({ kind: "node", fileKey: "OTHER", nodeId: "5:6" });
  });
});

describe("canvas buttons", () => {
  it("adds a button that is one undo step, stores its links and names them by their outermost frame", async () => {
    const { ed, engine } = await editor();
    const env = { ed, write: <T,>(_l: string, f: () => T) => f() };
    const home = createNodes(env, { nodes: [{ type: "FRAME", name: "/home", x: 2000, y: 0, width: 400, height: 400, children: [{ type: "FRAME", name: "Card", x: 10, y: 10, width: 100, height: 100 }] }] }).touched![0];
    const card = (engine.readNode(home, { childIds: true }) as { childIds: string[] }).childIds[0];
    expect(placeName(ed, card)).toBe("/home");

    const before = engine.readNode("0:1", { childIds: true })?.childIds?.length ?? 0;
    const button = addButton(ed, { x: 3000, y: 0 })!;
    expect(button).toBeTruthy();
    expect(readButton(ed, button)).toEqual({ links: [] });
    const kids = (engine.readNode(button, { childIds: true }) as { childIds: string[] }).childIds;
    expect(kids.length).toBe(3);
    // A pill: its label on one line, the frame hugging it (not the label's height at its default width).
    expect((engine.readNode(button, { fields: ["size"] }) as { size: { y: number } }).size.y).toBeLessThan(60);
    expect(buttonAmong(ed, [kids[1], button])).toBe(button);

    const local = newButtonLink(ed, nodeLink("HERE", card))!;
    const other = newButtonLink(ed, nodeLink("OTHER", "9:9", "/search"))!;
    writeButton(ed, button, { links: [local, other, { link: "https://anextour.com" }] }, "Links");
    const labels = readButton(ed, button)!.links.map((l) => buttonEntry(ed, l).label);
    expect(labels).toEqual(["/home", "/search", "anextour.com"]);

    // Renamed, a frame of this file names the link by its new name.
    engine.setProps([home], { name: "/home-new" });
    expect(buttonEntry(ed, readButton(ed, button)!.links[0]).label).toBe("/home-new");

    // Undo the links, then the button: back to before.
    engine.undo();
    engine.undo();
    engine.undo();
    expect(engine.readNode("0:1", { childIds: true })?.childIds?.length).toBe(before);
  });
});
