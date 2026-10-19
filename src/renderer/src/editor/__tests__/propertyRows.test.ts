// Fill / Stroke / Effect rows copied as Figma (live 2026-10-19, docs/research/figma/live/2026-10-18/property-rows-copy.txt):
// the row selection's clicks, the list edits, and the clipboard Message — NODE_CHANGES with pasteAssetType
// STYLE_PROPERTIES_* (Message field 41), the source layers' region and one temporary 100 × 100 ROUNDED_RECTANGLE
// carrying only the copied items — written here and read by Figma's schema, and Figma's own copy read here.
import { deflateRawSync, inflateRawSync } from "node:zlib";
import { compileSchema, decodeBinarySchema } from "kiwi-schema";
import { describe, expect, it } from "vitest";
import type { Paint } from "@/engine/codec";
import { archiveMessage, encodeClipboardKiwi, readClipboard } from "../model/clipboard";
import { clickRow, insertRows, isRowsMessage, rowsMessage, rowsOfMessage, sameLists, withoutRows } from "../model/propertyRows";
import { decodeCanvas } from "../../../../shared/fig/container";
import { decodeFigmaClipboard } from "../../../../shared/fig/figmaClipboard";
import { decodeMessage, encodeMessage, SCHEMA_BINARY } from "../../../../shared/schema/codec";
import { figmaRowsHtml } from "./figmaRowsClipboard";

/* eslint-disable @typescript-eslint/no-explicit-any -- Figma-schema values */

const blue: Paint = { type: "SOLID", color: { r: 0, g: 0, b: 1, a: 1 }, opacity: 0.5, visible: true, blendMode: "NORMAL" };
const red: Paint = { type: "SOLID", color: { r: 1, g: 0, b: 0, a: 1 }, opacity: 1, visible: true, blendMode: "NORMAL" };

describe("selecting rows", () => {
  it("a click selects one row (by its item, the panel showing the top first); ⇧ a range from the anchor", () => {
    // Four rows: display 0 is item 3.
    const one = clickRow(null, "fill", 1, 4, false);
    expect(one).toEqual({ section: "fill", rows: [2], anchor: 1 });
    expect(clickRow(one, "fill", 3, 4, true)).toEqual({ section: "fill", rows: [0, 1, 2], anchor: 1 });
    expect(clickRow(one, "fill", 0, 4, true)).toEqual({ section: "fill", rows: [2, 3], anchor: 1 });
    // A plain click on another row: that row alone.
    expect(clickRow(one, "fill", 0, 4, false)).toEqual({ section: "fill", rows: [3], anchor: 0 });
  });

  it("one section at a time: ⇧ in another section ranges there by the anchor's place and drops the first", () => {
    const fill = clickRow(null, "fill", 0, 2, false);
    expect(clickRow(fill, "effect", 2, 3, true)).toEqual({ section: "effect", rows: [0, 1, 2], anchor: 0 });
  });
});

describe("the list edits", () => {
  it("Delete takes the selected items out", () => {
    expect(withoutRows(["a", "b", "c", "d"], [1, 3])).toEqual(["a", "c"]);
  });

  it("paste adds the items on top in their order, or directly above an item", () => {
    expect(insertRows(["a", "b"], ["x", "y"])).toEqual({ list: ["a", "b", "x", "y"], rows: [2, 3] });
    expect(insertRows(["a", "b", "c"], ["x", "y"], 0)).toEqual({ list: ["a", "x", "y", "b", "c"], rows: [1, 2] });
    expect(insertRows([], ["x"])).toEqual({ list: ["x"], rows: [0] });
  });

  it("lists are pasted onto only when equal (else the panel reads Mixed)", () => {
    expect(sameLists([[red], [{ ...red }]])).toBe(true);
    expect(sameLists([[red], [blue]])).toBe(false);
    expect(sameLists([[red], []])).toBe(false);
  });
});

