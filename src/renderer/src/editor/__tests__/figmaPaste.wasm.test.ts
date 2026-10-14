// Paste from Figma (docs/desktop.md §13 "Paste from Figma"), on the real wasm: Figma's clipboard HTML — `(figmeta)`
// metadata and a `(figma)` fig-kiwi archive in Figma's own schema, data chunk zstd or deflate — built from a real
// Figma file (docs/research/figma/samples/structure.fig: its schema, nodes, vector blobs and image paints, laid out as
// Figma's ⌘C lays out a copy: the copied layers under their parent, a clipboardSelectionRegion with the parent's page
// offset, the mains instances use on the Internal Only Canvas) → readClipboard → archiveMessage → decodeFigmaClipboard
// → the engine's pasteKiwi: fresh GUIDs, one undo step, the pasted layers selected.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { deflateRawSync, inflateRawSync, zstdCompressSync, zstdDecompressSync } from "node:zlib";
import { compileSchema, decodeBinarySchema } from "kiwi-schema";
import { beforeAll, describe, expect, it } from "vitest";
import { Engine } from "@/engine/Engine";
import { loadEngine } from "@/engine/loadEngine";
import type { NodeChange } from "@/engine/codec";
import { archiveMessage, readClipboard } from "../model/clipboard";
import { pastableText, textToMessage } from "../model/textPaste";
import { decodeCanvas, writeCanvasChunks } from "../../../../shared/fig/container";
import { readFigFile } from "../../../../shared/fig/figFile";
import { decodeFigmaClipboard, figmaMetaOf, FIGMA_FILE_KEY_PREFIX } from "../../../../shared/fig/figmaClipboard";
import { decodeMessage } from "../../../../shared/schema/codec";

/* eslint-disable @typescript-eslint/no-explicit-any -- Figma-schema values */

const wasm = fileURLToPath(new URL("../../engine/wasm/engine.wasm", import.meta.url));
const sampleOf = (name: string) => fileURLToPath(new URL(`../../../../../docs/research/figma/samples/${name}.fig`, import.meta.url));

beforeAll(async () => {
  const g = globalThis as Record<string, unknown>;
  g.window ??= globalThis;
  g.document ??= { querySelector: () => null };
  const bytes = readFileSync(wasm);
  await loadEngine({ wasmBinary: bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength), printErr: () => {} });
});

const node = { inflateRaw: (d: Uint8Array) => new Uint8Array(inflateRawSync(d)), deflateRaw: (d: Uint8Array) => new Uint8Array(deflateRawSync(d)), zstdDecompress: (d: Uint8Array) => new Uint8Array(zstdDecompressSync(d)) };

/** The sample's Figma schema, codec and Message. */
function figmaSample(name = "structure") {
  const file = readFigFile(new Uint8Array(readFileSync(sampleOf(name))), node);
  const canvas = decodeCanvas(file.canvas, node);
  const schema = compileSchema(decodeBinarySchema(canvas.schema)) as any;
  return { canvas, schema, message: schema.decodeMessage(canvas.message) as any };
}

const k = (g: any) => `${g.sessionID}:${g.localID}`;
const b64 = (bytes: Uint8Array) => Buffer.from(bytes).toString("base64");

/**
 * Figma's clipboard HTML for a copy of `ids` (with their subtrees): the document, the page and the internal canvas,
 * the copied layers under their own parent, the mains `mains` moved to the internal canvas (as Figma keeps them in a
 * copy), one region per parent with the parent's page offset.
 */
