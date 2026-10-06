// The real engine (the committed Wasm build) driven through the TS facade in Node, headless:
// marshalling, the result slot, the event pump, transactions and undo end to end.
// (docs/engine.md §11.2 plans a wasm-node build for this; the web build with two stubs does for now.)
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { beforeAll, describe, expect, it } from "vitest";
import { CMD_ENABLED, MOD_ALT, MOD_SHIFT, POINTER_CAPTURE, PointerType, Status } from "../abi";
import type { EngineEvent, EventOf, Message, NodeChange } from "../codec";
import { Engine } from "../Engine";
import { BUNDLED_FACES, fonts } from "../fonts";
import { loadEngine } from "../loadEngine";
import { SAMPLE_DOCUMENT } from "../sampleDocument";

const wasm = fileURLToPath(new URL("../wasm/engine.wasm", import.meta.url));

beforeAll(async () => {
  // The web build's glue looks up `document` and `window` when it starts (its DOM helpers); headless needs nothing else.
  const g = globalThis as Record<string, unknown>;
  g.window ??= globalThis;
  g.document ??= { querySelector: () => null };
  const bytes = readFileSync(wasm);
  await loadEngine({ wasmBinary: bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength), printErr: () => {} });
});

async function engineWithSample() {
  const engine = await Engine.create(null, { sessionID: 9 });
  engine.load(SAMPLE_DOCUMENT);
  engine.setViewport(1280, 800, 2, 2560, 1600);
  engine.setCamera({ x: 0, y: 0, zoom: 1 });
  return engine;
}

