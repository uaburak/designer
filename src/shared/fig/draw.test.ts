/**
 * `.fig` fidelity for Figma Draw (docs/draw.md §8, round 7e): a synthetic file written with FIGMA'S OWN schema
 * (the binary schema in docs/research/figma/samples/sections.fig, dumped as figma-schema-106.kiwi; Figma's numbers) holding a TEXT_PATH (`textPathStart` 432, glyph
 * rotations `Glyph.rotation` 9), a TRANSFORM (48) with LINEAR and RADIAL `transformModifiers` (455), a dynamic stroke
 * (448), a scatter brush stroke (446 / 449 / 482 / 488) with its BRUSH node (452) on the internal canvas, a stretch
 * brush (450), variable width points (447), a pattern stroke, `rotationOrigin` (424) and `vectorOperationVersion` (425).
 * Import (the .fig container → our schema) then export (our snapshot as a .fig, read back with Figma's schema) keeps
 * every one of these nodes byte for byte. When the owner supplies a real Draw `.fig` (§11), it joins this test.
 * Synthetic data shaped as Figma's schema says — no real file's content.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { inflateRawSync } from "node:zlib";
import { decodeBinarySchema } from "kiwi-schema";
import { describe, expect, it } from "vitest";
import { codec } from "../schema/document.generated";
import { interpretSchema } from "../schema/dynamic";
import { deflateRawStored, inflateRawStored, type FigCodecs } from "./compression";
import { decodeCanvas, figContainer, readCanvasChunks } from "./container";
import { readFigFile } from "./figFile";
import { encodeFigmaCanvas, toFigmaMessage } from "./figmaExport";
import { decodeAnySchema } from "./importFig";

/* eslint-disable @typescript-eslint/no-explicit-any -- Figma-shaped test data */

const STORED: FigCodecs = { deflateRaw: deflateRawStored, inflateRaw: inflateRawStored };
/** Figma's own binary schema, as embedded in the owner's sample (document version 106; figma-schema-106.kiwi is its dump). */
const sample = readFigFile(new Uint8Array(readFileSync(join(__dirname, "../../../docs/research/figma/samples/sections.fig"))), { inflateRaw: (b) => new Uint8Array(inflateRawSync(b)) });
const FIGMA_SCHEMA_BINARY = new Uint8Array(inflateRawSync(readCanvasChunks(sample.canvas).chunks[0]));
const figma = interpretSchema(decodeBinarySchema(FIGMA_SCHEMA_BINARY));

const g = (s: number, l: number) => ({ sessionID: s, localID: l });
const T = (x: number, y: number) => ({ m00: 1, m01: 0, m02: x, m10: 0, m11: 1, m12: y });
const node = (guid: any, type: string, parent: any, position: string, extra: any = {}) => ({ guid, phase: "CREATED", type, parentIndex: { guid: parent, position }, ...extra });
const black = [{ type: "SOLID", color: { r: 0, g: 0, b: 0, a: 1 }, opacity: 1, visible: true, blendMode: "NORMAL" }];

