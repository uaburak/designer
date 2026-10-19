// Figma's ⌘C on a selected Fill row, as measured live on 2026-10-19 (docs/research/figma/live/2026-10-18/property-rows-copy.txt):
// clipboard HTML with (figmeta) and a (figma) fig-kiwi archive in Figma's own schema (the one embedded in
// docs/research/figma/samples/sections.fig, version 106) holding NODE_CHANGES with pasteAssetType STYLE_PROPERTIES_FILL
// and one temporary rectangle with fillPaints [SOLID 0000FF, opacity 0.5].
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { deflateRawSync, inflateRawSync } from "node:zlib";
import { compileSchema, decodeBinarySchema } from "kiwi-schema";
import { bytesToB64 } from "../model/clipboard";
import { figContainer, readCanvasChunks } from "../../../../shared/fig/container";
import { readFigFile } from "../../../../shared/fig/figFile";

/* eslint-disable @typescript-eslint/no-explicit-any -- Figma-schema values */

/** Figma's ⌘C on a Fill row, as measured (pasteAssetType STYLE_PROPERTIES_FILL, fillPaints [SOLID 0000FF 50 %]), in Figma's own schema. */
export function figmaRowsHtml(): string {
  const sample = readFigFile(new Uint8Array(readFileSync(join(__dirname, "../../../../../docs/research/figma/samples/sections.fig"))), { inflateRaw: (b) => new Uint8Array(inflateRawSync(b)) });
  const schema = new Uint8Array(inflateRawSync(readCanvasChunks(sample.canvas).chunks[0]));
  const figma = compileSchema(decodeBinarySchema(schema)) as any;
  const g = (s: number, l: number) => ({ sessionID: s, localID: l });
  const identity = { m00: 1, m01: 0, m02: 0, m10: 0, m11: 1, m12: 0 };
  const message = figma.encodeMessage({
    type: "NODE_CHANGES",
    sessionID: 0,
    ackID: 0,
    pasteID: 1234,
    pasteFileKey: "AbCdEf",
    pastePageId: g(0, 1),
    isCut: false,
    pasteEditorType: "DESIGN",
    clipboardSelectionRegions: [{ parent: g(0, 1), nodes: [g(2, 7)], focusType: "NONE" }],
    pasteAssetType: "STYLE_PROPERTIES_FILL",
    nodeChanges: [
      { guid: g(0, 0), phase: "CREATED", type: "DOCUMENT", name: "Document", visible: true, opacity: 1, transform: identity },
      { guid: g(0, 1), phase: "CREATED", parentIndex: { guid: g(0, 0), position: "!" }, type: "CANVAS", name: "Page 1", visible: true, opacity: 1, transform: identity },
      {
        guid: g(9, 1),
        phase: "CREATED",
        parentIndex: { guid: g(0, 1), position: "!" },
        type: "ROUNDED_RECTANGLE",
        name: "Rectangle",
        visible: true,
        opacity: 1,
        size: { x: 100, y: 100 },
        transform: identity,
        strokeJoin: "BEVEL",
        fillPaints: [{ type: "SOLID", color: { r: 0, g: 0, b: 1, a: 1 }, opacity: 0.5, visible: true, blendMode: "NORMAL", authoredColor: { color: { r: 0, g: 0, b: 1, a: 1 }, colorSpace: "SRGB" } }],
      },
      { guid: g(0, 2), phase: "CREATED", parentIndex: { guid: g(0, 0), position: '"' }, type: "CANVAS", name: "Internal Only Canvas", visible: false, opacity: 1, transform: identity, internalOnly: true },
    ],
  });
  const archive = bytesToB64(figContainer(schema, message, 106, { deflateRaw: (b) => new Uint8Array(deflateRawSync(b)), inflateRaw: (b) => new Uint8Array(inflateRawSync(b)) }));
  const meta = Buffer.from(JSON.stringify({ fileKey: "AbCdEf", pasteID: 1234, dataType: "scene" })).toString("base64");
  return `<meta charset="utf-8"><div><span data-metadata="<!--(figmeta)${meta}(/figmeta)-->"></span><span data-buffer="<!--(figma)${archive}(/figma)-->"></span></div>`;
}
