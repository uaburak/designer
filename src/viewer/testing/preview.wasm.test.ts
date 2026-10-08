// The engine's derived snapshot of a synthetic file, packaged as the store packages it: the pages and frames, the
// image, the derived-data stamp, the text outlines (docs/data.md §13, docs/schema.md §4.1 "preview snapshot").
import { deflateRawSync, inflateRawSync } from "node:zlib";
import { describe, expect, it } from "vitest";
import { decodeCanvas } from "@shared/fig/container";
import { inlinePreviewHtml, PREVIEW_DATA_PLACEHOLDER, readInlinePreview } from "@shared/preview/html";
import { buildPreviewPackage } from "@shared/preview/package";
import { decodeMessage } from "@shared/schema/codec";
import { Engine } from "@/engine/Engine";
import { Status } from "@/engine/abi";
import { syntheticPreview } from "./synthetic";
import { ViewerDoc } from "../viewerDoc";

const codecs = { deflateRaw: (d: Uint8Array) => new Uint8Array(deflateRawSync(d)), inflateRaw: (d: Uint8Array) => new Uint8Array(inflateRawSync(d)) };

describe("a preview of a synthetic file (engine, headless)", () => {
  it("carries every page's derived text and instance layout, its image, pages and frames", async () => {
    const { snapshot, image } = await syntheticPreview();
    const message = decodeMessage(snapshot);
    expect(message.derivedDataVersion).toBe(3);  // the engine's stamp (Editor::kDerivedDataVersion)
    const byName = (name: string) => message.nodeChanges!.find((n) => n.name === name && n.type !== "VARIABLE")!;
    // Text outlines for both texts (the viewer draws the italic one from them: it ships the upright Inter only).
    expect(byName("Title").derivedTextData?.glyphs?.length).toBeGreaterThan(5);
    expect(byName("Caption").derivedTextData?.glyphs?.length).toBeGreaterThan(5);
    expect(message.nodeChanges!.find((n) => n.type === "INSTANCE")!.derivedSymbolData?.length).toBe(1);

    const pkg = await buildPreviewPackage(
      { snapshot, fileName: "Synthetic", previewId: "s".repeat(22), now: 0, options: { pageIds: "all", inspect: true, export: true, expiresInDays: null }, readImage: async (s) => (s === image.sha1 ? image.bytes : null) },
      codecs,
    );
    expect(pkg.manifest.pages).toEqual([
      { id: "0:1", name: "Page 1", frames: [{ id: "1:30", name: "Badge", type: "INSTANCE" }, { id: "1:20", name: "Badge", type: "SYMBOL" }, { id: "1:10", name: "Other", type: "FRAME" }, { id: "1:1", name: "Card", type: "FRAME" }] },
      { id: "0:3", name: "Second page", frames: [{ id: "1:40", name: "Elsewhere", type: "FRAME" }] },
    ]);
    expect(pkg.manifest.images).toEqual([image.sha1]);
    expect(pkg.manifest.derivedDataVersion).toBe(message.derivedDataVersion);

    // Through the HTML data block and back, the engine loads it read as it was written: its stored layout used.
    const html = inlinePreviewHtml(`<html><head><title>x</title></head><body>${PREVIEW_DATA_PLACEHOLDER}</body></html>`, pkg);
    const back = readInlinePreview(/<script id="designer-preview-data" type="application\/json">([^<]*)<\/script>/.exec(html)![1]);
    const bytes = decodeCanvas(back.doc, codecs).message;
    const viewer = await Engine.create(null, { sessionID: 1 });
    try {
      expect(viewer.loadKiwi(bytes, { page: "0:1" })).toBe(Status.OK);
      expect(viewer.stats().derivedUsed).toBeGreaterThanOrEqual(1);
      expect(viewer.pages().map((p) => p.name)).toEqual(["Page 1", "Second page"]);
      const variables = viewer.boundVariables("1:1");
      expect(variables.map((b) => [b.target, viewer.variable(b.variable!)?.name])).toEqual([["fillPaints[0].color", "Surface"]]);
      expect(viewer.styles("TEXT").map((s) => s.name)).toEqual(["Heading 1"]);
      // What the Inspect panel reads: the variable's collection and mode, the text style's name, the parent's layout.
      const doc = new ViewerDoc(viewer);
      expect(doc.inspect("1:1")?.variables["fillPaints[0].color"]).toMatchObject({ name: "Surface", collection: "Colors", mode: "Mode 1" });
      expect(doc.inspect("1:2")?.styles?.text).toBe("Heading 1");
      expect(doc.inspect("1:2")?.parentStackMode).toBe("VERTICAL");
      expect(doc.pageBox("1:3")).toEqual({ x: 24, y: 54, width: 272, height: 120 });
      expect(doc.tree("0:1").roots).toEqual(["1:30", "1:20", "1:10", "1:1"]);
    } finally {
      viewer.destroy();
    }
  }, 30_000);
});
