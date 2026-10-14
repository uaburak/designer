// The file's thumbnail (Figma's "Set as thumbnail", Home's card): the document's thumbnailInfo written and cleared
// through the engine, the frame Home's card shows (the set one, else the first page's first frame), and a new design
// file's Thumbnail page and frame — on the real engine (the committed Wasm build, headless in Node).
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { Engine } from "@/engine/Engine";
import { EngineStore } from "@/engine/EngineStore";
import { loadEngine } from "@/engine/loadEngine";
import type { Message } from "@/engine/codec";
import { messageToEngine } from "@/store/engineMessage";
import { newDocumentMessage, THUMBNAIL_BACKGROUNDS } from "../../../../shared/schema/codec";
import { EditorController } from "../controller";
import { memoryDocumentSource } from "../documentSource";
import { setThumbnail, thumbnailNode } from "../objectCommands";
import { thumbnailFrame } from "../persistence";

const wasm = fileURLToPath(new URL("../../engine/wasm/engine.wasm", import.meta.url));

beforeAll(async () => {
  const g = globalThis as Record<string, unknown>;
  g.window ??= globalThis;
  g.document ??= { querySelector: () => null };
  const bytes = readFileSync(wasm);
  await loadEngine({ wasmBinary: bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength), printErr: () => {} });
});

afterEach(() => {
  delete (globalThis as { designer?: unknown }).designer;
});

async function editor(doc: Message) {
  const source = memoryDocumentSource(doc, { fileName: "Thumbnail" });
  const engine = await Engine.create(null, { sessionID: 1 });
  engine.load(await source.load());
  engine.setViewport(1280, 800, 1, 1280, 800);
  const store = new EngineStore(engine);
  const ed = new EditorController(engine, store, source);
  engine.onDocumentChanged((_, e) => source.onChanges(e.message));
  return { ed, engine, source };
}

const frame = (guid: string, name: string, x: number) => ({
  guid,
  phase: "CREATED" as const,
  type: "FRAME",
  name,
  parentIndex: { guid: "0:1", position: x === 0 ? "!" : "P" },
  size: { x: 400, y: 300 },
  transform: { m00: 1, m01: 0, m02: x, m10: 0, m11: 1, m12: 0 },
});

describe("the file's thumbnail", () => {
  it("Set as thumbnail names the frame on the document; Restore default thumbnail clears it; both undo", async () => {
    const base = messageToEngine(newDocumentMessage());
    const { ed, engine } = await editor({ ...base, nodeChanges: [...base.nodeChanges!, frame("1:1", "A", 0), frame("1:2", "B", 600)] } as Message);
    expect(thumbnailNode(ed)).toBe(null);
    // No frame set: the first page's first frame
    expect(thumbnailFrame(ed)).toBe("1:1");
    engine.setSelection(["1:2"]);
    setThumbnail(ed, "1:2");
    expect(thumbnailNode(ed)).toBe("1:2");
    expect(thumbnailFrame(ed)).toBe("1:2");
    engine.undo();
    expect(thumbnailNode(ed)).toBe(null);
    engine.redo();
    expect(thumbnailNode(ed)).toBe("1:2");
    setThumbnail(ed, null);
    expect(thumbnailNode(ed)).toBe(null);
    expect(thumbnailFrame(ed)).toBe("1:1");
  });

  it("a new design file has a Thumbnail page after Page 1, its 1920 × 1080 Thumbnail frame set as the thumbnail", async () => {
    const kiwi = newDocumentMessage({ thumbnail: 1 });
    const { ed, engine } = await editor(messageToEngine(kiwi) as Message);
    expect(ed.store.pages.map((p) => p.name)).toEqual(["Page 1", "Thumbnail"]);
    const id = thumbnailNode(ed)!;
    expect(id).toBeTruthy();
    expect(thumbnailFrame(ed)).toBe(id);
    const n = engine.readNode(id, { fields: ["type", "name", "size", "fillPaints", "parentIndex"] }) as { type: string; name: string; size: { x: number; y: number }; fillPaints: { type: string }[]; parentIndex: { guid: string } };
    expect([n.type, n.name, n.size.x, n.size.y, n.parentIndex.guid]).toEqual(["FRAME", "Thumbnail", 1920, 1080, ed.store.pages[1].guid]);
    expect(n.fillPaints[0].type).toBe(THUMBNAIL_BACKGROUNDS[1].type);
    // A random background each time, from the list; imports and the store's own documents have none
    const fills = new Set(Array.from({ length: 40 }, () => JSON.stringify(newDocumentMessage({ thumbnail: true }).nodeChanges!.at(-1)!.fillPaints)));
    expect(fills.size).toBeGreaterThan(1);
    expect(newDocumentMessage().nodeChanges!.length).toBe(3);
  });
});
