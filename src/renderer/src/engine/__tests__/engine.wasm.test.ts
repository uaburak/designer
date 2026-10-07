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
import { decodeMessage as decodeKiwi, encodeMessage as encodeKiwi } from "@shared/schema/codec";
import { messageToEngine, messageToKiwi } from "../../store/engineMessage";

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

  it("vectors keep their network through the Message's blobs (E4); paints keep their fields", async () => {
    const engine = await textEngine();
    // A two-vertex network (docs/schema.md §11.3): (0,0) → (10,10).
    const net = new DataView(new ArrayBuffer(12 + 24 + 28));
    net.setUint32(0, 2, true);
    net.setUint32(4, 1, true);
    net.setUint32(8, 0, true);
    net.setFloat32(20, 10, true);
    net.setFloat32(24, 10, true);
    net.setUint32(40, 0, true);
    net.setUint32(52, 1, true);
    const bytes = new Uint8Array(net.buffer);
    const base64 = btoa(String.fromCharCode(...bytes));
    engine.applyChanges({
      type: "NODE_CHANGES",
      sessionID: 0,
      blobs: [base64],
      nodeChanges: [
        {
          guid: "1:600",
          phase: "CREATED",
          type: "VECTOR",
          parentIndex: { guid: "0:1", position: "~~" },
          size: { x: 10, y: 10 },
          vectorData: { vectorNetworkBlob: 0, normalizedSize: { x: 10, y: 10 } },
          fillPaints: [{ type: "GRADIENT_LINEAR", visible: true, stops: [], colorVar: { value: 1 } }],
        } as unknown as NodeChange,
      ],
    });
    engine.setSelection(["1:600"]);
    engine.command("DUPLICATE");
    const clip = engine.encodeSelection()!;
    const copy = clip.nodeChanges[0];
    expect(copy.type).toBe("VECTOR");
    expect(copy.vectorData?.normalizedSize).toEqual({ x: 10, y: 10 });
    expect(clip.blobs?.[copy.vectorData!.vectorNetworkBlob!]).toBe(base64);
    expect(copy.fillPaints?.[0]).toMatchObject({ type: "GRADIENT_LINEAR", visible: true, colorVar: { value: 1 } });
    engine.destroy();
  });
});