function figmaClipboard(ids: string[], opts: { mains?: string[]; zstd?: boolean; drop?: string[]; sample?: string } = {}): string {
  const { canvas, schema, message } = figmaSample(opts.sample);
  const all: any[] = message.nodeChanges;
  const byId = new Map(all.map((n) => [k(n.guid), n]));
  const kids = (id: string) => all.filter((n) => n.parentIndex && k(n.parentIndex.guid) === id);
  const keep = new Set(["0:0", "0:1", "0:2"]);
  const add = (id: string) => {
    keep.add(id);
    for (const c of kids(id)) add(k(c.guid));
  };
  for (const id of [...ids, ...(opts.mains ?? [])]) add(id);
  for (const d of opts.drop ?? []) keep.delete(d);
  const world = (id: string): { x: number; y: number } => {
    const n = byId.get(id);
    if (!n || n.type === "CANVAS") return { x: 0, y: 0 };
    const p = world(k(n.parentIndex.guid));
    return { x: p.x + n.transform.m02, y: p.y + n.transform.m12 };
  };
  const internal = byId.get("0:2").guid;
  const nodeChanges = all
    .filter((n) => keep.has(k(n.guid)))
    .map((n) => {
      const id = k(n.guid);
      if (!opts.mains?.includes(id)) return n;
      const w = world(id);
      return { ...n, parentIndex: { guid: internal, position: n.parentIndex.position }, transform: { ...n.transform, m02: w.x, m12: w.y } };
    });
  const regions = new Map<string, any>();
  for (const id of ids) {
    const parent = byId.get(id).parentIndex.guid;
    if (!regions.has(k(parent))) regions.set(k(parent), { parent, nodes: [], enclosingFrameOffset: world(k(parent)) });
    regions.get(k(parent)).nodes.push(byId.get(id).guid);
  }
  const clip = { ...message, nodeChanges, pasteID: 1234567, pasteFileKey: "AbCdEfGh123", pastePageId: { sessionID: 0, localID: 1 }, clipboardSelectionRegions: [...regions.values()] };
  const bytes = schema.encodeMessage(clip) as Uint8Array;
  const archive = writeCanvasChunks({ prelude: "fig-kiwi", version: canvas.version, chunks: [deflateRawSync(canvas.schema), opts.zstd ? zstdCompressSync(bytes) : deflateRawSync(bytes)] });
  const meta = Buffer.from(JSON.stringify({ fileKey: "AbCdEfGh123", pasteID: 1234567, dataType: "scene" })).toString("base64");
  return `<meta charset="utf-8"><span data-metadata="<!--(figmeta)${meta}(/figmeta)-->"></span><span data-buffer="<!--(figma)${b64(archive)}(/figma)-->"></span>`;
}

/** The clipboard HTML → our Message bytes, as clipboardIO's paste does it. */
async function decodeHtml(html: string) {
  const payload = readClipboard((t) => (t === "text/html" ? html : undefined));
  expect(payload?.kind).toBe("archive");
  const p = payload as { archive: Uint8Array; meta: any };
  expect(p.meta?.fileKey).toBe("AbCdEfGh123");
  let report: any = null;
  const bytes = await archiveMessage(p.archive, {
    inflate: async (d) => new Uint8Array(inflateRawSync(d)),
    zstd: (d) => new Uint8Array(zstdDecompressSync(d)),
    convert: (s, m) => {
      const r = decodeFigmaClipboard(s, m, p.meta);
      report = r.report;
      return r.message;
    },
  });
  expect(bytes).not.toBeNull();
  return { bytes: bytes!, report };
}

async function emptyFile(): Promise<Engine> {
  const engine = await Engine.create(null, { sessionID: 1048577 });
  engine.load({
    type: "NODE_CHANGES",
    sessionID: 0,
    nodeChanges: [
      { guid: "0:0", phase: "CREATED", type: "DOCUMENT", name: "Document" },
      { guid: "0:1", phase: "CREATED", type: "CANVAS", name: "Page 1", parentIndex: { guid: "0:0", position: "!" } },
      { guid: "0:2", phase: "CREATED", type: "CANVAS", name: "Internal Only Canvas", internalOnly: true, parentIndex: { guid: "0:0", position: "~" } } as NodeChange,
    ],
  });
  return engine;
}

