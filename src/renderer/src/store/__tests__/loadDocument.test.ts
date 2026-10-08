// Opening a file for the engine: the bytes prepared off the main thread equal what the main-thread merge gives, the
// fonts and the fallback need are known from the file, the source memoizes its load, and the schema model's
// reachability memo answers the same as a fresh computation.
import { describe, expect, it } from "vitest";
import { encodeMessage as encodeEngine } from "@/engine/codec";
import { decodeMessage, encodeMessage, newDocumentMessage } from "../../../../shared/schema/codec";
import type { Message, NodeChange } from "../../../../shared/schema/codec";
import { MODEL } from "../../../../shared/schema/model";
import { NodeTable } from "../../../../shared/schema/patch";
import { mergedDocument, prepareDocument } from "../documentSource";
import { canReplayJournal, documentFacts, engineDocumentFromTable, fontsByPageOf, fontsOf, MAX_REPLAY_FRAMES, needsFallbackFont, prepareEngineDocument, sourceTypesOf, tableOf } from "../loadDocument";

const text = (local: number, characters: string, family = "Inter", style = "Regular"): NodeChange =>
  ({
    guid: { sessionID: 1, localID: local },
    phase: "CREATED",
    type: "TEXT",
    name: `Text ${local}`,
    parentIndex: { guid: { sessionID: 0, localID: 1 }, position: String.fromCharCode(0x21 + local) },
    textData: { characters },
    fontName: { family, style, postscript: `${family}-${style}`.replace(/\s+/g, "") },
  }) as NodeChange;

function sample(): Message & { nodeChanges: NodeChange[] } {
  const m = newDocumentMessage() as Message & { nodeChanges: NodeChange[] };
  m.nodeChanges.push(
    { guid: { sessionID: 1, localID: 1 }, phase: "CREATED", type: "ROUNDED_RECTANGLE", name: "Card", parentIndex: { guid: { sessionID: 0, localID: 1 }, position: "!" }, size: { x: 100, y: 50 } } as NodeChange,
    text(2, "Merhaba dünya", "Inter", "Semi Bold"),
    { ...text(3, "Title"), textData: { characters: "Title", styleOverrideTable: [{ guid: { sessionID: 0, localID: 0 }, fontName: { family: "Helvetica Neue", style: "Bold", postscript: "HelveticaNeue-Bold" } }] } } as NodeChange,
    { guid: { sessionID: 1, localID: 4 }, phase: "CREATED", type: "BOOLEAN_OPERATION", booleanOperation: "SUBTRACT", name: "Cutout", parentIndex: { guid: { sessionID: 0, localID: 1 }, position: "$" } } as NodeChange,
  );
  return m;
}