describe("engine (wasm, headless): E4 + E5", () => {
  it("the Pen, vector edit mode and its events; booleans and the other commands", async () => {
    const engine = await engineWithSample();
    const edits: EventOf<"VECTOR_EDIT">[] = [];
    engine.on("VECTOR_EDIT", (e) => edits.push(e));
    expect(engine.setTool("PEN")).toBe(Status.OK);
    const click = (x: number, y: number) => {
      engine.pointer(PointerType.DOWN, x, y, 0, 1, 0);
      engine.pointer(PointerType.UP, x, y, 0, 0, 0);
    };
    click(900, 100);
    click(1000, 100);
    click(1000, 200);
    click(900, 100);
    expect(engine.vectorEdit?.active).toBe(true);
    expect(engine.vectorEdit?.vertexCount).toBe(3);
    expect(engine.vectorEdit?.segmentCount).toBe(3);
    const ref = engine.vectorEdit!.ref!;
    const vector = engine.readNode(ref)!;
    expect(vector.type).toBe("VECTOR");
    expect(vector.vectorData?.normalizedSize).toEqual({ x: 100, y: 100 });
    // A vertex selected: the Points section's numbers, mirroring, end caps.
    click(1000, 100);
    expect(engine.vectorEdit?.selectedVertices).toEqual([1]);
    // x / y are in the vector's parent's space (it was drawn inside the sample's frame).
    const p0 = engine.vectorEdit!.points[0];
    expect(engine.command("VECTOR_SET_POINTS", { x: p0.x + 10, cornerRadius: 4 })).toBe(Status.OK);
    expect(engine.vectorEdit?.points[0]).toMatchObject({ x: p0.x + 10, y: p0.y, cornerRadius: 4 });
    expect(engine.command("VECTOR_SET_MIRRORING", { mirroring: "ANGLE" })).toBe(Status.OK);
    expect(engine.vectorEdit?.mirroring).toBe("ANGLE");
    expect(engine.setVectorEditTool("LASSO")).toBe(Status.OK);
    expect(engine.vectorEdit?.tool).toBe("LASSO");
    engine.endVectorEdit();
    expect(engine.vectorEdit).toBeNull();
    expect(edits.length).toBeGreaterThan(3);
    // A closed path has no ends; a line does.
    expect(engine.endCaps(ref)).toBeNull();
    engine.setTool("ARROW");
    engine.pointer(PointerType.DOWN, 900, 400, 0, 1, 0);
    engine.pointer(PointerType.MOVE, 950, 400, 0, 1, 0);
    engine.pointer(PointerType.MOVE, 1100, 400, 0, 1, 0);
    engine.pointer(PointerType.UP, 1100, 400, 0, 0, 0);
    const arrow = engine.getSelection().refs[0];
    expect(engine.endCaps(arrow)).toEqual({ start: "NONE", end: "ARROW_LINES" });
    // Booleans: two of the sample's layers.
    engine.setSelection(["1:5", "1:6"]);
    expect(engine.commandState("BOOLEAN_UNION") & CMD_ENABLED).toBeTruthy();
    expect(engine.command("BOOLEAN_UNION")).toBe(Status.OK);
    const union = engine.readNode(engine.getSelection().refs[0], { childIds: true })!;
    expect(union.type).toBe("BOOLEAN_OPERATION");
    expect(union.booleanOperation).toBe("UNION");
    expect(union.childIds).toEqual(["1:5", "1:6"]);
    expect(engine.command("FLATTEN")).toBe(Status.OK);
    expect(engine.readNode(union.guid)!.type).toBe("VECTOR");
    engine.destroy();
  });

  it("images: REQUEST_IMAGE once per hash, RGBA pixels answer it; gradient handles and their events", async () => {
    const engine = await engineWithSample();
    const hash = "0123456789abcdef0123456789abcdef01234567";
    const requests: string[] = [];
    engine.on("REQUEST_IMAGE", (e) => requests.push(e.hash));
    engine.applyChanges({
      type: "NODE_CHANGES",
      sessionID: 0,
      nodeChanges: [
        {
          guid: "1:700",
          phase: "CREATED",
          type: "ROUNDED_RECTANGLE",
          parentIndex: { guid: "0:1", position: "~~" },
          size: { x: 40, y: 40 },
          fillPaints: [{ type: "IMAGE", image: { hash }, imageScaleMode: "FILL", visible: true, opacity: 1 }],
        },
        {
          guid: "1:701",
          phase: "CREATED",
          type: "ROUNDED_RECTANGLE",
          parentIndex: { guid: "0:1", position: "~~~" },
          transform: { m00: 1, m01: 0, m02: 100, m10: 0, m11: 1, m12: 0 },
          size: { x: 100, y: 50 },
          fillPaints: [
            {
              type: "GRADIENT_LINEAR",
              stops: [
                { color: { r: 1, g: 0, b: 0, a: 1 }, position: 0 },
                { color: { r: 0, g: 0, b: 1, a: 1 }, position: 1 },
              ],
              transform: { m00: 1, m01: 0, m02: 0, m10: 0, m11: 1, m12: 0 },
              visible: true,
              opacity: 1,
            },
          ],
        },
      ],
    }, "load");
    engine.renderNow();
    engine.renderNow();
    expect(requests).toEqual([hash]);
    expect(engine.addImageRgba(hash, 2, 2, new Uint8Array(16).fill(255))).toBe(Status.OK);
    engine.renderNow();
    expect(engine.stats().images).toBe(1);  // headless: the recording device keeps a texture for it
    const pe: EventOf<"PAINT_EDIT">[] = [];
    engine.on("PAINT_EDIT", (e) => pe.push(e));
    expect(engine.startPaintEdit("1:701", { paints: "FILL", index: 0 })).toBe(Status.OK);
    expect(engine.paintEdit).toMatchObject({ active: true, ref: "1:701", paints: "FILL", index: 0 });
    expect(engine.setPaintEditStop(1)).toBe(Status.OK);
    expect(engine.paintEdit?.stop).toBe(1);
    engine.endPaintEdit();
    expect(engine.paintEdit).toBeNull();
    expect(engine.startPaintEdit("1:700", { paints: "FILL", index: 0 })).toBe(Status.E_INVALID);
    // Effects, masks, blend modes, layout guides read back as typed fields.
    engine.setProps(["1:701"], {
      effects: [{ type: "DROP_SHADOW", color: { r: 0, g: 0, b: 0, a: 0.25 }, offset: { x: 0, y: 4 }, radius: 4, visible: true }],
      blendMode: "MULTIPLY",
      layoutGrids: [{ type: "STRETCH", axis: "X", numSections: 12, gutterSize: 20, offset: 0, sectionSize: 10, visible: true, pattern: "STRIPES" }],
    });
    const n = engine.readNode("1:701")!;
    expect(n.effects?.[0]).toMatchObject({ type: "DROP_SHADOW", radius: 4, spread: 0, showShadowBehindNode: false });
    expect(n.blendMode).toBe("MULTIPLY");
    expect(n.layoutGrids?.[0]).toMatchObject({ numSections: 12, gutterSize: 20 });
    engine.destroy();
  });

  it("components (E6): derived sublayers by I-refs, overrides, properties, commands, componentInfo", async () => {
    const engine = await Engine.create(null, { sessionID: 1 });
    const id = (n: number) => ({ type: "SOLID", color: { r: n, g: 0, b: 0, a: 1 }, opacity: 1, visible: true });
    engine.load({
      type: "NODE_CHANGES",
      sessionID: 1,
      nodeChanges: [
        { guid: "0:0", phase: "CREATED", type: "DOCUMENT", name: "Document" },
        { guid: "0:1", phase: "CREATED", type: "CANVAS", name: "Page 1", parentIndex: { guid: "0:0", position: "!" } },
        {
          guid: "1:1", phase: "CREATED", type: "SYMBOL", name: "Button", parentIndex: { guid: "0:1", position: "!" }, size: { x: 100, y: 40 },
          componentPropDefs: [{ id: { sessionID: 1, localID: 50 }, name: "Show icon", type: "BOOL", initialValue: { boolValue: true } }],
        },
        {
          guid: "1:2", phase: "CREATED", type: "ROUNDED_RECTANGLE", name: "Icon", parentIndex: { guid: "1:1", position: "!" }, size: { x: 10, y: 10 },
          fillPaints: [id(0)],
          parameterConsumptionMap: { entries: [{ variableField: "VISIBLE", variableData: { dataType: "PROP_REF", resolvedDataType: "BOOLEAN", value: { propRefValue: { defId: { sessionID: 1, localID: 50 } } } } }] },
        },
        {
          guid: "1:3", phase: "CREATED", type: "INSTANCE", name: "Button", parentIndex: { guid: "0:1", position: "\"" }, size: { x: 100, y: 40 },
          transform: { m00: 1, m01: 0, m02: 200, m10: 0, m11: 1, m12: 0 }, symbolData: { symbolID: { sessionID: 1, localID: 1 }, symbolOverrides: [] },
        },
      ],
    } as Message);
    const instance = engine.readNode("1:3", { childIds: true })!;
    expect(instance.childIds).toEqual(["I1:3;1:2"]);
    expect(engine.readNode("I1:3;1:2")?.visible).toBe(true);
    const changed: EventOf<"COMPONENTS_CHANGED">[] = [];
    engine.on("COMPONENTS_CHANGED", (e) => changed.push(e));
    // An override through setProps on a derived ref; never in DOCUMENT_CHANGED.
    const docs: NodeChange[][] = [];
    engine.onDocumentChanged((c) => docs.push(c));
    expect(engine.setProps(["I1:3;1:2"], { fillPaints: [id(1)] })).toBe(Status.OK);
    expect(docs).toHaveLength(1);
    expect(docs[0].every((c) => !c.guid.startsWith("I"))).toBe(true);
    expect(engine.readNode("1:3")?.symbolData?.symbolOverrides?.[0]?.guidPath?.guids).toEqual([{ sessionID: 1, localID: 2 }]);
    // A property value.
    engine.setSelection(["1:3"]);
    expect(engine.command("SET_COMPONENT_PROPERTY", { prop: "Show icon", value: false })).toBe(Status.OK);
    expect(engine.readNode("I1:3;1:2")?.visible).toBe(false);
    const info = engine.componentInfo("1:3")!;
    expect(info.kind).toBe("INSTANCE");
    expect(info.main?.ref).toBe("1:1");
    expect(info.properties[0]).toMatchObject({ name: "Show icon", type: "BOOL", value: false, defaultValue: true, overridden: true, boundLayers: ["I1:3;1:2"] });
    expect(info.overrides).toEqual([{ ref: "I1:3;1:2", fields: ["fillPaints"] }]);
    expect(engine.componentInfo("I1:3;1:2")?.kind).toBe("INSTANCE_SUBLAYER");
    expect(changed.length).toBeGreaterThan(0);
    // Insert an instance; detach it.
    expect(engine.command("INSERT_INSTANCE", { main: "1:1", x: 500, y: 20 })).toBe(Status.OK);
    const inserted = engine.getSelection().refs[0];
    expect(engine.readNode(inserted)?.type).toBe("INSTANCE");
    expect(engine.commandState("DETACH_INSTANCE")).toBe(CMD_ENABLED);
    expect(engine.command("DETACH_INSTANCE")).toBe(Status.OK);
    expect(engine.readNode(inserted)?.type).toBe("FRAME");
    // Go to main and back.
    engine.setSelection(["1:3"]);
    expect(engine.command("GO_TO_MAIN_COMPONENT")).toBe(Status.OK);
    expect(engine.returnToInstance).toBe("1:3");
    expect(engine.getSelection().refs).toEqual(["1:1"]);
    engine.destroy();
  });
});

