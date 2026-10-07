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