/** The Draw nodes by GUID key, as Figma writes them. */
function drawFile(): any {
  return {
    type: "NODE_CHANGES",
    sessionID: 0,
    ackID: 0,
    blobs: [{ bytes: new Uint8Array([1, 0, 0, 0, 0, 0, 0, 0, 0]) }, { bytes: new Uint8Array([2, 0, 0, 0, 1, 0, 0, 0, 0, 0, 0, 0]) }],
    nodeChanges: [
      { guid: g(0, 0), phase: "CREATED", type: "DOCUMENT", name: "Document" },
      node(g(0, 1), "CANVAS", g(0, 0), "!", { name: "Page 1" }),
      node(g(0, 2), "CANVAS", g(0, 0), "~", { name: "Internal Only Canvas", internalOnly: true }),
      // A scatter brush and a stretch brush, as Figma keeps them: BRUSH nodes on the internal canvas.
      node(g(1, 40), "BRUSH", g(0, 2), "!", { name: "Bubblegum", brushType: "SCATTER", size: { x: 64, y: 64 }, transform: T(0, 0), vectorData: { vectorNetworkBlob: 1, normalizedSize: { x: 64, y: 64 } } }),
      node(g(1, 41), "BRUSH", g(0, 2), '"', { name: "Heist", brushType: "STRETCH", size: { x: 256, y: 16 }, transform: T(0, 100), vectorData: { vectorNetworkBlob: 1, normalizedSize: { x: 256, y: 16 } } }),
      // A transform group: Linear repeat (X, 4 × 12 px) then Radial repeat (8, relative 0.5, reversed), its source child.
      node(g(1, 1), "TRANSFORM", g(0, 1), "!", {
        name: "Repeat group 1",
        size: { x: 200, y: 40 },
        transform: T(0, 0),
        transformModifiers: [
          { type: "REPEAT", offset: { x: 12, y: 0 }, visible: true, count: 4, repeatType: "LINEAR", axis: "X", unitType: "PIXELS", order: "FORWARD" },
          { type: "REPEAT", offset: { x: 0.5, y: 0 }, visible: false, count: 8, repeatType: "RADIAL", axis: "X", unitType: "RELATIVE", order: "REVERSE" },
          { type: "SKEW", visible: true, skewX: 0.25, skewY: -0.5 },
        ],
      }),
      node(g(1, 2), "ELLIPSE", g(1, 1), "!", { name: "Dot", size: { x: 20, y: 20 }, transform: T(0, 0), fillPaints: black }),
      // Text on a circle: started halfway along segment 2, flipped; its placed glyphs carry their turn.
      node(g(1, 3), "TEXT_PATH", g(0, 1), '"', {
        name: "Around",
        size: { x: 100, y: 100 },
        transform: T(300, 0),
        vectorData: { vectorNetworkBlob: 0, normalizedSize: { x: 100, y: 100 } },
        textData: { characters: "Hi" },
        fontSize: 12,
        textAlignHorizontal: "CENTER",
        textAlignVertical: "BOTTOM",
        textPathStart: { tValue: 2.5, forward: false },
        fillPaints: black,
        derivedTextData: {
          layoutSize: { x: 100, y: 100 },
          glyphs: [
            { commandsBlob: 0, position: { x: 50, y: 0 }, fontSize: 12, firstCharacter: 0, advance: 0.5, rotation: 0.25 },
            { commandsBlob: 0, position: { x: 56, y: 1 }, fontSize: 12, firstCharacter: 1, advance: 0.25, rotation: 0.5 },
          ],
        },
      }),
      // A dynamic stroke with its seed.
      node(g(1, 4), "VECTOR", g(0, 1), "#", { name: "Squiggle", size: { x: 120, y: 30 }, transform: T(0, 200), strokePaints: black, strokeWeight: 3, dynamicStrokeSettings: { frequency: 2.5, wiggle: 1.5, smoothen: 0.75 }, strokeSeed: 123456789012345n, vectorData: { vectorNetworkBlob: 0, normalizedSize: { x: 120, y: 30 } } }),
      // A scatter brush stroke: the brush, its settings, its seed and Figma's stamp transforms.
      node(g(1, 5), "VECTOR", g(0, 1), "$", {
        name: "Bubbles",
        size: { x: 120, y: 30 },
        transform: T(0, 300),
        strokePaints: black,
        strokeWeight: 8,
        strokeBrushGuid: g(1, 40),
        scatterStrokeSettings: { gap: 1.25, wiggle: 0.5, angularJitter: -30, rotation: 45, sizeJitter: 0.5 },
        strokeSeed: 42n,
        scatterBrushTransforms: [T(0, 0), { m00: 0.5, m01: 0, m02: 10, m10: 0, m11: 0.5, m12: 2 }],
        vectorData: { vectorNetworkBlob: 0, normalizedSize: { x: 120, y: 30 } },
      }),
      // A stretch brush run backwards, variable width points, a pattern stroke, a rotation origin.
      node(g(1, 6), "VECTOR", g(0, 1), "%", {
        name: "Ink",
        size: { x: 120, y: 30 },
        transform: T(0, 400),
        strokePaints: [{ type: "PATTERN", opacity: 1, visible: true, blendMode: "NORMAL", sourceNodeId: g(1, 2), patternTileType: "RECTANGULAR", scale: 0.5, patternSpacing: { x: 4, y: 4 }, horizontalAlignment: "CENTER" }],
        strokeWeight: 6,
        strokeBrushGuid: g(1, 41),
        stretchStrokeSettings: { orientation: "REVERSE" },
        variableWidthPoints: [{ position: 0, ascent: 0.5, descent: 0.5 }, { position: 0.5, ascent: 1, descent: 0.25, segmentId: 1 }],
        rotationOrigin: { x: 60, y: 15 },
        vectorOperationVersion: 2,
        vectorData: { vectorNetworkBlob: 0, normalizedSize: { x: 120, y: 30 } },
      }),
    ],
  };
}

const key = (n: any) => `${n.guid.sessionID}:${n.guid.localID}`;
const DRAW_IDS = ["1:1", "1:2", "1:3", "1:4", "1:5", "1:6", "1:40", "1:41"];

/** Figma's file: Figma's schema in the container, the Message encoded with it. */
function figmaFig(): Uint8Array {
  return figContainer(FIGMA_SCHEMA_BINARY, figma.encode("Message", drawFile()), 106, STORED);
}

/** .fig → ours (the import's decoding, Figma's derived data kept as a .fig import does). */
function importFig(bytes: Uint8Array) {
  const canvas = decodeCanvas(bytes, STORED);
  return decodeAnySchema(canvas.schema, canvas.message, { keepDerived: true });
}

