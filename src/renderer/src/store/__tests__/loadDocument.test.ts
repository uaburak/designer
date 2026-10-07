// Opening a file for the engine: the bytes prepared off the main thread equal what the main-thread merge gives, the
// fonts and the fallback need are known from the file, the source memoizes its load, and the schema model's
// reachability memo answers the same as a fresh computation.
import { describe, expect, it } from "vitest";
import { encodeMessage as encodeEngine } from "@/engine/codec";
import { encodeMessage, newDocumentMessage } from "../../../../shared/schema/codec";
import type { Message, NodeChange } from "../../../../shared/schema/codec";
import { MODEL } from "../../../../shared/schema/model";
import { NodeTable } from "../../../../shared/schema/patch";
import { mergedDocument, prepareDocument } from "../documentSource";
import { engineDocumentFromTable, fontsOf, needsFallbackFont, prepareEngineDocument, sourceTypesOf, tableOf } from "../loadDocument";

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
    expect(Buffer.from(prepared.bytes).equals(Buffer.from(encodeEngine(merged)))).toBe(true);
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

  it("reports the fonts before the bytes, inline where no worker runs, and the fallback flag with them", async () => {
    const order: string[] = [];
    const p = prepareDocument({ snapshot: encodeMessage(sample()), journal: [], sessionID: 1 });
    void p.fonts.then(() => order.push("fonts"));
    void p.document.then(() => order.push("document"));
    const known = await p.fonts;
    const doc = await p.document;
    await Promise.resolve();
    expect(order[0]).toBe("fonts");
    expect(known.fonts.length).toBe(3);
    expect(known.needsFallbackFont).toBe(false);
    expect(doc.fonts).toEqual(known.fonts);
    expect(doc.types.length).toBe(3);
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