describe("engine (wasm, headless): variables, modes and styles (E6)", () => {
  it("collections, modes, variables, bindings, mode switches, styles, reads and events through the facade", async () => {
    const engine = await engineWithSample();
    const events: EngineEvent[] = [];
    engine.onAny((e) => events.push(e));
    const collection = engine.runCommand("CREATE_VARIABLE_COLLECTION", { name: "Theme" });
    expect(collection.status).toBe(Status.OK);
    const [set, light] = collection.created;
    const dark = engine.runCommand("ADD_VARIABLE_MODE", { collection: set, name: "Dark" }).created[0];
    const bg = engine.runCommand("CREATE_VARIABLE", { collection: set, type: "COLOR", name: "surface/bg", value: { r: 1, g: 0, b: 0, a: 1 } }).created[0];
    expect(engine.command("SET_VARIABLE_VALUE", { variable: bg, mode: dark, value: { r: 0, g: 0, b: 1, a: 1 } })).toBe(Status.OK);
    const radius = engine.runCommand("CREATE_VARIABLE", { collection: set, type: "FLOAT", name: "radius", value: 4 }).created[0];
    expect(engine.command("SET_VARIABLE_VALUE", { variable: radius, mode: dark, value: 20 })).toBe(Status.OK);
    expect(events.some((e) => e.type === "VARIABLES_CHANGED")).toBe(true);

    // Reads.
    const cols = engine.variableCollections();
    expect(cols).toHaveLength(1);
    expect(cols[0]).toMatchObject({ id: set, name: "Theme", defaultModeId: light, variableIds: [bg, radius] });
    expect(cols[0].modes.map((m) => m.name)).toEqual(["Mode 1", "Dark"]);
    const vars = engine.variables(set);
    expect(vars.map((v) => v.name)).toEqual(["surface/bg", "radius"]);
    expect(vars[0].valuesByMode[dark]).toEqual({ r: 0, g: 0, b: 1, a: 1 });
    expect(vars[1].resolvedValuesByMode[dark]).toBe(20);

    // Bind the card's fill and radius; the Desktop frame switches to Dark.
    engine.setSelection(["1:5"]);
    expect(engine.command("BIND_VARIABLE", { target: "fillPaints[0].color", variable: bg })).toBe(Status.OK);
    expect(engine.command("BIND_VARIABLE", { target: "CORNER_RADIUS", variable: radius })).toBe(Status.OK);
    expect(engine.readNode("1:5")?.fillPaints?.[0].color).toEqual({ r: 1, g: 0, b: 0, a: 1 });
    expect(engine.readNode("1:5")?.cornerRadius).toBe(4);
    expect(engine.command("SET_VARIABLE_MODE", { refs: ["1:1"], collection: set, mode: dark })).toBe(Status.OK);
    expect(engine.readNode("1:5")?.fillPaints?.[0].color).toEqual({ r: 0, g: 0, b: 1, a: 1 });
    expect(engine.readNode("1:5")?.cornerRadius).toBe(20);
    expect(engine.readNode("1:1")?.variableModeBySetMap?.entries).toHaveLength(1);
    expect(engine.variableModes("1:5")).toEqual([{ collectionId: set, explicitModeId: null, resolvedModeId: dark }]);
    expect(engine.boundVariables("1:5").map((b) => [b.target, b.variable])).toEqual([
      ["CORNER_RADIUS", radius],
      ["fillPaints[0].color", bg],
    ]);
    expect(engine.resolvedValue("1:5", "CORNER_RADIUS")).toBe(20);
    expect(engine.resolveVariable(bg)).toEqual({ r: 1, g: 0, b: 0, a: 1 });
    expect(engine.resolveVariable(bg, "1:5")).toEqual({ r: 0, g: 0, b: 1, a: 1 });

    // Aliases and composed colours; cycles are refused.
    const accent = engine.runCommand("CREATE_VARIABLE", { collection: set, type: "COLOR", name: "accent", value: { type: "VARIABLE_ALIAS", id: bg } }).created[0];
    expect(engine.command("SET_VARIABLE_VALUE", { variable: bg, value: { type: "VARIABLE_ALIAS", id: accent } })).toBe(Status.E_INVALID);
    const alpha = engine.runCommand("CREATE_VARIABLE", { collection: set, type: "FLOAT", name: "alpha", value: 50 }).created[0];
    const overlay = engine.runCommand("CREATE_VARIABLE", {
      collection: set,
      type: "COLOR",
      name: "overlay",
      value: { color: { type: "VARIABLE_ALIAS", id: accent }, opacity: { type: "VARIABLE_ALIAS", id: alpha } },
    }).created[0];
    expect(engine.variable(overlay)?.valuesByMode[light]).toEqual({
      color: { type: "VARIABLE_ALIAS", id: accent },
      opacity: { type: "VARIABLE_ALIAS", id: alpha },
    });
    expect(engine.resolveVariable(overlay)).toEqual({ r: 1, g: 0, b: 0, a: 0.5 });

    // A value edit is one DOCUMENT_CHANGED with the variable and the layer; undo restores both.
    const docs: NodeChange[][] = [];
    engine.onDocumentChanged((changes) => docs.push(changes));
    expect(engine.command("SET_VARIABLE_VALUE", { variable: bg, mode: dark, value: { r: 0, g: 1, b: 0, a: 1 } })).toBe(Status.OK);
    expect(docs).toHaveLength(1);
    expect(docs[0].map((c) => c.guid).sort()).toEqual([bg, "1:5"].sort());
    expect(engine.readNode("1:5")?.fillPaints?.[0].color).toEqual({ r: 0, g: 1, b: 0, a: 1 });
    expect(engine.undo()).toBe(true);
    expect(engine.readNode("1:5")?.fillPaints?.[0].color).toEqual({ r: 0, g: 0, b: 1, a: 1 });

    // Styles: a colour style from the header, applied; its users follow its edits.
    const style = engine.runCommand("CREATE_STYLE", { type: "FILL", name: "Brand/Dark", from: "1:2", apply: true }).created[0];
    expect(engine.command("APPLY_STYLE", { refs: ["1:4"], style })).toBe(Status.OK);
    expect(engine.styles("FILL")).toMatchObject([{ id: style, name: "Brand/Dark", styleType: "FILL", usageCount: 2 }]);
    expect(engine.styleUsage(style)).toBe(2);
    events.length = 0;
    expect(engine.setProps([style], { fillPaints: [{ type: "SOLID", color: { r: 1, g: 1, b: 0, a: 1 }, opacity: 1, visible: true }] })).toBe(Status.OK);
    expect(engine.readNode("1:4")?.fillPaints?.[0].color).toEqual({ r: 1, g: 1, b: 0, a: 1 });
    expect(engine.readNode("1:4")?.styleIdForFill).toEqual({ guid: { sessionID: 9, localID: Number(style.split(":")[1]) } });
    expect(events.some((e) => e.type === "STYLES_CHANGED" && e.styles.includes(style))).toBe(true);
    expect(engine.command("DETACH_STYLE", { refs: ["1:4"], target: "FILL" })).toBe(Status.OK);
    expect(engine.styleUsage(style)).toBe(1);

    // The document round-trips: a second engine loads it and resolves the same.
    const copy = await Engine.create(null, { sessionID: 10 });
    copy.load(engine.encodeDocument());
    expect(copy.variableCollections()).toEqual(engine.variableCollections());
    expect(copy.readNode("1:5")?.fillPaints?.[0].color).toEqual({ r: 0, g: 0, b: 1, a: 1 });
    copy.destroy();
    engine.destroy();
  });

  it("a mode switch over 10,000 bound layers", async () => {
    const engine = await Engine.create(null, { sessionID: 3 });
    const layers: NodeChange[] = [];
    const message: Message = {
      type: "NODE_CHANGES",
      sessionID: 0,
      nodeChanges: [
        { guid: "0:0", phase: "CREATED", type: "DOCUMENT", name: "Document" },
        { guid: "0:1", phase: "CREATED", type: "CANVAS", name: "Page 1", parentIndex: { guid: "0:0", position: "!" } },
        { guid: "0:2", phase: "CREATED", type: "CANVAS", name: "Internal Only Canvas", internalOnly: true, parentIndex: { guid: "0:0", position: "~" } },
        { guid: "2:1", phase: "CREATED", type: "FRAME", name: "Frame", parentIndex: { guid: "0:1", position: "!" }, size: { x: 4000, y: 4000 } },
      ],
    };
    engine.load(message);
    const [set] = engine.runCommand("CREATE_VARIABLE_COLLECTION", { name: "Theme" }).created;
    const dark = engine.runCommand("ADD_VARIABLE_MODE", { collection: set }).created[0];
    const bg = engine.runCommand("CREATE_VARIABLE", { collection: set, type: "COLOR", value: { r: 1, g: 0, b: 0, a: 1 } }).created[0];
    engine.command("SET_VARIABLE_VALUE", { variable: bg, mode: dark, value: { r: 0, g: 0, b: 1, a: 1 } });
    const [s, l] = bg.split(":").map(Number);
    for (let i = 0; i < 10000; i++)
      layers.push({
        guid: `4:${i + 1}`,
        phase: "CREATED",
        type: "ROUNDED_RECTANGLE",
        parentIndex: { guid: "2:1", position: String(i) },
        size: { x: 30, y: 30 },
        transform: { m00: 1, m01: 0, m02: (i % 100) * 40, m10: 0, m11: 1, m12: Math.floor(i / 100) * 40 },
        fillPaints: [
          { type: "SOLID", color: { r: 1, g: 0, b: 0, a: 1 }, colorVar: { value: { alias: { guid: { sessionID: s, localID: l } } }, dataType: "ALIAS", resolvedDataType: "COLOR" } },
        ],
      });
    expect(engine.applyChanges({ type: "NODE_CHANGES", sessionID: 3, nodeChanges: layers })).toBe(Status.OK);
    // Each switch, alternating; the best of a few (the first runs while the Wasm is still being tiered up).
    let best = Infinity;
    for (let i = 0; i < 6; i++) {
      const t0 = performance.now();
      expect(engine.command("SET_VARIABLE_MODE", { refs: ["2:1"], collection: set, mode: i % 2 ? "" : dark })).toBe(Status.OK);
      best = Math.min(best, performance.now() - t0);
    }
    expect(engine.readNode("4:10000")?.fillPaints?.[0].color).toEqual({ r: 1, g: 0, b: 0, a: 1 });
    console.log(`wasm: a mode switch over 10,000 bound layers: ${best.toFixed(1)} ms (its DOCUMENT_CHANGED and NODES_CHANGED included)`);
    expect(best).toBeLessThan(1000);
    engine.destroy();
  });
});