describe("preparing an opened file for the engine", () => {
  it("gives the same engine bytes as the main-thread merge, in snapshot order", () => {
    const snapshot = encodeMessage(sample());
    const journal = [{ message: encodeMessage({ type: "NODE_CHANGES", sessionID: 1, ackID: 0, nodeChanges: [{ guid: { sessionID: 1, localID: 1 }, name: "Hero" }], blobs: [] }) }];
    const opened = { snapshot, journal, sessionID: 1 };
    const prepared = prepareEngineDocument(opened);
    const merged = mergedDocument(opened);
    expect(prepared.format).toBe("json");
    expect(Buffer.from(prepared.bytes!).equals(Buffer.from(encodeEngine(merged)))).toBe(true);
    expect(prepared.nodeCount).toBe(merged.nodeChanges.length);
    expect(merged.nodeChanges[0].type).toBe("DOCUMENT");
    expect(merged.nodeChanges.find((n) => n.guid === "1:1")?.name).toBe("Hero");
    expect(merged.nodeChanges.every((n) => n.phase === "CREATED")).toBe(true);
  });

  it("knows the fonts (text, style runs) and whether a fallback script is in the text", () => {
    const table = tableOf({ snapshot: encodeMessage(sample()), journal: [], sessionID: 1 });
    expect(fontsOf(table)).toEqual([
      { family: "Inter", style: "Semi Bold" },
      { family: "Inter", style: "Regular" },
      { family: "Helvetica Neue", style: "Bold" },
    ]);
    expect(needsFallbackFont(table)).toBe(false);
    const cjk = sample();
    cjk.nodeChanges.push(text(5, "设计"));
    expect(needsFallbackFont(tableOf({ snapshot: encodeMessage(cjk), journal: [], sessionID: 1 }))).toBe(true);
    const emoji = sample();
    emoji.nodeChanges.push(text(5, "Done 🎉"));
    expect(needsFallbackFont(tableOf({ snapshot: encodeMessage(emoji), journal: [], sessionID: 1 }))).toBe(true);
  });

  it("notes the node types the engine may read as NONE, with boolean operations", () => {
    const table = tableOf({ snapshot: encodeMessage(sample()), journal: [], sessionID: 1 });
    const types = sourceTypesOf(engineDocumentFromTable(table));
    expect(types.map((t) => t.guid).sort()).toEqual(["1:2", "1:3", "1:4"]);
    expect(types.find((t) => t.guid === "1:4")).toEqual({ guid: "1:4", type: "BOOLEAN_OPERATION", booleanOperation: "SUBTRACT" });
  });

  it("reports the facts before the bytes, inline where no worker runs, with the store's raw bytes at once", async () => {
    const order: string[] = [];
    const snapshot = encodeMessage(sample());
    const p = prepareDocument({ snapshot, journal: [], sessionID: 1, derivedDataVersion: 3 });
    void p.facts.then(() => order.push("facts"));
    void p.document.then(() => order.push("document"));
    expect(p.raw).toEqual({ snapshot, frames: [], derivedDataVersion: 3 });
    const known = await p.facts;
    const doc = await p.document;
    await Promise.resolve();
    expect(order[0]).toBe("facts");
    expect(known.fonts.length).toBe(3);
    expect(known.needsFallbackFont).toBe(false);
    expect(doc.fonts).toEqual(known.fonts);
    expect(doc.types.length).toBe(3);
    expect(doc.nodeCount).toBe(known.nodeCount);
  });

  it("the kiwi form: a short journal is replayed as it is, a long one folded into one snapshot with derived fields kept", () => {
    const base = sample();
    base.derivedDataVersion = 9;
    (base.nodeChanges[4] as NodeChange).derivedTextData = { layoutSize: { x: 40, y: 20 } }; // text 1:2
    (base.nodeChanges[5] as NodeChange).derivedTextData = { layoutSize: { x: 50, y: 20 } }; // text 1:3
    const snapshot = encodeMessage(base);
    const frame = encodeMessage({ type: "NODE_CHANGES", sessionID: 1, ackID: 0, nodeChanges: [{ guid: { sessionID: 1, localID: 2 }, name: "Hero" }], blobs: [] });
    const short = prepareEngineDocument({ snapshot, journal: [{ message: frame }], sessionID: 1 }, undefined, "kiwi");
    expect(short.format).toBe("kiwi");
    expect(short.bytes).toBeNull(); // the engine takes the snapshot, then the frame (docs/desktop.md §3.1)
    expect(short.derivedDataVersion).toBe(9);
    expect(short.timing.convert).toBe(0);
    expect(canReplayJournal([{ message: frame }])).toBe(true);
    const long = Array.from({ length: MAX_REPLAY_FRAMES + 1 }, () => ({ message: frame }));
    expect(canReplayJournal(long)).toBe(false);
    const folded = prepareEngineDocument({ snapshot, journal: long, sessionID: 1 }, undefined, "kiwi");
    expect(folded.bytes).not.toBeNull();
    const m = decodeMessage(folded.bytes!);
    expect(m.derivedDataVersion).toBe(9);
    const byLocal = (l: number) => m.nodeChanges!.find((n) => n.guid!.sessionID === 1 && n.guid!.localID === l)!;
    expect(byLocal(2).name).toBe("Hero");
    expect(byLocal(2).derivedTextData).toBeUndefined(); // the renamed text's cache went with the change
    expect(byLocal(3).derivedTextData).toEqual({ layoutSize: { x: 50, y: 20 } }); // untouched: kept
    expect(m.nodeChanges!.every((n) => n.phase === "CREATED")).toBe(true);
    // A big replayable journal by bytes is folded too.
    const fat = encodeMessage({ type: "NODE_CHANGES", sessionID: 1, ackID: 0, nodeChanges: [{ guid: { sessionID: 1, localID: 2 }, name: "x".repeat(3 * 1024 * 1024) }], blobs: [] });
    expect(canReplayJournal([{ message: fat }, { message: fat }, { message: fat }])).toBe(false);
  });

  it("knows the fonts by page, the shown page's first", () => {
    const m = sample();
    m.nodeChanges.push(
      { guid: { sessionID: 1, localID: 10 }, phase: "CREATED", type: "CANVAS", name: "Page 2", parentIndex: { guid: { sessionID: 0, localID: 0 }, position: "#" } } as NodeChange,
      { ...text(11, "Second page", "Roboto", "Medium"), parentIndex: { guid: { sessionID: 1, localID: 10 }, position: "!" } } as NodeChange,
      { guid: { sessionID: 1, localID: 12 }, phase: "CREATED", type: "FRAME", name: "Card", parentIndex: { guid: { sessionID: 1, localID: 10 }, position: '"' } } as NodeChange,
      { ...text(13, "Nested", "Georgia", "Italic"), parentIndex: { guid: { sessionID: 1, localID: 12 }, position: "!" } } as NodeChange,
    );
    const table = tableOf({ snapshot: encodeMessage(m), journal: [], sessionID: 1 });
    const byPage = fontsByPageOf(table);
    expect(Object.keys(byPage)).toEqual(["0:1", "1:10"]);
    expect(byPage["0:1"]).toEqual([
      { family: "Inter", style: "Semi Bold" },
      { family: "Inter", style: "Regular" },
      { family: "Helvetica Neue", style: "Bold" },
    ]);
    expect(byPage["1:10"]).toEqual([
      { family: "Roboto", style: "Medium" },
      { family: "Georgia", style: "Italic" },
    ]);
    const facts = documentFacts(table);
    expect(facts.fonts.length).toBe(5);
    expect(facts.derivedDataVersion).toBe(0);
    expect(facts.types.map((t) => t.guid).sort()).toEqual(["1:11", "1:13", "1:2", "1:3", "1:4"]);
  });

  it("a page's fonts include its read dependencies: the mains its instances use, nested instances and overrides followed", () => {
    const m = sample();
    const page2 = { sessionID: 1, localID: 20 };
    m.nodeChanges.push(
      { guid: page2, phase: "CREATED", type: "CANVAS", name: "Components", parentIndex: { guid: { sessionID: 0, localID: 0 }, position: "#" } } as NodeChange,
      // A main on page 2 with a text in Roboto, and a nested instance of a second main whose text is in Georgia.
      { guid: { sessionID: 1, localID: 21 }, phase: "CREATED", type: "SYMBOL", name: "Button", parentIndex: { guid: page2, position: "!" } } as NodeChange,
      { ...text(22, "Label", "Roboto", "Medium"), parentIndex: { guid: { sessionID: 1, localID: 21 }, position: "!" } } as NodeChange,
      { guid: { sessionID: 1, localID: 23 }, phase: "CREATED", type: "SYMBOL", name: "Icon", parentIndex: { guid: page2, position: '"' } } as NodeChange,
      { ...text(24, "i", "Georgia", "Italic"), parentIndex: { guid: { sessionID: 1, localID: 23 }, position: "!" } } as NodeChange,
      { guid: { sessionID: 1, localID: 25 }, phase: "CREATED", type: "INSTANCE", name: "Icon", parentIndex: { guid: { sessionID: 1, localID: 21 }, position: '"' }, symbolData: { symbolID: { sessionID: 1, localID: 23 } } } as NodeChange,
      // On page 1: an instance of Button whose label is overridden to Menlo.
      {
        guid: { sessionID: 1, localID: 30 },
        phase: "CREATED",
        type: "INSTANCE",
        name: "Button",
        parentIndex: { guid: { sessionID: 0, localID: 1 }, position: "%" },
        symbolData: { symbolID: { sessionID: 1, localID: 21 }, symbolOverrides: [{ guidPath: { guids: [{ sessionID: 1, localID: 22 }] }, fontName: { family: "Menlo", style: "Regular", postscript: "Menlo-Regular" } }] },
      } as NodeChange,
    );
    const byPage = fontsByPageOf(tableOf({ snapshot: encodeMessage(m), journal: [], sessionID: 1 }));
    const families = (page: string) => byPage[page].map((f) => f.family);
    // The page's own fonts first (document order), then the mains' (order within a main's subtree isn't promised).
    expect(families("0:1").slice(0, 4)).toEqual(["Inter", "Inter", "Helvetica Neue", "Menlo"]);
    expect(families("0:1").slice(4).sort()).toEqual(["Georgia", "Roboto"]);
    expect(families("1:20").sort()).toEqual(["Georgia", "Roboto"]);
  });

  it("the schema model's reachability memo agrees with a fresh computation", () => {
    const owners = MODEL.blobOwners();
    expect(MODEL.blobOwners()).toBe(owners); // the same set every time (callers' caches key on it)
    const fresh = (type: string) => [...MODEL.reach(type)].some((t) => owners.has(t));
    for (const type of ["NodeChange", "Paint", "VectorData", "GUID", "Color", "SymbolData"]) expect(MODEL.canContain(type, owners)).toBe(fresh(type));
    expect(MODEL.canContain("float", owners)).toBe(false);
  });

  it("a table without blobs skips the blob walk and still round-trips", () => {
    const table = NodeTable.fromMessage(sample());
    expect(table.blobs.size).toBe(0);
    const out = table.toMessage({ sessionID: 0 });
    expect(out.blobs).toEqual([]);
    // Snapshot order: DOCUMENT, then pre-order with children by position (the internal canvas sits at "~", last).
    expect(out.nodeChanges!.map((n) => n.name)).toEqual(["Document", "Page 1", "Card", "Text 2", "Text 3", "Cutout", "Internal Only Canvas"]);
    const again = NodeTable.fromMessage(out);
    expect(again.size).toBe(table.size);
  });
});