describe("engine (wasm, headless)", () => {
  it("loads the sample and reads nodes back", async () => {
    const engine = await engineWithSample();
    expect(engine.pages()).toEqual([{ guid: "0:1", name: "Page 1" }]);
    const desktop = engine.readNode("1:1", { childIds: true })!;
    expect(desktop.name).toBe("Desktop");
    expect(desktop.type).toBe("FRAME");
    expect(desktop.childIds?.length).toBe(6);
    expect(engine.readNode("9:9")).toBeNull();
    const snapshot: Message = engine.encodeDocument();
    expect(snapshot.nodeChanges[0].guid).toBe("0:0");
    expect(snapshot.nodeChanges).toHaveLength(SAMPLE_DOCUMENT.nodeChanges.length);
    engine.destroy();
  });

  it("a drag is one DOCUMENT_CHANGED, delivered after the call; undo is another", async () => {
    const engine = await engineWithSample();
    const events: EngineEvent[] = [];
    engine.onAny((e) => events.push(e));
    const documents: number[] = [];
    engine.onDocumentChanged((changes) => documents.push(changes.length));
    const selections: string[][] = [];
    engine.onSelectionChanged((s) => selections.push(s.refs));

    // Card (1:5) sits at 24,88 in Desktop (0,0).
    const r = engine.pointer(PointerType.DOWN, 100, 150, 0, 1, 0);
    expect(r & POINTER_CAPTURE).toBeTruthy();
    for (let x = 105; x <= 160; x += 5) engine.pointer(PointerType.MOVE, x, 150, 0, 1, 0);
    engine.pointer(PointerType.UP, 160, 150, 0, 0, 0);
    expect(selections).toEqual([["1:5"]]);
    expect(documents).toEqual([1]);
    expect(engine.readNode("1:5")!.transform!.m02).toBe(84);
    const changed = events.find((e) => e.type === "DOCUMENT_CHANGED");
    expect(changed && changed.type === "DOCUMENT_CHANGED" && changed.message.nodeChanges[0]).toMatchObject({ guid: "1:5", transform: { m02: 84 } });

    expect(engine.undo()).toBe(true);
    expect(engine.readNode("1:5")!.transform!.m02).toBe(24);
    expect(documents).toEqual([1, 1]);
    engine.destroy();
  });

  it("keys: arrows are the engine's, letters go to the shortcut table", async () => {
    const engine = await engineWithSample();
    engine.setSelection(["1:5"]);
    expect(engine.key("down", "ArrowRight", "ArrowRight", 0)).toBe(1);
    expect(engine.readNode("1:5")!.transform!.m02).toBe(25);
    expect(engine.key("down", "KeyR", "r", 0)).toBe(0);
    engine.destroy();
  });

  it("panel writes: setProps inside a transaction is one undo step", async () => {
    const engine = await engineWithSample();
    let messages = 0;
    engine.onDocumentChanged(() => messages++);
    engine.txnBegin("Opacity");
    for (const opacity of [0.9, 0.7, 0.5]) engine.setProps(["1:5", "1:6"], { opacity });
    expect(messages).toBe(0);
    engine.txnCommit();
    expect(messages).toBe(1);
    expect(engine.readNode("1:6")!.opacity).toBeCloseTo(0.5);
    engine.undo();
    expect(engine.readNode("1:6")!.opacity ?? 1).toBe(1);
    engine.destroy();
  });

  it("tools, commands and the camera", async () => {
    const engine = await engineWithSample();
    const tools: string[] = [];
    engine.on("TOOL_CHANGED", (e) => tools.push(e.tool));
    engine.setTool("RECTANGLE");
    engine.pointer(PointerType.DOWN, 1100, 600, 0, 1, 0);
    engine.pointer(PointerType.MOVE, 1150, 650, 0, 1, 0);
    engine.pointer(PointerType.UP, 1150, 650, 0, 0, 0);
    const [id] = engine.getSelection().refs;
    expect(engine.readNode(id)).toMatchObject({ type: "ROUNDED_RECTANGLE", name: "Rectangle 1", size: { x: 50, y: 50 } });
    expect(id.startsWith("9:")).toBe(true);
    expect(tools).toEqual(["RECTANGLE", "MOVE"]);
    expect(engine.hitTest(100, 150)).toEqual(["1:5", "1:1"]);  // innermost first
    expect(engine.hitTest(1100, 100)).toEqual([]);
    engine.command("ZOOM_IN");
    expect(engine.getCamera().zoom).toBeCloseTo(2);
    expect(engine.stats().nodes).toBe(SAMPLE_DOCUMENT.nodeChanges.length + 1);
    engine.destroy();
  });

  it("refuses a bad payload without breaking", async () => {
    const engine = await engineWithSample();
    expect(engine.applyChanges({ type: "NODE_CHANGES", sessionID: 0, nodeChanges: [{ guid: "1:5", phase: "REMOVED" }] }, "remote")).toBe(0);
    expect(engine.readNode("1:5")).toBeNull();
    expect(engine.getSelection().refs).toEqual([]);
    engine.destroy();
  });

  it("editor support: commands with a page argument, moveNodes, encodeSelection and paste", async () => {
    const engine = await engineWithSample();
    // Group and ungroup the two cards: one undo step each, labelled as Figma's.
    const labels: string[] = [];
    engine.on("DOCUMENT_CHANGED", (e) => labels.push(e.label));
    engine.setSelection(["1:5", "1:6"]);
    expect(engine.commandState("GROUP") & CMD_ENABLED).toBeTruthy();
    expect(engine.command("GROUP")).toBe(Status.OK);
    const [group] = engine.getSelection().refs;
    expect(engine.readNode(group, { childIds: true })).toMatchObject({ name: "Group 2", resizeToFit: true, childIds: ["1:5", "1:6"] });
    expect(engine.command("UNGROUP")).toBe(Status.OK);
    expect(engine.getSelection().refs).toEqual(["1:5", "1:6"]);
    expect(labels).toEqual(["Group selection", "Ungroup selection"]);

    // Pages: the args carry a GUID string.
    expect(engine.command("DUPLICATE_PAGE", { page: "0:1" })).toBe(Status.OK);
    const pages = engine.pages();
    expect(pages.map((p) => p.name)).toEqual(["Page 1", "Page 1 copy"]);
    expect(engine.command("DELETE_PAGE", { page: pages[1].guid })).toBe(Status.OK);
    expect(engine.pages()).toHaveLength(1);
    expect(engine.command("DELETE_PAGE")).toBe(Status.E_INVALID);

    // The Layers panel: Card to the bottom of Desktop, then out onto the page (its place kept).
    expect(engine.moveNodes(["1:5"], "1:1", 0)).toBe(1);
    expect(engine.readNode("1:1", { childIds: true })!.childIds![0]).toBe("1:5");
    expect(engine.moveNodes(["1:5"], "0:1", 0)).toBe(1);
    expect(engine.readNode("1:5")).toMatchObject({ parentIndex: { guid: "0:1" }, transform: { m02: 24, m12: 88 } });
    expect(engine.moveNodes(["1:1"], "1:7", 0)).toBe(0);

    // Copy and paste.
    engine.setSelection([]);
    expect(engine.encodeSelection()).toBeNull();
    engine.setSelection(["1:10"]);
    const clip = engine.encodeSelection()!;
    expect(clip.nodeChanges.map((n) => n.guid)).toEqual(["1:10", "1:11", "1:12", "1:13"]);
    expect(clip.pastePageId).toBe("0:1");
    expect(clip.clipboardSelectionRegions).toEqual([{ parent: "0:1", nodes: ["1:10"], enclosingFrameOffset: { x: 0, y: 0 } }]);
    engine.setSelection([]);
    expect(engine.paste(clip, { inPlace: true })).toBe(1);
    const [pasted] = engine.getSelection().refs;
    expect(pasted.startsWith("9:")).toBe(true);
    expect(engine.readNode(pasted, { childIds: true })).toMatchObject({ name: "Mobile", transform: { m02: 720, m12: 0 } });
    expect(engine.readNode(pasted, { childIds: true })!.childIds).toHaveLength(3);
    engine.destroy();
  });

  it("round 2 follow-ups: flips, select inverse, the context menu event, a thumbnail", async () => {
    const engine = await engineWithSample();
    engine.setSelection(["1:5"]);
    expect(engine.command("FLIP_HORIZONTAL")).toBe(Status.OK);
    expect(engine.readNode("1:5")!.transform).toMatchObject({ m00: -1, m02: 304 });
    expect(engine.command("FLIP_VERTICAL")).toBe(Status.OK);
    expect(engine.readNode("1:5")!.transform).toMatchObject({ m11: -1, m12: 248 });
    expect(engine.commandState("FLIP_HORIZONTAL") & CMD_ENABLED).toBeTruthy();

    engine.setSelection(["1:10"]);
    expect(engine.command("SELECT_INVERSE")).toBe(Status.OK);
    expect(engine.getSelection().refs).toEqual(["1:1", "1:20", "1:21", "1:22", "1:23"]);  // "Locked" (1:26) is left out

    // Right-click on Card: it becomes the selection, then CONTEXT_MENU lists what is under the point.
    const order: string[] = [];
    let menu: EngineEvent | undefined;
    engine.onAny((e) => {
      order.push(e.type);
      if (e.type === "CONTEXT_MENU") menu = e;
    });
    engine.pointer(PointerType.DOWN, 100, 150, 2, 2, 0);
    engine.pointer(PointerType.UP, 100, 150, 2, 0, 0);
    expect(engine.getSelection().refs).toEqual(["1:5"]);
    expect(menu).toEqual({ type: "CONTEXT_MENU", targetKind: "SELECTION", x: 100, y: 150, hits: [["1:5", "1:1"]] });
    expect(order.indexOf("SELECTION_CHANGED")).toBeLessThan(order.indexOf("CONTEXT_MENU"));

    // Thumbnail: the content's aspect, fitted; headless gives the page colour.
    const thumb = engine.renderThumbnailPixels({ maxSize: 200 })!;
    expect(thumb.width).toBe(200);
    expect(thumb.height).toBeLessThan(200);
    expect(thumb.pixels.length).toBe(thumb.width * thumb.height * 4);
    expect(thumb.pixels[3]).toBe(255);
    expect(engine.renderThumbnailPixels({ page: "9:9", maxSize: 200 })).toBeNull();
    engine.destroy();
  });
});

