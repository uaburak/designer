// Paste from Figma, overrides reaching into components that came along (docs/schema.md §5.1), on the real wasm with
// two real Figma clipboards (docs/research/figma/live/2026-10-27, signed image URLs blanked):
// - avatars-section-clipboard.html: a SECTION holding the Avatar, Avatar Group and Avatar Block sets, annotation
//   instances and a "_Component Note" instance whose main (on the internal canvas) holds an Avatar Block instance with
//   an image override on its nested Avatar's Shape (guidPath [Avatar's key, Shape's key]);
// - component-note-clipboard.html: that "_Component Note" instance alone (Figma 15010:282), its mains on the internal
//   canvas with their overrideKeys.
// A component set pasted inside a section keeps its layers' keys, as one pasted itself does: the note's override
// finds the Avatar inside it, pasted alone, in the section, or after the section (the set re-used). The note's
// Avatar Block (Hug width over the main's Fixed) lays out as Figma does: Info 110 wide, the block 162.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { inflateRawSync, zstdDecompressSync } from "node:zlib";
import { beforeAll, describe, expect, it } from "vitest";
import { Engine } from "@/engine/Engine";
import { BUNDLED_FACES, fonts } from "@/engine/fonts";
import { loadEngine } from "@/engine/loadEngine";
import type { NodeChange } from "@/engine/codec";
import { archiveMessage, readClipboard } from "../model/clipboard";
import { decodeFigmaClipboard } from "../../../../shared/fig/figmaClipboard";

/* eslint-disable @typescript-eslint/no-explicit-any -- Figma-schema values */

const at = (path: string) => fileURLToPath(new URL(path, import.meta.url));
const live = (name: string) => readFileSync(at(`../../../../../docs/research/figma/live/2026-10-27/${name}.html`), "utf8");

beforeAll(async () => {
  const g = globalThis as Record<string, unknown>;
  g.window ??= globalThis;
  g.document ??= { querySelector: () => null };
  globalThis.fetch = async () => new Response(null, { status: 404 });
  const bytes = readFileSync(at("../../engine/wasm/engine.wasm"));
  await loadEngine({ wasmBinary: bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength), printErr: () => {} });
  const inter = new Uint8Array(readFileSync(at("../../engine/fonts/Inter-3.19.ttf")));
  fonts.setSource({ list: async () => BUNDLED_FACES, read: async () => inter });
});

/** The clipboard HTML → our Message bytes, as clipboardIO's paste does it. */
async function bytesOf(html: string): Promise<Uint8Array> {
  const p = readClipboard((t) => (t === "text/html" ? html : undefined)) as { archive: Uint8Array; meta: any };
  const bytes = await archiveMessage(p.archive, {
    inflate: async (d) => new Uint8Array(inflateRawSync(d)),
    zstd: (d) => new Uint8Array(zstdDecompressSync(d)),
    convert: (s, m) => decodeFigmaClipboard(s, m, p.meta).message,
  });
  expect(bytes).not.toBeNull();
  return bytes!;
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

async function paste(engine: Engine, name: string): Promise<string[]> {
  expect(engine.pasteKiwi(await bytesOf(live(name)))).toBeGreaterThan(0);
  for (let i = 0; i < 3; i++) {
    await fonts.settled();
    engine.pump();
  }
  return engine.getSelection().refs;
}

const hex = (h: unknown) => (h instanceof Uint8Array || Array.isArray(h) ? Buffer.from(h as number[]).toString("hex") : String(h ?? ""));
const AUTHOR = "cae1742172b5fa9c7ae1b46f1eac35b28201b02f"; // the note's override on Avatar › Shape
const DEFAULT = "11dbcb982f9ba115c7d5cc790cc48a457815fb67"; // the Avatar variant's own image

/** The Avatar Block inside a pasted "_Component Note" instance: the block, its Avatar's Shape, Info and its texts. */
function noteBlock(engine: Engine, note: string) {
  const sub = engine.readNodes([note], { subtree: true });
  const block = sub.find((n) => n.name === "Avatar Block" && n.type === "INSTANCE")!;
  const under = sub.filter((n) => n.guid.startsWith(block.guid + ";"));
  const shape = under.find((n) => n.name === "Shape")!;
  const info = under.find((n) => n.name === "Info")!;
  const texts = under.filter((n) => n.type === "TEXT");
  return { block, shape, info, texts, image: hex((shape.fillPaints?.[0] as any)?.image?.hash) };
}

const notesIn = (engine: Engine) => engine.encodeDocument().nodeChanges.filter((n) => n.type === "INSTANCE" && n.name === "_Component Note");

describe("paste from Figma: overrides into components that came along (wasm, headless)", () => {
  it("the note alone: its Avatar Block shows the author's photo and hugs its texts as in Figma", async () => {
    const engine = await emptyFile();
    const [note] = await paste(engine, "component-note-clipboard");
    const { block, info, texts, image } = noteBlock(engine, note);
    expect(image).toBe(AUTHOR);
    // Hug width over the main's Fixed 139: Info as wide as "UX / UI Designer" on one line, the block 40 + 12 + 110.
    expect(info.size?.x).toBeCloseTo(110, 0);
    expect(block.size?.x).toBeCloseTo(162, 0);
    expect(texts.find((t) => t.name === "Description")!.size?.y).toBe(20);
    engine.destroy();
  });

  it("a component set pasted inside a section keeps its layers' override keys", async () => {
    const engine = await emptyFile();
    await paste(engine, "avatars-section-clipboard");
    const doc = engine.encodeDocument().nodeChanges;
    const md = doc.find((n) => n.type === "SYMBOL" && n.name === "Size=md")!;
    expect(md.parentIndex?.guid).not.toBe("0:2"); // the set in the section, not a copy on the internal canvas
    const avatar = doc.find((n) => n.parentIndex?.guid === md.guid && n.name === "Avatar")!;
    expect(avatar.overrideKey).toEqual({ sessionID: 15001, localID: 131726 });
    const [note] = notesIn(engine);
    expect(noteBlock(engine, note.guid).image).toBe(AUTHOR);
    engine.destroy();
  });

  it("the note pasted after the section (its sets re-used) keeps the author's photo", async () => {
    const engine = await emptyFile();
    await paste(engine, "avatars-section-clipboard");
    const [note] = await paste(engine, "component-note-clipboard");
    // The second note uses the first paste's note main, whose Avatar Block is an instance of the section's set.
    const doc = engine.encodeDocument().nodeChanges;
    const notes = notesIn(engine);
    expect(notes).toHaveLength(2);
    expect(notes[1].symbolData?.symbolID).toEqual(notes[0].symbolData?.symbolID);
    const md = doc.find((n) => n.type === "SYMBOL" && n.name === "Size=md" && n.parentIndex?.guid !== "0:2" && doc.find((p) => p.guid === n.parentIndex?.guid)?.parentIndex?.guid !== "0:2")!;
    const blockInMain = doc.find((n) => n.type === "INSTANCE" && n.name === "Avatar Block" && !n.guid.startsWith("I") && n.symbolData?.symbolID && `${(n.symbolData.symbolID as any).sessionID}:${(n.symbolData.symbolID as any).localID}` === md.guid);
    expect(blockInMain).toBeDefined();
    const { block, info, image } = noteBlock(engine, note);
    expect(image).toBe(AUTHOR);
    expect(image).not.toBe(DEFAULT);
    // Its other overrides (Hug width on the block, Info hugging, Description auto width) find their layers too.
    expect(info.size?.x).toBeCloseTo(110, 0);
    expect(block.size?.x).toBeCloseTo(162, 0);
    engine.destroy();
  });
});
