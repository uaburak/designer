/**
 * A synthetic file for the preview checks, made by the real engine (headless, Node): two pages; a "Card" frame in
 * auto layout whose fill is bound to a variable (Colors › Surface), with a "Title" in Inter Bold set as the text style
 * "Heading 1", an image-filled "Photo" and a "Caption" in Inter Italic (a face the viewer doesn't ship: drawn from its stored outlines); a "Badge"
 * component and an instance of it. Returns the engine's derived kiwi snapshot (`encodeDocumentKiwi({derived: true})`)
 * and the image, as the editor's Share flow would hand them to the store.
 */
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { deflateSync } from "node:zlib";
import { crc32 } from "@shared/fig/crc32";
import { Engine } from "@/engine/Engine";
import { BUNDLED_FACES, fonts } from "@/engine/fonts";
import { loadEngine } from "@/engine/loadEngine";
import type { Color, Message, Paint } from "@/engine/codec";

const rgb = (hex: number, a = 1): Color => ({ r: ((hex >> 16) & 255) / 255, g: ((hex >> 8) & 255) / 255, b: (hex & 255) / 255, a });
const solid = (hex: number): Paint => ({ type: "SOLID", color: rgb(hex), opacity: 1, visible: true });
const at = (x: number, y: number) => ({ m00: 1, m01: 0, m02: x, m10: 0, m11: 1, m12: y });

/** A w × h PNG of two colour bands (a real file the browser decodes). */
export function bandsPng(w: number, h: number, top: number, bottom: number): Uint8Array {
  const raw = new Uint8Array(h * (1 + w * 3));
  for (let y = 0; y < h; y++) {
    const c = y < h / 2 ? top : bottom;
    raw[y * (1 + w * 3)] = 0;
    for (let x = 0; x < w; x++) raw.set([(c >> 16) & 255, (c >> 8) & 255, c & 255], y * (1 + w * 3) + 1 + x * 3);
  }
  const chunk = (type: string, data: Uint8Array) => {
    const out = new Uint8Array(12 + data.length);
    const view = new DataView(out.buffer);
    view.setUint32(0, data.length);
    for (let i = 0; i < 4; i++) out[4 + i] = type.charCodeAt(i);
    out.set(data, 8);
    view.setUint32(8 + data.length, crc32(out.subarray(4, 8 + data.length)) >>> 0);
    return out;
  };
  const ihdr = new Uint8Array(13);
  const v = new DataView(ihdr.buffer);
  v.setUint32(0, w);
  v.setUint32(4, h);
  ihdr.set([8, 2, 0, 0, 0], 8);
  const parts = [new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk("IHDR", ihdr), chunk("IDAT", new Uint8Array(deflateSync(raw))), chunk("IEND", new Uint8Array())];
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.length;
  }
  return out;
}

const fontFile = (name: string) => new Uint8Array(readFileSync(fileURLToPath(new URL(`../../renderer/src/engine/fonts/${name}`, import.meta.url))));

let started: Promise<unknown> | null = null;

/** The engine's Wasm in Node (its web glue looks up `window` and `document` when it starts). */
export function startHeadlessEngine(): Promise<unknown> {
  if (started) return started;
  const g = globalThis as Record<string, unknown>;
  g.window ??= globalThis;
  g.document ??= { querySelector: () => null };
  const bytes = readFileSync(fileURLToPath(new URL("../../renderer/src/engine/wasm/engine.wasm", import.meta.url)));
  started = loadEngine({ wasmBinary: bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength), printErr: () => {} });
  fonts.setSource({
    list: async () => BUNDLED_FACES,
    read: async () => fontFile("Inter-3.19.ttf"),
  });
  return started;
}

export interface SyntheticPreview {
  snapshot: Uint8Array;
  image: { sha1: string; bytes: Uint8Array };
}