describe("engine (wasm, headless): libraries (E6)", () => {
  const LIB = "LibraryFileKey000001";
  const CONSUMER = "ConsumerFileKey00002";
  const base = (extra: NodeChange[]): Message => ({
    type: "NODE_CHANGES",
    sessionID: 0,
    nodeChanges: [
      { guid: "0:0", phase: "CREATED", type: "DOCUMENT", name: "Document" },
      { guid: "0:1", phase: "CREATED", type: "CANVAS", name: "Page 1", parentIndex: { guid: "0:0", position: "!" } },
      { guid: "0:2", phase: "CREATED", type: "CANVAS", name: "Internal Only Canvas", internalOnly: true, parentIndex: { guid: "0:0", position: "~" } },
      ...extra,
    ],
  });
  const solid = (r: number, g: number, b: number) => ({ type: "SOLID" as const, color: { r, g, b, a: 1 }, opacity: 1, visible: true });

  it("publish (keys, local assets, payloads), import as read-only copies, use, update as one undo step, cross-file paste", async () => {
    // The library: a main Button (Background + Label) and its instance; a collection with Brand, a colour style bound to it.
    const lib = await Engine.create(null, { sessionID: 1 });
    lib.load(
      base([
        { guid: "1:10", phase: "CREATED", type: "SYMBOL", name: "Button", parentIndex: { guid: "0:1", position: "!" }, size: { x: 120, y: 40 } },
        { guid: "1:11", phase: "CREATED", type: "ROUNDED_RECTANGLE", name: "Background", parentIndex: { guid: "1:10", position: "!" }, size: { x: 120, y: 40 }, fillPaints: [solid(0.5, 0.5, 0.5)] },
        { guid: "1:12", phase: "CREATED", type: "ROUNDED_RECTANGLE", name: "Label", parentIndex: { guid: "1:10", position: "\"" }, size: { x: 60, y: 20 }, fillPaints: [solid(0, 0, 0)] },
        {
          guid: "1:40", phase: "CREATED", type: "INSTANCE", name: "Button", parentIndex: { guid: "0:1", position: "\"" }, size: { x: 120, y: 40 },
          transform: { m00: 1, m01: 0, m02: 0, m10: 0, m11: 1, m12: 200 }, symbolData: { symbolID: { sessionID: 1, localID: 10 }, symbolOverrides: [] },
        },
      ]),
    );
    lib.setFileKey(LIB);
    const [set] = lib.runCommand("CREATE_VARIABLE_COLLECTION", { name: "Theme" }).created;
    const dark = lib.runCommand("ADD_VARIABLE_MODE", { collection: set, name: "Dark" }).created[0];
    const brand = lib.runCommand("CREATE_VARIABLE", { collection: set, type: "COLOR", name: "Brand", value: { r: 1, g: 0, b: 0, a: 1 } }).created[0];
    expect(lib.command("SET_VARIABLE_VALUE", { variable: brand, mode: dark, value: { r: 0, g: 0, b: 1, a: 1 } })).toBe(Status.OK);
    const style = lib.runCommand("CREATE_STYLE", { type: "FILL", name: "Primary", from: "1:11", apply: true }).created[0];
    expect(lib.command("BIND_VARIABLE", { refs: [style], target: "fillPaints[0].color", variable: brand })).toBe(Status.OK);
    expect(lib.readNode("1:11")?.fillPaints?.[0].color).toEqual({ r: 1, g: 0, b: 0, a: 1 });

    // Keys (a SYSTEM change: no undo step), local assets.
    const keys = lib.ensureAssetKeys();
    expect(keys).toHaveLength(4);
    const button = keys.find((k) => k.id === "1:10")!.key;
    expect(button).toMatch(/^[0-9a-f]{40}$/);
    expect(lib.undo()).toBe(true); // the binding, not the keys
    expect(lib.readNode("1:10")?.key).toBe(button);
    expect(lib.redo()).toBe(true);
    expect(lib.ensureAssetKeys(["1:10"])).toEqual([{ id: "1:10", key: button }]);
    const local = lib.localAssets();
    const buttonInfo = local.find((a) => a.key === button)!;
    expect(buttonInfo).toMatchObject({ kind: "COMPONENT", name: "Button", hiddenFromPublishing: false, softDeleted: false, publishedVersion: null, containingFrame: { pageId: "0:1", pageName: "Page 1" } });
    expect(buttonInfo.versionHash).toMatch(/^[0-9a-f]{40}$/);
    expect(buttonInfo.dependencies).toHaveLength(3); // Primary, Brand, Theme
    expect(local.find((a) => a.id === brand)).toMatchObject({ kind: "VARIABLE", resolvedType: "COLOR", collectionId: set, containingFrame: null });
    expect(local.find((a) => a.id === style)).toMatchObject({ kind: "STYLE", styleType: "FILL" });

    // Payloads (through the store's kiwi and back), then publishedVersion.
    const encoded = lib.encodeAssets([button]);
    expect(encoded.assets.map((a) => [a.id, a.dependencyOnly])).toEqual([
      ["1:10", false],
      [style, true],
      [brand, true],
      [set, true],
    ]);
    expect(encoded.assets[0].message.nodeChanges[0]).toMatchObject({ guid: "1:10", key: button, version: buttonInfo.versionHash });
    const stored = encoded.assets.map((a) => messageToEngine(decodeKiwi(encodeKiwi(messageToKiwi(a.message)))));
    expect(lib.markPublished(encoded.assets.map((a) => ({ key: a.key, versionHash: a.versionHash })))).toBe(Status.OK);
    expect(lib.localAssets().find((a) => a.key === button)?.publishedVersion).toBe(buttonInfo.versionHash);

    // The consumer imports them: read-only copies under the internal canvas.
    const con = await Engine.create(null, { sessionID: 1 });
    con.load(base([{ guid: "1:1", phase: "CREATED", type: "FRAME", name: "Screen", parentIndex: { guid: "0:1", position: "!" }, size: { x: 400, y: 400 } }]));
    con.setFileKey(CONSUMER);
    const imported = con.importLibraryAssets(stored, { libraryKey: LIB });
    expect(imported.status).toBe(Status.OK);
    const copy = imported.assets.find((a) => a.key === button)!;
    expect(copy).toMatchObject({ kind: "COMPONENT", libraryKey: LIB, version: buttonInfo.versionHash, created: true, updated: false });
    expect(con.readNode(copy.id)).toMatchObject({ sourceLibraryKey: LIB, key: button, publishID: { sessionID: 1, localID: 10 }, parentIndex: { guid: "0:2" } });
    expect(con.setProps([copy.id], { name: "Mine" })).toBe(Status.E_READONLY);
    expect(con.variableCollections()).toEqual([]);
    expect(con.variableCollections({ includeRemote: true })).toMatchObject([{ name: "Theme", remote: true, libraryKey: LIB }]);
    expect(con.variables(undefined, { includeRemote: true })).toMatchObject([{ name: "Brand", remote: true, libraryKey: LIB }]);
    expect(con.styles()).toEqual([]);
    const remoteStyle = con.styles(undefined, { includeRemote: true });
    expect(remoteStyle).toMatchObject([{ name: "Primary", remote: true, libraryKey: LIB }]);
    expect(con.command("RENAME_VARIABLE", { variable: con.variables(undefined, { includeRemote: true })[0].id, name: "x" })).toBe(Status.E_READONLY);

    // An instance of the copy; a remote style on a frame.
    expect(con.command("INSERT_INSTANCE", { main: copy.id, x: 100, y: 100 })).toBe(Status.OK);
    const inst = con.getSelection().refs[0];
    const info = con.componentInfo(inst)!;
    expect(info.main).toMatchObject({ ref: copy.id, remote: { libraryKey: LIB, key: button, version: buttonInfo.versionHash }, copied: false });
    expect(info.canPush).toBe(false);
    const bg = con.readNode(inst, { childIds: true })!.childIds![0];
    expect(con.readNode(bg)?.fillPaints?.[0].color).toEqual({ r: 1, g: 0, b: 0, a: 1 });
    expect(con.setProps([`${inst.replace(/^/, "I")};1:12`], { fillPaints: [solid(1, 1, 1)] })).toBe(Status.OK);
    expect(con.command("APPLY_STYLE", { refs: ["1:1"], style: remoteStyle[0].id })).toBe(Status.OK);
    expect(con.readNode("1:1")?.fillPaints?.[0].color).toEqual({ r: 1, g: 0, b: 0, a: 1 });
    expect(con.libraryUsage().find((u) => u.key === button)).toMatchObject({ kind: "COMPONENT", libraryKey: LIB, usageCount: 1, publishID: "1:10" });

    // The library changes Brand and Background; the consumer accepts the update — one undo step, the override kept.
    expect(lib.command("SET_VARIABLE_VALUE", { variable: brand, value: { r: 0, g: 1, b: 0, a: 1 } })).toBe(Status.OK);
    expect(lib.setProps(["1:11"], { opacity: 0.5 })).toBe(Status.OK);
    const v2 = lib.encodeAssets([button]);
    expect(v2.assets[0].versionHash).not.toBe(buttonInfo.versionHash);
    const docs: NodeChange[][] = [];
    con.onDocumentChanged((c) => docs.push(c));
    const updated = con.applyLibraryUpdate(v2.assets.map((a) => a.message), { libraryKey: LIB });
    expect(updated.status).toBe(Status.OK);
    expect(updated.assets.find((a) => a.key === button)).toMatchObject({ id: copy.id, updated: true, version: v2.assets[0].versionHash });
    expect(docs).toHaveLength(1);
    expect(con.readNode(bg)?.opacity).toBe(0.5);
    expect(con.readNode(bg)?.fillPaints?.[0].color).toEqual({ r: 0, g: 1, b: 0, a: 1 });
    expect(con.readNode("1:1")?.fillPaints?.[0].color).toEqual({ r: 0, g: 1, b: 0, a: 1 });
    expect(con.readNode(`I${inst};1:12`)?.fillPaints?.[0].color).toEqual({ r: 1, g: 1, b: 1, a: 1 });
    expect(con.undo()).toBe(true);
    expect(con.readNode(bg)?.opacity).toBe(1);
    expect(con.readNode("1:1")?.fillPaints?.[0].color).toEqual({ r: 1, g: 0, b: 0, a: 1 });
    expect(con.redo()).toBe(true);

    // Cross-file paste: an instance of the published main pastes as an instance of the same copy.
    lib.setSelection(["1:40"]);
    const clip = lib.encodeSelection()!;
    expect(clip.pasteFileKey).toBe(LIB);
    expect(clip.nodeChanges.length).toBeGreaterThan(1); // the instance, then what it references
    expect(lib.encodeSelection({ cut: true })?.isCut).toBe(true);
    con.setSelection([]);
    expect(con.paste(clip, { inPlace: true })).toBe(1);
    expect(con.readNode(con.getSelection().refs[0])?.symbolData?.symbolID).toEqual(con.readNode(inst)?.symbolData?.symbolID);
    expect(con.libraryUsage().find((u) => u.key === button)?.usageCount).toBe(2);
    lib.destroy();
    con.destroy();
  });

  it("review fixes: asNew copies, every copy updated, system / restore applies, removed assets, images, BOOLEAN types", async () => {
    const IMAGE = "3333333333333333333333333333333333333333";
    const lib = await Engine.create(null, { sessionID: 1 });
    lib.load(
      base([
        { guid: "1:10", phase: "CREATED", type: "SYMBOL", name: "Button", parentIndex: { guid: "0:1", position: "!" }, size: { x: 120, y: 40 } },
        {
          guid: "1:11", phase: "CREATED", type: "ROUNDED_RECTANGLE", name: "Background", parentIndex: { guid: "1:10", position: "!" }, size: { x: 120, y: 40 },
          fillPaints: [{ type: "IMAGE", image: { hash: IMAGE }, imageScaleMode: "FILL", opacity: 1, visible: true } as never],
        },
        { guid: "1:12", phase: "CREATED", type: "ROUNDED_RECTANGLE", name: "Label", parentIndex: { guid: "1:10", position: "\"" }, size: { x: 60, y: 20 }, fillPaints: [solid(0, 0, 0)], opacity: 0.75 },
      ]),
    );
    lib.setFileKey(LIB);
    const [set] = lib.runCommand("CREATE_VARIABLE_COLLECTION", { name: "Flags" }).created;
    const flag = lib.runCommand("CREATE_VARIABLE", { collection: set, type: "BOOLEAN", name: "On" }).created[0];
    const keys = lib.ensureAssetKeys();
    const button = keys.find((k) => k.id === "1:10")!.key;
    const flagKey = keys.find((k) => k.id === flag)!.key;
    const v1 = lib.encodeAssets([button, flagKey]);
    expect(v1.assets[0].images).toEqual([IMAGE]);
    expect(v1.images).toEqual([IMAGE]);
    expect(v1.assets.find((a) => a.key === flagKey)?.message.nodeChanges[0]).toMatchObject({ variableResolvedType: "BOOLEAN" });
    expect(lib.markPublished(v1.assets.map((a) => ({ key: a.key, versionHash: a.versionHash })))).toBe(Status.OK);
    const con = await Engine.create(null, { sessionID: 1 });
    con.load(base([{ guid: "1:1", phase: "CREATED", type: "FRAME", name: "Screen", parentIndex: { guid: "0:1", position: "!" }, size: { x: 400, y: 400 } }]));
    con.setFileKey(CONSUMER);
    const messages = (v: typeof v1) => v.assets.map((a) => messageToEngine(decodeKiwi(encodeKiwi(messageToKiwi(a.message)))));
    const imported = con.importLibraryAssets(messages(v1), { libraryKey: LIB });
    expect(imported.images).toEqual([IMAGE]);
    const oldCopy = imported.assets.find((a) => a.key === button)!.id;
    expect(con.readNode(imported.assets.find((a) => a.key === flagKey)!.id)).toMatchObject({ variableResolvedType: "BOOLEAN" });
    expect(con.command("INSERT_INSTANCE", { main: oldCopy, x: 0, y: 0 })).toBe(Status.OK);
    const a = con.getSelection().refs[0];
    expect(con.command("INSERT_INSTANCE", { main: oldCopy, x: 0, y: 100 })).toBe(Status.OK);
    const b = con.getSelection().refs[0];
    const saved = con.encodeDocument();

    // v2; Update selected instance on `a`: a new, complete copy (asNew) and a swap, one step.
    expect(lib.setProps(["1:12"], { opacity: 0.5 })).toBe(Status.OK);
    const v2 = lib.encodeAssets([button]);
    expect(con.txnBegin("Update instance")).toBe(Status.OK);
    const fresh = con.importLibraryAssets(messages(v2), { libraryKey: LIB, asNew: true });
    const newCopy = fresh.assets.find((x) => x.key === button)!;
    expect(newCopy).toMatchObject({ created: true, version: v2.assets[0].versionHash });
    expect(newCopy.id).not.toBe(oldCopy);
    expect(con.readNode(newCopy.id, { childIds: true })?.childIds).toHaveLength(2);
    expect(con.command("SWAP_INSTANCE", { main: newCopy.id, ref: a })).toBe(Status.OK);
    expect(con.txnCommit()).toBe(Status.OK);
    expect(con.readNode(`I${a};1:12`)?.opacity).toBe(0.5);
    expect(con.readNode(`I${b};1:12`)?.opacity).toBe(0.75);
    expect(con.libraryUsage().filter((u) => u.key === button).map((u) => u.id).sort()).toEqual([oldCopy, newCopy.id].sort());
    // Update: every copy of the key (the old one too).
    const upd = con.applyLibraryUpdate(messages(v2), { libraryKey: LIB, keys: [button] });
    expect(upd.assets.filter((x) => x.key === button).map((x) => [x.id, x.updated])).toEqual(
      expect.arrayContaining([[oldCopy, true], [newCopy.id, false]]),
    );
    expect(con.readNode(`I${b};1:12`)?.opacity).toBe(0.5);
    // `copies` restricts it.
    expect(lib.setProps(["1:12"], { opacity: 0.25 })).toBe(Status.OK);
    const v3 = lib.encodeAssets([button]);
    con.applyLibraryUpdate(messages(v3), { libraryKey: LIB, copies: [newCopy.id] });
    expect(con.readNode(`I${a};1:12`)?.opacity).toBe(0.25);
    expect(con.readNode(`I${b};1:12`)?.opacity).toBe(0.5);

    // "system": emitted, not an undo step, never into a copy.
    const kinds: string[] = [];
    con.onDocumentChanged((_c, event) => kinds.push(event.kind));
    expect(
      con.applyChanges({ type: "NODE_CHANGES", sessionID: 1, nodeChanges: [{ guid: "1:1", name: "Sys" }, { guid: oldCopy, name: "x" }] }, "system"),
    ).toBe(Status.OK);
    expect(kinds).toEqual(["SYSTEM"]);
    expect(con.readNode("1:1")?.name).toBe("Sys");
    expect(con.readNode(oldCopy)?.name).toBe("Button");
    expect(con.txnBegin("open")).toBe(Status.OK);
    expect(con.applyChanges({ type: "NODE_CHANGES", sessionID: 1, nodeChanges: [{ guid: "1:1", name: "Sys 2" }] }, "system")).toBe(Status.E_BUSY);
    con.txnCancel();
    // "restore": the saved version's state, library copies included, one undo step.
    const now = new Map(con.encodeDocument().nodeChanges.map((n) => [n.guid, n]));
    const diff: NodeChange[] = [];
    for (const n of saved.nodeChanges) {
      const cur = now.get(n.guid);
      if (!cur || JSON.stringify(cur) !== JSON.stringify(n)) diff.push({ ...n, phase: cur ? undefined : "CREATED" } as NodeChange);
      now.delete(n.guid);
    }
    for (const gone of [...now.keys()].reverse()) diff.push({ guid: gone, phase: "REMOVED" } as NodeChange);
    expect(con.applyChanges({ type: "NODE_CHANGES", sessionID: 1, nodeChanges: diff }, "restore")).toBe(Status.OK);
    expect(kinds.at(-1)).toBe("USER");
    expect(con.readNode(oldCopy)?.version).toBe(v1.assets[0].versionHash);
    expect(con.readNode(newCopy.id)).toBeNull();
    // (the saved state holds every field this diff restores: Label's opacity is not the default)
    expect(con.readNode(`I${a};1:12`)?.opacity).toBe(0.75);
    expect(con.readNode(`I${b};1:12`)?.opacity).toBe(0.75);
    expect(con.readNode(a)?.symbolData?.symbolOverrides ?? []).toEqual([]);
    expect(con.readNode(b)?.symbolData?.symbolOverrides ?? []).toEqual([]);

    // A removed asset: versionHash null clears publishedVersion.
    expect(lib.markPublished([{ key: button, versionHash: null }])).toBe(Status.OK);
    expect(lib.localAssets().find((x) => x.key === button)?.publishedVersion).toBeNull();
    lib.destroy();
    con.destroy();
  });

  it("review fixes, round 2: hidden dependencies in the hash, unchanged pastes at the published version, preferred instances per library", async () => {
    const symbolOf = (localID: number) => ({ symbolID: { sessionID: 1, localID }, symbolOverrides: [] });
    const lib = await Engine.create(null, { sessionID: 1 });
    lib.load(
      base([
        { guid: "1:1", phase: "CREATED", type: "SYMBOL", name: "Icon", parentIndex: { guid: "0:1", position: "!" }, size: { x: 24, y: 24 } },
        { guid: "1:2", phase: "CREATED", type: "ROUNDED_RECTANGLE", name: "Glyph", parentIndex: { guid: "1:1", position: "!" }, size: { x: 16, y: 16 }, fillPaints: [solid(0, 0, 0)] },
        { guid: "1:20", phase: "CREATED", type: "SYMBOL", name: "_Private", parentIndex: { guid: "0:1", position: "\"" }, size: { x: 10, y: 10 } },
        { guid: "1:10", phase: "CREATED", type: "SYMBOL", name: "Button", parentIndex: { guid: "0:1", position: "#" }, size: { x: 120, y: 40 } },
        { guid: "1:11", phase: "CREATED", type: "ROUNDED_RECTANGLE", name: "Background", parentIndex: { guid: "1:10", position: "!" }, size: { x: 120, y: 40 }, fillPaints: [solid(0.5, 0.5, 0.5)] },
        { guid: "1:12", phase: "CREATED", type: "ROUNDED_RECTANGLE", name: "Label", parentIndex: { guid: "1:10", position: "\"" }, size: { x: 60, y: 20 }, fillPaints: [solid(0, 0, 0)] },
        { guid: "1:13", phase: "CREATED", type: "INSTANCE", name: "Icon", parentIndex: { guid: "1:10", position: "#" }, size: { x: 24, y: 24 }, symbolData: symbolOf(1) },
        { guid: "1:40", phase: "CREATED", type: "INSTANCE", name: "Button", parentIndex: { guid: "0:1", position: "$" }, size: { x: 120, y: 40 }, symbolData: symbolOf(10) },
      ]),
    );
    lib.setFileKey(LIB);
    // An instance-swap property preferring Icon and _Private; Label bound to a hidden variable.
    expect(lib.command("ADD_COMPONENT_PROPERTY", { ref: "1:10", name: "Icon", type: "INSTANCE_SWAP", defaultValue: "1:1", preferredValues: ["1:1", "1:20"] })).toBe(Status.OK);
    const [hidden, mode] = lib.runCommand("CREATE_VARIABLE_COLLECTION", { name: "_Tokens" }).created;
    const secret = lib.runCommand("CREATE_VARIABLE", { collection: hidden, type: "COLOR", name: "Secret", value: { r: 1, g: 0, b: 0, a: 1 } }).created[0];
    expect(lib.command("BIND_VARIABLE", { refs: ["1:12"], target: "fillPaints[0].color", variable: secret })).toBe(Status.OK);
    const keys = lib.ensureAssetKeys();
    const keyOf = (id: string) => keys.find((k) => k.id === id)!.key;
    const button = keyOf("1:10");
    const v1 = lib.encodeAssets([button]);
    expect(v1.assets.find((a) => a.id === secret)?.dependencyOnly).toBe(true);
    expect(lib.markPublished(v1.assets.map((a) => ({ key: a.key, versionHash: a.versionHash })))).toBe(Status.OK);
    const published = v1.assets[0].versionHash;

    // Unchanged since the publish: pasted elsewhere (the clipboard's JSON), its copy is at exactly the published
    // version — though _Private, a preferred instance, doesn't come along — so no update is pending.
    lib.setSelection(["1:40"]);
    const clip = JSON.parse(JSON.stringify(lib.encodeSelection()!)) as Message;
    expect(clip.nodeChanges.some((n) => n.guid === "1:20")).toBe(false);
    const con = await Engine.create(null, { sessionID: 1 });
    con.load(base([{ guid: "1:1", phase: "CREATED", type: "FRAME", name: "Screen", parentIndex: { guid: "0:1", position: "!" }, size: { x: 400, y: 400 } }]));
    con.setFileKey(CONSUMER);
    expect(con.paste(clip, { inPlace: true })).toBe(1);
    const pasted = con.getSelection().refs[0];
    expect(con.libraryUsage().find((u) => u.key === button)?.version).toBe(published);
    // Its preferred instances: Icon's copy here — never this file's 1:1 (the Screen frame).
    const iconCopy = con.libraryUsage().find((u) => u.key === keyOf("1:1"))!.id;
    expect(con.componentInfo(pasted)!.properties.find((p) => p.name === "Icon")?.preferredValues).toEqual([iconCopy]);

    // The hidden variable's value: Button is modified (the publish lists it); the update brings the new colour.
    expect(lib.command("SET_VARIABLE_VALUE", { variable: secret, mode, value: { r: 0, g: 1, b: 0, a: 1 } })).toBe(Status.OK);
    const now = lib.localAssets().find((a) => a.key === button)!;
    expect(now.versionHash).not.toBe(now.publishedVersion);
    const v2 = lib.encodeAssets([button]);
    expect(v2.assets[0].versionHash).toBe(now.versionHash);
    expect(con.readNode(`I${pasted};1:12`)?.fillPaints?.[0].color).toEqual({ r: 1, g: 0, b: 0, a: 1 });
    expect(con.applyLibraryUpdate(v2.assets.map((a) => a.message), { libraryKey: LIB }).status).toBe(Status.OK);
    expect(con.readNode(`I${pasted};1:12`)?.fillPaints?.[0].color).toEqual({ r: 0, g: 1, b: 0, a: 1 });

    // A duplicated library (same keys, another FileKey): each Button copy's preferred Icon is its own library's.
    const DUP = "DuplicatedLibKey0007";
    const dup = await Engine.create(null, { sessionID: 1 });
    dup.load(lib.encodeDocument());
    dup.setFileKey(DUP);
    expect(con.importLibraryAssets(dup.encodeAssets([button]).assets.map((a) => a.message), { libraryKey: DUP }).status).toBe(Status.OK);
    const usage = con.libraryUsage();
    const copyIn = (library: string, key: string) => usage.find((u) => u.libraryKey === library && u.key === key)!.id;
    for (const library of [LIB, DUP]) {
      expect(con.command("INSERT_INSTANCE", { main: copyIn(library, button), x: 0, y: 0 })).toBe(Status.OK);
      const info = con.componentInfo(con.getSelection().refs[0])!;
      expect(info.properties.find((p) => p.name === "Icon")?.preferredValues).toEqual([copyIn(library, keyOf("1:1"))]);
    }
    lib.destroy();
    dup.destroy();
    con.destroy();
  });
});