describe("the clipboard Message", () => {
  const message = rowsMessage("fill", [blue], { layers: ["5:12"], page: "0:1", fileKey: "lib-1", pasteID: 77 });

  it("is Figma's: NODE_CHANGES, pasteAssetType STYLE_PROPERTIES_FILL, the source's region, one 100 × 100 rectangle with only the fills", () => {
    const bytes = encodeMessage(message);
    // pasteAssetType is field 41, STYLE_PROPERTIES_FILL 3 (a varuint each).
    expect([...bytes].some((b, i) => b === 41 && bytes[i + 1] === 3)).toBe(true);
    const m = decodeMessage(bytes);
    expect(m).toMatchObject({ type: "NODE_CHANGES", pasteID: 77, pasteFileKey: "lib-1", isCut: false, pasteEditorType: "DESIGN", pasteAssetType: "STYLE_PROPERTIES_FILL" });
    expect(m.pastePageId).toEqual({ sessionID: 0, localID: 1 });
    expect(m.clipboardSelectionRegions).toEqual([{ parent: { sessionID: 0, localID: 1 }, nodes: [{ sessionID: 5, localID: 12 }], focusType: "NONE" }]);
    expect(m.nodeChanges!.map((n) => [n.type, n.name])).toEqual([
      ["DOCUMENT", "Document"],
      ["CANVAS", "Page 1"],
      ["ROUNDED_RECTANGLE", "Rectangle"],
      ["CANVAS", "Internal Only Canvas"],
    ]);
    const rect = m.nodeChanges![2] as any;
    expect(rect).toMatchObject({ size: { x: 100, y: 100 }, transform: { m00: 1, m01: 0, m02: 0, m10: 0, m11: 1, m12: 0 }, strokeJoin: "BEVEL", parentIndex: { guid: { sessionID: 0, localID: 1 } } });
    expect(rect.fillPaints).toHaveLength(1);
    expect(rect.fillPaints[0]).toMatchObject({ type: "SOLID", opacity: 0.5 });
    expect(rect.strokePaints).toBeUndefined();
    expect(rect.effects).toBeUndefined();
    expect(m.nodeChanges![3].internalOnly).toBe(true);
  });

  it("a stroke copy carries strokePaints, an effect copy effects (in the source's order)", () => {
    const stroke = decodeMessage(encodeMessage(rowsMessage("stroke", [red, blue], { layers: ["1:2"], page: "0:1" })));
    expect(stroke.pasteAssetType).toBe("STYLE_PROPERTIES_STROKE");
    expect((stroke.nodeChanges![2] as any).strokePaints.map((p: Paint) => p.color?.r)).toEqual([1, 0]);
    const fx = decodeMessage(encodeMessage(rowsMessage("effect", [{ type: "DROP_SHADOW", visible: true, radius: 4 } as never, { type: "FOREGROUND_BLUR", visible: true, radius: 2 } as never], { layers: ["1:2"], page: "0:1" })));
    expect(fx.pasteAssetType).toBe("STYLE_PROPERTIES_EFFECT");
    expect((fx.nodeChanges![2] as any).effects.map((e: any) => e.type)).toEqual(["DROP_SHADOW", "FOREGROUND_BLUR"]);
    expect(rowsOfMessage(fx)?.items.map((e: any) => e.type)).toEqual(["DROP_SHADOW", "FOREGROUND_BLUR"]);
  });

  it("goes through the clipboard's (figma) archive and back; layers and Copy properties aren't rows", async () => {
    const formats = encodeClipboardKiwi(encodeMessage(message), { fileKey: "lib-1" });
    expect(formats["text/html"]).toContain("(figma)");
    const payload = readClipboard((type) => (type === "text/html" ? formats["text/html"] : null));
    expect(payload?.kind).toBe("archive");
    const bytes = await archiveMessage((payload as { archive: Uint8Array }).archive);
    const read = rowsOfMessage(decodeMessage(bytes!));
    expect(read?.section).toBe("fill");
    expect(read?.items).toEqual([expect.objectContaining({ type: "SOLID", opacity: 0.5, color: { r: 0, g: 0, b: 1, a: 1 } })]);
    expect(isRowsMessage({ type: "NODE_CHANGES", nodeChanges: [] })).toBe(false);
    expect(rowsOfMessage({ type: "STYLE", nodeChanges: [] })).toBeNull();
  });

  it("Figma reads ours with the schema the archive carries: the Message, its pasteAssetType and the rectangle's fills", () => {
    const formats = encodeClipboardKiwi(encodeMessage(message), { fileKey: "lib-1" });
    const archive = (readClipboard((t) => formats[t]) as { archive: Uint8Array }).archive;
    const canvas = decodeCanvas(archive, { inflateRaw: (b) => new Uint8Array(inflateRawSync(b)), deflateRaw: (b) => new Uint8Array(deflateRawSync(b)) });
    expect([...canvas.schema]).toEqual([...SCHEMA_BINARY]);
    const shipped = compileSchema(decodeBinarySchema(canvas.schema)) as any;
    const m = shipped.decodeMessage(canvas.message);
    expect(m.pasteAssetType).toBe("STYLE_PROPERTIES_FILL");
    expect(m.nodeChanges.find((n: any) => n.type === "ROUNDED_RECTANGLE").fillPaints[0].opacity).toBe(0.5);
  });
});

describe("Figma's copy of rows", () => {
  it("reads as rows here: the fill, by pasteAssetType", async () => {
    const html = figmaRowsHtml();
    const payload = readClipboard((t) => (t === "text/html" ? html : null));
    expect(payload?.kind).toBe("archive");
    const p = payload as { archive: Uint8Array; meta: any };
    const bytes = await archiveMessage(p.archive, {
      inflate: async (d) => new Uint8Array(inflateRawSync(d)),
      convert: (schema, m) => decodeFigmaClipboard(schema, m, p.meta).message,
    });
    const m = decodeMessage(bytes!);
    expect(m.pasteAssetType).toBe("STYLE_PROPERTIES_FILL");
    const rows = rowsOfMessage(m);
    expect(rows?.section).toBe("fill");
    expect(rows?.items).toEqual([expect.objectContaining({ type: "SOLID", opacity: 0.5, color: { r: 0, g: 0, b: 1, a: 1 } })]);
  });
});