export async function syntheticPreview(): Promise<SyntheticPreview> {
  await startHeadlessEngine();
  const png = bandsPng(64, 32, 0xff24bd, 0x14ae5c);
  const sha1 = createHash("sha1").update(png).digest("hex");
  const hash = Array.from(Buffer.from(sha1, "hex"));
  const doc: Message = {
    type: "NODE_CHANGES",
    sessionID: 0,
    nodeChanges: [
      { guid: "0:0", phase: "CREATED", type: "DOCUMENT", name: "Document" },
      { guid: "0:1", phase: "CREATED", type: "CANVAS", name: "Page 1", parentIndex: { guid: "0:0", position: "!" }, backgroundColor: rgb(0xf5f5f5), backgroundEnabled: true },
      { guid: "0:3", phase: "CREATED", type: "CANVAS", name: "Second page", parentIndex: { guid: "0:0", position: "#" }, backgroundColor: rgb(0xf5f5f5), backgroundEnabled: true },
      { guid: "0:2", phase: "CREATED", type: "CANVAS", name: "Internal Only Canvas", internalOnly: true, visible: false, parentIndex: { guid: "0:0", position: "~" } },
      {
        guid: "1:1", phase: "CREATED", type: "FRAME", name: "Card", parentIndex: { guid: "0:1", position: "!" }, size: { x: 320, y: 10 }, transform: at(0, 0),
        stackMode: "VERTICAL", stackSpacing: 8, stackHorizontalPadding: 24, stackVerticalPadding: 16, stackPaddingRight: 24, stackPaddingBottom: 16,
        stackPrimarySizing: "RESIZE_TO_FIT", stackCounterSizing: "FIXED", cornerRadius: 8,
        fillPaints: [solid(0xffffff)], strokePaints: [solid(0xd9d9d9)], strokeWeight: 1, strokeAlign: "INSIDE",
        effects: [{ type: "DROP_SHADOW", color: rgb(0x000000, 0.25), offset: { x: 0, y: 4 }, radius: 4, spread: 0, visible: true, blendMode: "NORMAL" }],
        // Dev Mode: marked "Ready for dev".
        ...({ sectionStatusInfo: { status: "BUILD", lastUpdateUnixTimestamp: 1_760_000_000 } } as object),
      },
      {
        guid: "1:2", phase: "CREATED", type: "TEXT", name: "Title", parentIndex: { guid: "1:1", position: "!" }, size: { x: 10, y: 10 }, transform: at(24, 16),
        textData: { characters: "Hello preview" }, textAutoResize: "WIDTH_AND_HEIGHT", fontName: { family: "Inter", style: "Bold", postscript: "" }, fontSize: 24,
        lineHeight: { value: 30, units: "PIXELS" }, fillPaints: [solid(0x231f20)],
        // An annotation with a note and a pinned property.
        ...({ annotations: [{ label: "<p>Use the <b>brand</b> font</p>", properties: [{ type: "FONT_SIZE" }] }] } as object),
      },
      {
        guid: "1:3", phase: "CREATED", type: "ROUNDED_RECTANGLE", name: "Photo", parentIndex: { guid: "1:1", position: "\"" }, size: { x: 272, y: 120 }, transform: at(24, 54),
        cornerRadius: 4, fillPaints: [{ type: "IMAGE", visible: true, opacity: 1, image: { hash }, imageScaleMode: "FILL", originalImageWidth: 64, originalImageHeight: 32 }],
      },
      {
        guid: "1:4", phase: "CREATED", type: "TEXT", name: "Caption", parentIndex: { guid: "1:1", position: "#" }, size: { x: 10, y: 10 }, transform: at(24, 182),
        textData: { characters: "Set in Inter Italic" }, textAutoResize: "WIDTH_AND_HEIGHT", fontName: { family: "Inter", style: "Italic", postscript: "" }, fontSize: 14,
        fillPaints: [solid(0x757575)],
      },
      { guid: "1:10", phase: "CREATED", type: "FRAME", name: "Other", parentIndex: { guid: "0:1", position: "\"" }, size: { x: 200, y: 200 }, transform: at(400, 0), fillPaints: [solid(0x0d99ff)] },
      // An icon in it (Dev Mode's Assets detect it).
      { guid: "1:11", phase: "CREATED", type: "STAR", name: "Icon/Star", parentIndex: { guid: "1:10", position: "!" }, size: { x: 24, y: 24 }, transform: at(16, 16), fillPaints: [solid(0xffffff)], ...({ count: 5, starInnerScale: 0.382 } as object) },
      {
        guid: "1:20", phase: "CREATED", type: "SYMBOL", name: "Badge", parentIndex: { guid: "0:1", position: "#" }, size: { x: 10, y: 10 }, transform: at(0, 400),
        stackMode: "HORIZONTAL", stackSpacing: 4, stackHorizontalPadding: 12, stackVerticalPadding: 4, stackPaddingRight: 12, stackPaddingBottom: 4, stackCounterSizing: "RESIZE_TO_FIT",
        cornerRadius: 12, fillPaints: [solid(0x9747ff)],
      },
      { guid: "1:21", phase: "CREATED", type: "TEXT", name: "Label", parentIndex: { guid: "1:20", position: "!" }, size: { x: 10, y: 10 }, textData: { characters: "New" }, textAutoResize: "WIDTH_AND_HEIGHT", fontName: { family: "Inter", style: "Medium", postscript: "" }, fontSize: 12, fillPaints: [solid(0xffffff)] },
      { guid: "1:30", phase: "CREATED", type: "INSTANCE", name: "Badge", parentIndex: { guid: "0:1", position: "$" }, size: { x: 10, y: 10 }, transform: at(120, 400), symbolData: { symbolID: { sessionID: 1, localID: 20 } } },
      { guid: "1:40", phase: "CREATED", type: "FRAME", name: "Elsewhere", parentIndex: { guid: "0:3", position: "!" }, size: { x: 300, y: 200 }, transform: at(0, 0), fillPaints: [solid(0xffc700)] },
    ],
  };
  const engine = await Engine.create(null, { sessionID: 7 });
  try {
    engine.load(doc);
    engine.setViewport(1280, 800, 1, 1280, 800);
    // A variable on the card's fill and a text style on the title, made as the editor makes them.
    const collection = engine.runCommand("CREATE_VARIABLE_COLLECTION", { name: "Colors" }).created[0];
    const variable = engine.runCommand("CREATE_VARIABLE", { collection, type: "COLOR", name: "Surface", value: rgb(0xffffff) as never }).created[0];
    engine.runCommand("BIND_VARIABLE", { refs: ["1:1"], target: "fillPaints[0].color", variable });
    engine.setSelection(["1:2"]);
    engine.runCommand("CREATE_STYLE", { type: "TEXT", name: "Heading 1", from: "1:2", apply: true });
    engine.setSelection([]);
    // Every page derived, its fonts in, as the editor's Share does before it encodes.
    for (const p of engine.pages()) engine.layerTree(p.guid);
    await fonts.settled();
    engine.pump();
    return { snapshot: engine.encodeDocumentKiwi({ derived: true }), image: { sha1, bytes: png } };
  } finally {
    engine.destroy();
  }
}