describe(".fig round trip of Draw's fields (docs/draw.md §8)", () => {
  it("our schema has Figma's numbers for every Draw field: our encoding, read with Figma's schema, is Figma's node", () => {
    for (const n of drawFile().nodeChanges.filter((x: any) => DRAW_IDS.includes(key(x)))) {
      const readByFigma = figma.decode("NodeChange", codec.encodeNodeChange(n));
      expect(toHexString(figma.encode("NodeChange", readByFigma)), key(n)).toBe(toHexString(figma.encode("NodeChange", n)));
    }
  });

  it("import keeps TEXT_PATH, TRANSFORM, dynamic / brush strokes, the BRUSH nodes and the rest, nothing dropped", () => {
    const { message, report } = importFig(figmaFig());
    const byId = new Map(message.nodeChanges!.map((n) => [key(n), n as any]));
    expect(byId.get("1:1").type).toBe("TRANSFORM");
    expect(byId.get("1:1").transformModifiers).toHaveLength(3);
    expect(byId.get("1:1").transformModifiers[1]).toMatchObject({ repeatType: "RADIAL", unitType: "RELATIVE", order: "REVERSE", count: 8, visible: false });
    expect(byId.get("1:3").type).toBe("TEXT_PATH");
    expect(byId.get("1:3").textPathStart).toEqual({ tValue: 2.5, forward: false });
    expect(byId.get("1:3").derivedTextData.glyphs.map((gl: any) => gl.rotation)).toEqual([0.25, 0.5]);
    expect(byId.get("1:4").dynamicStrokeSettings).toEqual({ frequency: 2.5, wiggle: 1.5, smoothen: 0.75 });
    expect(byId.get("1:4").strokeSeed).toBe(123456789012345n);
    expect(byId.get("1:5").strokeBrushGuid).toEqual(g(1, 40));
    expect(byId.get("1:5").scatterBrushTransforms).toHaveLength(2);
    expect(byId.get("1:40")).toMatchObject({ type: "BRUSH", brushType: "SCATTER", name: "Bubblegum" });
    expect(byId.get("1:6").stretchStrokeSettings).toEqual({ orientation: "REVERSE" });
    expect(byId.get("1:6").strokePaints[0]).toMatchObject({ type: "PATTERN", sourceNodeId: g(1, 2) });
    expect(byId.get("1:6").rotationOrigin).toEqual({ x: 60, y: 15 });
    expect(byId.get("1:6").vectorOperationVersion).toBe(2);
    const dropped = Object.keys(report?.droppedFields ?? {});
    for (const f of ["textPathStart", "transformModifiers", "rotation", "dynamicStrokeSettings", "scatterStrokeSettings", "stretchStrokeSettings", "strokeBrushGuid", "strokeSeed", "scatterBrushTransforms", "brushType", "variableWidthPoints", "rotationOrigin", "vectorOperationVersion"])
      expect(dropped.filter((d) => d.endsWith(`.${f}`)), f).toEqual([]);
  });

  it("import → export: Figma reads our .fig back and every Draw node is byte for byte the one it wrote", () => {
    const { message } = importFig(figmaFig());
    // Our export (Save Local Copy re-encodes the snapshot the way Figma writes its own: figmaExport.ts).
    const exported = encodeFigmaCanvas(message, STORED);
    const canvas = decodeCanvas(exported, STORED);
    // A reader takes the schema the container carries (kiwi files are self-describing), then Figma's own encoding of
    // each Draw node is compared: the same bytes as the file Figma wrote.
    const back = interpretSchema(decodeBinarySchema(canvas.schema)).decode("Message", canvas.message);
    const before = new Map(drawFile().nodeChanges.map((n: any) => [key(n), n]));
    const after = new Map(back.nodeChanges.map((n: any) => [key(n), n]));
    // The export writes out what Figma always writes (visible, opacity, the stroke basics) at the values absence meant.
    const BASE: Record<string, unknown> = { visible: true, opacity: 1, strokeWeight: 0, strokeAlign: "CENTER", strokeJoin: "MITER" };
    for (const id of DRAW_IDS) {
      const b: any = before.get(id);
      const a: any = { ...(after.get(id) as object) };
      for (const k of Object.keys(a)) if (!(k in b)) {
        expect(BASE[k], `${id}.${k}`).toEqual(a[k]);
        delete a[k];
      }
      expect(toHexString(figma.encode("NodeChange", a)), id).toBe(toHexString(figma.encode("NodeChange", b)));
    }
    // …and ours imports it again as exported.
    const again = importFig(exported).message;
    const { derivedDataVersion: _stamp, ...rest } = again;
    expect(rest).toEqual(toFigmaMessage(message));
  });
});

function toHexString(b: Uint8Array): string {
  return Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");
}