describe("engine (wasm, headless): text (E3)", () => {
  const fontFile = (name: string) => new Uint8Array(readFileSync(fileURLToPath(new URL(`../fonts/${name}`, import.meta.url))));

  async function textEngine() {
    fonts.setSource({
      list: async () => BUNDLED_FACES,
      read: async (face) => fontFile(face.id === "bundled:inter" ? "InterVariable.ttf" : "InterVariable-Italic.ttf"),
    });
    const engine = await Engine.create(null, { sessionID: 3 });
    const doc: Message = {
      type: "NODE_CHANGES",
      sessionID: 0,
      nodeChanges: [
        ...SAMPLE_DOCUMENT.nodeChanges.slice(0, 3),
        {
          guid: "1:500",
          phase: "CREATED",
          type: "TEXT",
          parentIndex: { guid: "0:1", position: "~" },
          name: "ABC",
          size: { x: 42, y: 21 },
          transform: { m00: 1, m01: 0, m02: 2000, m10: 0, m11: 1, m12: 2000 },
          fillPaints: [{ type: "SOLID", color: { r: 0, g: 0, b: 0, a: 1 }, opacity: 1, visible: true }],
          textData: { characters: "ABC" },
          fontName: { family: "Inter", style: "Regular", postscript: "" },
          lineHeight: { value: 100, units: "PERCENT" },
        },
      ],
    };
    engine.load(doc);
    engine.setViewport(800, 600, 1, 800, 600);
    await fonts.settled();
    engine.pump();
    return engine;
  }

  it("lays out a text as Figma does (structure.fig's \"ABC\") once Inter has arrived", async () => {
    const engine = await textEngine();
    const layout = engine.textLayout("1:500")!;
    expect(layout.pendingFont).toBe(false);
    expect(layout.missingFont).toBe(false);
    expect(layout.glyphs.map((g) => g.position.x)).toEqual([0, expect.closeTo(8.109, 0), expect.closeTo(15.914, 0)]);
    expect(layout.baselines[0].lineHeight).toBe(15);
    expect(layout.baselines[0].position.y).toBeCloseTo(11.8636, 1);
    expect(engine.textLayout("0:1")).toBeNull();
    engine.destroy();
  });

  it("the Text tool: click, type, Esc — one undo step, TEXT_EDIT events, the fields in codec.ts", async () => {
    const engine = await textEngine();
    const edits: EventOf<"TEXT_EDIT">[] = [];
    engine.on("TEXT_EDIT", (e) => edits.push(e));
    expect(engine.setTool("TEXT")).toBe(Status.OK);
    engine.pointer(PointerType.DOWN, 100, 100, 0, 1, 0);
    engine.pointer(PointerType.UP, 100, 100, 0, 0, 0);
    expect(engine.textEdit?.active).toBe(true);
    const ref = engine.textEdit!.ref!;
    engine.textInput("Hello");
    const node = engine.readNode(ref)!;
    expect(node.type).toBe("TEXT");
    expect(node.textData?.characters).toBe("Hello");
    expect(node.textAutoResize).toBe("WIDTH_AND_HEIGHT");
    expect(node.fontName).toEqual({ family: "Inter", style: "Regular", postscript: "" });
    expect(node.fontSize).toBe(12);
    expect(node.size?.y).toBe(15);
    expect(node.name).toBe("Hello");
    expect(edits.at(-1)!.selStart).toBe(5);
    engine.key("down", "ArrowLeft", "ArrowLeft", MOD_SHIFT | MOD_ALT);
    expect(engine.textSelection()).toBe("Hello");
    engine.key("down", "Escape", "Escape", 0);
    expect(engine.textEdit).toBeNull();
    expect(engine.getSelection().refs).toEqual([ref]);
    engine.undo();
    expect(engine.readNode(ref)).toBeNull();
    engine.destroy();
  });

  it("nodes the engine doesn't draw keep their type and fields", async () => {
    const engine = await textEngine();
    engine.applyChanges({
      type: "NODE_CHANGES",
      sessionID: 0,
      nodeChanges: [
        {
          guid: "1:600",
          phase: "CREATED",
          type: "VECTOR",
          parentIndex: { guid: "0:1", position: "~~" },
          size: { x: 10, y: 10 },
          vectorData: { vectorNetworkBlob: 4 },
          fillPaints: [{ type: "GRADIENT_LINEAR", visible: true, stops: [] }],
        } as unknown as NodeChange,
      ],
    });
    engine.setSelection(["1:600"]);
    engine.command("DUPLICATE");
    const copy = engine.readNode(engine.getSelection().refs[0]) as NodeChange & { vectorData?: unknown };
    expect(copy.type).toBe("VECTOR");
    expect(copy.vectorData).toEqual({ vectorNetworkBlob: 4 });
    expect(copy.fillPaints?.[0]).toEqual({ type: "GRADIENT_LINEAR", visible: true, stops: [] });
    engine.destroy();
  });
});