const doc = (engine: Engine) => engine.encodeDocument().nodeChanges;
const childrenOf = (engine: Engine, id: string) => doc(engine).filter((n) => n.parentIndex?.guid === id);

describe("paste from Figma (wasm, headless)", () => {
  it("reads Figma's envelope and metadata", () => {
    const html = figmaClipboard(["1:2"]);
    expect(figmaMetaOf(html)).toEqual({ fileKey: "AbCdEfGh123", pasteID: 1234567, dataType: "scene" });
  });

  for (const zstd of [false, true]) {
    it(`pastes frames, groups, vectors, a component and its instances, text and image fills (${zstd ? "zstd" : "deflate"} data chunk) as one undo step`, async () => {
      const { bytes, report } = await decodeHtml(figmaClipboard(["1:2", "1:4"], { zstd }));
      const message = decodeMessage(bytes);
      expect(message.pasteFileKey).toBe(`${FIGMA_FILE_KEY_PREFIX}AbCdEfGh123`);
      expect(report.detached).toBe(0);
      expect(report.images.length).toBe(2);
      const engine = await emptyFile();
      const before = doc(engine).length;
      expect(engine.pasteKiwi(bytes)).toBe(2);
      const sel = engine.getSelection().refs;
      expect(sel).toHaveLength(2);
      const nodes = doc(engine);
      // Every layer of the two frames came along (the copy's 26 nodes less the document and canvases), fresh GUIDs.
      expect(nodes.length).toBe(before + 23);
      expect(nodes.every((n) => !["1:2", "1:4", "1:37", "1:38"].includes(n.guid))).toBe(true);
      const top = childrenOf(engine, "0:1");
      expect(top.map((n) => n.name)).toEqual(["Groups", "Symbols and images"]);
      // Groups: FRAME + resizeToFit; the sample's nested groups.
      const groups = top[0];
      const g2 = childrenOf(engine, groups.guid)[0];
      expect(g2.name).toBe("Group 2");
      expect(g2.resizeToFit).toBe(true);
      // Vectors keep their networks (blobs resolved); the component and its instances; text; image paints.
      const symbols = top[1];
      const kidsOf = childrenOf(engine, symbols.guid);
      const logo = kidsOf.find((n) => n.name === "logo-icon 1")!;
      const vectors = childrenOf(engine, logo.guid);
      expect(vectors).toHaveLength(8);
      expect(vectors.every((v) => v.type === "VECTOR" && !!v.vectorData)).toBe(true);
      const main = kidsOf.find((n) => n.type === "SYMBOL")!;
      expect(main.name).toBe("Component 1");
      const instances = kidsOf.filter((n) => n.type === "INSTANCE");
      expect(instances).toHaveLength(2);
      for (const i of instances) expect(k(i.symbolData?.symbolID)).toBe(main.guid);
      const text = childrenOf(engine, main.guid).find((n) => n.type === "TEXT")!;
      expect(text.textData?.characters).toBe("ABC");
      const image = kidsOf.find((n) => n.name === "sketch 1")!;
      expect(image.fillPaints?.[0]?.type).toBe("IMAGE");
      expect(image.fillPaints?.[0]?.imageThumbnail).toBeUndefined();
      // One undo step takes it all away.
      engine.command("UNDO");
      expect(doc(engine).length).toBe(before);
      engine.destroy();
    });
  }

  it("an instance copied alone brings its main to the internal canvas; pasted twice, the main comes in once", async () => {
    // The instance sits in "Symbols and images" (1:4): its region's offset is that frame's place on the page.
    const { bytes, report } = await decodeHtml(figmaClipboard(["1:38"], { mains: ["1:37"], zstd: true }));
    expect(report.detached).toBe(0);
    const engine = await emptyFile();
    expect(engine.pasteKiwi(bytes)).toBe(1);
    const pasted = engine.readNode(engine.getSelection().refs[0])!;
    expect(pasted.type).toBe("INSTANCE");
    expect(pasted.parentIndex?.guid).toBe("0:1");
    const main = engine.readNode(k(pasted.symbolData!.symbolID))!;
    expect(main.type).toBe("SYMBOL");
    expect(main.parentIndex?.guid).toBe("0:2");
    expect(main.key ?? "").toBe("");
    expect(engine.pasteKiwi(bytes)).toBe(1);
    const again = engine.readNode(engine.getSelection().refs[0])!;
    expect(k(again.symbolData?.symbolID)).toBe(main.guid);
    expect(doc(engine).filter((n) => n.type === "SYMBOL")).toHaveLength(1);
    engine.destroy();
  });

  it("an instance whose main isn't in the clipboard is pasted as a frame", async () => {
    const { bytes, report } = await decodeHtml(figmaClipboard(["1:45"]));
    expect(report.detached).toBe(1);
    const engine = await emptyFile();
    expect(engine.pasteKiwi(bytes)).toBe(1);
    const pasted = engine.readNode(engine.getSelection().refs[0])!;
    expect(pasted.type).toBe("FRAME");
    expect(pasted.name).toBe("Component 3");
    engine.destroy();
  });

  it("a layer nested in a frame lands where it was on the page (paste in place)", async () => {
    const { bytes } = await decodeHtml(figmaClipboard(["1:26"]));
    const { message } = figmaSample();
    const at = (id: string) => message.nodeChanges.find((n: any) => k(n.guid) === id).transform;
    const engine = await emptyFile();
    expect(engine.pasteKiwi(bytes, { inPlace: true })).toBe(1);
    const v = engine.readNode(engine.getSelection().refs[0])!;
    expect(v.type).toBe("VECTOR");
    // 1:26 in 1:25 in 1:4 on the page.
    expect(v.transform!.m02).toBeCloseTo(at("1:4").m02 + at("1:25").m02 + at("1:26").m02, 3);
    expect(v.transform!.m12).toBeCloseTo(at("1:4").m12 + at("1:25").m12 + at("1:26").m12, 3);
    engine.destroy();
  });

  it("auto layout comes along (wrap, spacing, children's order)", async () => {
    const { bytes } = await decodeHtml(figmaClipboard(["1:2", "2:2"], { sample: "stacks_wrap", zstd: true }));
    const engine = await emptyFile();
    expect(engine.pasteKiwi(bytes)).toBe(2);
    const [wrap, vertical] = engine.getSelection().refs.map((r) => engine.readNode(r)!);
    expect(wrap.name).toBe("Horizontal wrap top left");
    expect(wrap.stackMode).toBe("HORIZONTAL");
    expect(wrap.stackWrap).toBe("WRAP");
    expect(wrap.stackSpacing).toBe(4);
    expect(vertical.stackMode).toBe("VERTICAL");
    expect(vertical.stackSpacing).toBe(8);
    const { message } = figmaSample("stacks_wrap");
    const kidsIn = (id: string) => message.nodeChanges.filter((n: any) => n.parentIndex && k(n.parentIndex.guid) === id).sort((a: any, b: any) => (a.parentIndex.position < b.parentIndex.position ? -1 : 1));
    expect(childrenOf(engine, vertical.guid).map((n) => n.name)).toEqual(kidsIn("2:2").map((n: any) => n.name));
    engine.destroy();
  });

  it("plain text becomes a text layer", async () => {
    expect(pastableText("  \n ")).toBeNull();
    expect(pastableText("Hello\r\nworld \n")).toBe("Hello\nworld");
    const engine = await emptyFile();
    expect(engine.paste(textToMessage("Hello\nworld", { x: 10, y: 20 }), { inPlace: true })).toBe(1);
    const t = engine.readNode(engine.getSelection().refs[0])!;
    expect(t.type).toBe("TEXT");
    expect(t.textData?.characters).toBe("Hello\nworld");
    expect(t.name).toBe("Hello world");
    expect(t.fontName?.family).toBe("Inter");
    engine.destroy();
  });
});
