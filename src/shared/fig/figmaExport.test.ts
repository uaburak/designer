/**
 * Save Local Copy writes a `canvas.fig` Figma opens (figmaExport.ts): checked against Figma's own export
 * (docs/research/figma/samples/sections.fig, version 106) — the header, the schema (a strict subset of Figma's), the
 * Message read with FIGMA'S schema, the fields Figma writes on every node — and read back by our importer.
 * Synthetic nodes; no real file's content.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { deflateRawSync, inflateRawSync, zstdCompressSync, zstdDecompressSync } from "node:zlib";
import { decodeBinarySchema, parseSchema } from "kiwi-schema";
import { describe, expect, it } from "vitest";
import type { Message, NodeChange } from "../schema/document.generated";
import { DERIVED_FIELDS, NodeTable, tablesEqual } from "../schema/patch";
import { interpretSchema } from "../schema/dynamic";
import type { FigCodecs } from "./compression";
import { decodeCanvas, readCanvasChunks } from "./container";
import { FIGMA_DERIVED_DATA_VERSION } from "./convert";
import { readFigFile } from "./figFile";
import { encodeFigmaCanvas, FIGMA_FILE_VERSION, figmaExportSchema, toFigmaMessage } from "./figmaExport";
import { decodeAnySchema } from "./importFig";

/* eslint-disable @typescript-eslint/no-explicit-any -- Figma-shaped values */

const codecs: FigCodecs = {
  inflateRaw: (b) => new Uint8Array(inflateRawSync(b)),
  deflateRaw: (b) => new Uint8Array(deflateRawSync(b)),
  zstdDecompress: (b) => new Uint8Array(zstdDecompressSync(b)),
  zstdCompress: (b) => new Uint8Array(zstdCompressSync(b)),
};

const sample = readFigFile(new Uint8Array(readFileSync(join(__dirname, "../../../docs/research/figma/samples/sections.fig"))), codecs);
const sampleCanvas = decodeCanvas(sample.canvas, codecs);
const figmaSchema = decodeBinarySchema(sampleCanvas.schema);
const figma = interpretSchema(figmaSchema);
const figmaMessage = figma.decode("Message", sampleCanvas.message);
/** The schema embedded in Figma's current build (2026-10-15): fields newer than the sample (Motion's, R17 batch C). */
const figmaCurrent = parseSchema(readFileSync(join(__dirname, "../../../docs/research/figma/figma-schema-current.kiwi"), "utf8"));

const g = (s: number, l: number) => ({ sessionID: s, localID: l });
const T = (x: number, y: number) => ({ m00: 1, m01: 0, m02: x, m10: 0, m11: 1, m12: y });
const node = (guid: any, type: string, parent: any, position: string, extra: any = {}): NodeChange => ({ guid, phase: "CREATED", type, parentIndex: { guid: parent, position }, ...extra });
const S = 1 << 20; // our sessions (docs/data.md §1)

/** A snapshot as our store keeps it: our session, our engine's derived data and stamp, our own fields. */
function ourSnapshot(): Message {
  const vn = new Uint8Array(12 + 2 * 12 + 28); // 2 vertices, 1 segment
  new DataView(vn.buffer).setUint32(0, 2, true);
  new DataView(vn.buffer).setUint32(4, 1, true);
  new DataView(vn.buffer).setUint32(12 + 24 + 16, 1, true); // segment end vertex
  return {
    type: "NODE_CHANGES",
    sessionID: S + 36,
    ackID: 0,
    derivedDataVersion: 3,
    blobs: [{ bytes: new Uint8Array([1, 0, 0, 0, 0, 0, 0, 0, 0, 0]) }, { bytes: vn }],
    nodeChanges: [
      { guid: g(0, 0), phase: "CREATED", type: "DOCUMENT", name: "Document", documentColorProfile: "SRGB", librarySubscriptions: [] } as any,
      node(g(0, 1), "CANVAS", g(0, 0), "!", { name: "Page 1", backgroundColor: { r: 0.5, g: 0.5, b: 0.5, a: 1 }, backgroundEnabled: true }),
      node(g(0, 2), "CANVAS", g(0, 0), "~", { name: "Internal Only Canvas", visible: false, internalOnly: true }),
      node(g(S + 1, 1), "FRAME", g(0, 1), "!", { name: "Frame", size: { x: 100, y: 50 }, invertedCornerMask: 1, fillGeometry: [{ windingRule: "NONZERO", commandsBlob: 0, styleID: 0 }] }),
      node(g(S + 1, 2), "TEXT", g(S + 1, 1), "!", {
        name: "Hello",
        size: { x: 40, y: 30 },
        transform: T(4, 4),
        textData: { characters: "Hello\nWorld" },
        derivedTextData: { layoutSize: { x: 40, y: 30 }, glyphs: [{ commandsBlob: 0, position: { x: 0, y: 12 }, fontSize: 12, firstCharacter: 0, advance: 0.5 }] },
      }),
      node(g(S + 1, 3), "VECTOR", g(S + 1, 1), "\"", { name: "Line", size: { x: 10, y: 0 }, vectorData: { vectorNetworkBlob: 1, normalizedSize: { x: 10, y: 0 } } }),
    ],
  } as Message;
}

const byKey = (m: any) => new Map<string, any>((m.nodeChanges ?? []).map((n: any) => [`${n.guid.sessionID}:${n.guid.localID}`, n]));

describe("Save Local Copy as Figma writes a .fig (figmaExport.ts)", () => {
  it("embeds a schema that is a strict subset of Figma's: same definitions, field numbers and types", () => {
    const ours = decodeBinarySchema(figmaExportSchema());
    // Figma's sample (version 106) first; what only Figma's current build has is checked against its schema.
    const theirs = new Map(figmaSchema.definitions.map((d) => [d.name, d]));
    const current = new Map(figmaCurrent.definitions.map((d) => [d.name, d]));
    const problems: string[] = [];
    for (const d of ours.definitions) {
      const t = theirs.get(d.name) ?? current.get(d.name);
      if (!t) {
        problems.push(`definition ${d.name}`);
        continue;
      }
      if (t.kind !== d.kind) problems.push(`${d.name} kind`);
      const tf = new Map(t.fields.map((f) => [f.name, f]));
      const cf = new Map((current.get(d.name)?.fields ?? []).map((f) => [f.name, f]));
      for (const f of d.fields) {
        const x = tf.get(f.name) ?? cf.get(f.name);
        if (!x) problems.push(`${d.name}.${f.name}`);
        else if (x.value !== f.value || x.type !== f.type || x.isArray !== f.isArray) problems.push(`${d.name}.${f.name} ${f.value}:${f.type} vs ${x.value}:${x.type}`);
      }
      if (d.kind === "STRUCT") expect(d.fields.map((f) => f.name), d.name).toEqual(t.fields.map((f) => f.name));
    }
    expect(problems).toEqual([]);
    expect(ours.definitions.some((d) => d.fields.some((f) => /^_r\d+$/.test(f.name)))).toBe(false);
  });

  it("writes Figma's header and a Message Figma's own schema reads, with what Figma writes on every node", () => {
    const bytes = encodeFigmaCanvas(ourSnapshot(), codecs);
    const head = readCanvasChunks(bytes);
    expect(head.prelude).toBe("fig-kiwi");
    expect(head.version).toBe(FIGMA_FILE_VERSION);
    expect(head.version).toBe(sampleCanvas.version);
    const canvas = decodeCanvas(bytes, codecs);
    expect(canvas.compression).toBe(sampleCanvas.compression);
    // Read with FIGMA's schema, not the one the file carries.
    const m = figma.decode("Message", canvas.message);
    expect(m.sessionID).toBe(0);
    expect(m.ackID).toBe(0);
    expect(m.derivedDataVersion).toBeUndefined();
    const nodes = byKey(m);
    expect(nodes.get("0:0").librarySubscriptions).toBeUndefined();
    expect(nodes.get(`${S + 1}:1`).invertedCornerMask).toBeUndefined();
    // Our engine's derived data is not Figma's: it goes, and so do the blobs only it used.
    for (const n of nodes.values()) for (const f of DERIVED_FIELDS) expect(n[f], f).toBeUndefined();
    expect(m.blobs).toHaveLength(1);
    expect(nodes.get(`${S + 1}:3`).vectorData.vectorNetworkBlob).toBe(0);
    expect(m.blobs[0].bytes).toEqual(ourSnapshot().blobs![1].bytes);
    // Every field Figma's export writes on every node of a type, ours writes too (of the ones that have a default).
    const always = new Map<string, Set<string>>();
    for (const n of figmaMessage.nodeChanges) {
      const keys = new Set(Object.keys(n));
      const cur = always.get(n.type);
      always.set(n.type, cur ? new Set([...cur].filter((k) => keys.has(k))) : keys);
    }
    const BASE = ["visible", "opacity", "transform", "strokeWeight", "strokeAlign", "strokeJoin", "size"];
    for (const n of nodes.values()) {
      const expected = [...(always.get(n.type) ?? always.get("FRAME")!)].filter((k) => BASE.includes(k));
      expect(expected.length, n.type).toBeGreaterThan(0);
      for (const k of expected) expect(n[k], `${n.type}.${k}`).toBeDefined();
    }
    expect(nodes.get("0:0")).toMatchObject({ visible: true, opacity: 1, strokeWeight: 0, strokeAlign: "CENTER", strokeJoin: "BEVEL" });
    expect(nodes.get("0:2").visible).toBe(false);
    const text = nodes.get(`${S + 1}:2`);
    expect(text).toMatchObject({ fontSize: 12, fontName: { family: "Inter", style: "Regular" }, lineHeight: { value: 100, units: "PERCENT" }, textAlignVertical: "TOP" });
    expect(text.textData.lines).toHaveLength(2); // one per paragraph, as Figma writes
    expect(text.textData.lines[0]).toMatchObject({ lineType: "PLAIN", styleId: 0 });
  });

  it("keeps Figma's own derived data (a .fig import's text layout) and round-trips through our importer", () => {
    const figmaStamped = { ...ourSnapshot(), derivedDataVersion: FIGMA_DERIVED_DATA_VERSION };
    const kept = byKey(toFigmaMessage(figmaStamped));
    expect(kept.get(`${S + 1}:2`).derivedTextData).toBeDefined();

    const exported = toFigmaMessage(ourSnapshot());
    const canvas = decodeCanvas(encodeFigmaCanvas(ourSnapshot(), codecs), codecs);
    const { message: back } = decodeAnySchema(canvas.schema, canvas.message, { keepDerived: true });
    expect(tablesEqual(NodeTable.fromMessage(back), NodeTable.fromMessage(exported))).toBe(true);
    // Nothing but derived data, our own fields and Figma's always-written defaults changed.
    const before = byKey(ourSnapshot());
    for (const [k, n] of byKey(back)) expect(n.name).toBe(before.get(k).name);
  });
});

describe("the schema round's fields in an export (R17 batch C)", () => {
  it("writes gradient interpolation and edit scopes as Figma's schema reads them", () => {
    const base = ourSnapshot();
    const rect = node(g(S + 3, 1), "ROUNDED_RECTANGLE", g(0, 1), "#", {
      size: { x: 10, y: 10 },
      editScopeInfo: { editScopeStacks: [{ stack: [{ type: "AI", label: "Agent" }] }] },
      fillPaints: [{ type: "GRADIENT_LINEAR", interpolationColorSpace: "OKLCH", interpolationHueMethod: "INCREASING", stops: [] } as any],
    });
    const canvas = decodeCanvas(encodeFigmaCanvas({ ...base, nodeChanges: [...base.nodeChanges!, rect] } as Message, codecs), codecs);
    const out = byKey(figma.decode("Message", canvas.message)).get(`${S + 3}:1`);
    expect(out.fillPaints[0]).toMatchObject({ interpolationColorSpace: "OKLCH", interpolationHueMethod: "INCREASING" });
    expect(out.editScopeInfo.editScopeStacks[0].stack[0]).toMatchObject({ type: "AI", label: "Agent" });
  });
});

describe("components as Figma stores them (components.md task 8)", () => {
  const SET = g(S + 2, 1), V1 = g(S + 2, 2), V2 = g(S + 2, 3), T1 = g(S + 2, 4), T2 = g(S + 2, 5), R1 = g(S + 2, 6);
  const LOCAL = g(S + 2, 7), COPY = g(S + 2, 8), INST = g(S + 2, 9);
  const LABEL = g(S + 2, 20), SHOW = g(S + 2, 21), SIZE = g(S + 2, 22);
  const KEY = "a".repeat(40);
  const ref = (field: string, resolved: string, def: any) => ({ variableField: field, variableData: { dataType: "PROP_REF", resolvedDataType: resolved, value: { propRefValue: { defId: def } } } });
  function components(): Message {
    const base = ourSnapshot();
    const nodes = base.nodeChanges!.slice(0, 3);
    nodes.push(
      node(SET, "FRAME", g(0, 1), "#", {
        name: "Button",
        isStateGroup: true,
        size: { x: 200, y: 100 },
        key: "b".repeat(40),
        componentPropDefs: [
          { id: SIZE, name: "Size", type: "VARIANT", initialValue: { textValue: { characters: "S" } }, sortPosition: "!" },
          { id: LABEL, name: "Label", type: "TEXT", initialValue: { textValue: { characters: "Go" } }, sortPosition: "\"" },
          { id: SHOW, name: "Show icon", type: "BOOL", initialValue: { boolValue: true }, sortPosition: "#" },
        ],
      }),
      node(V1, "SYMBOL", SET, "!", { name: "Size=S", size: { x: 100, y: 40 }, variantPropSpecs: [{ propDefId: SIZE, value: "S" }] }),
      node(T1, "TEXT", V1, "!", { name: "Label", textData: { characters: "Go" }, parameterConsumptionMap: { entries: [ref("TEXT_DATA", "TEXT_DATA", LABEL)] } }),
      node(R1, "RECTANGLE", V1, "\"", { name: "Icon", parameterConsumptionMap: { entries: [ref("VISIBLE", "BOOLEAN", SHOW)] } }),
      node(V2, "SYMBOL", SET, "\"", { name: "Size=L", size: { x: 100, y: 40 }, variantPropSpecs: [{ propDefId: SIZE, value: "L" }] }),
      node(T2, "TEXT", V2, "!", { name: "Label", textData: { characters: "Go" }, parameterConsumptionMap: { entries: [ref("TEXT_DATA", "TEXT_DATA", LABEL)] } }),
      node(LOCAL, "SYMBOL", g(0, 1), "$", { name: "Published", size: { x: 10, y: 10 }, key: KEY }),
      node(COPY, "SYMBOL", g(0, 2), "!", { name: "From a library", size: { x: 10, y: 10 }, key: "c".repeat(40), version: "v7", sourceLibraryKey: "LIBFILE", publishID: g(1, 2) }),
      node(INST, "INSTANCE", g(0, 1), "%", { name: "Published", size: { x: 10, y: 10 }, symbolData: { symbolID: LOCAL, symbolOverrides: [{ guidPath: { guids: [] }, opacity: 0.5 }] } }),
    );
    return { ...base, derivedDataVersion: 0, blobs: [], nodeChanges: nodes } as Message;
  }

  it("writes componentKey / sharedSymbolVersion, implicit defs on variants, componentPropRefs and the root override path", () => {
    const canvas = decodeCanvas(encodeFigmaCanvas(components(), codecs), codecs);
    const nodes = byKey(figma.decode("Message", canvas.message));
    const k = (x: any) => `${x.sessionID}:${x.localID}`;
    expect(nodes.get(k(LOCAL))).toMatchObject({ componentKey: KEY });
    expect(nodes.get(k(LOCAL)).key).toBeUndefined();
    expect(nodes.get(k(COPY))).toMatchObject({ componentKey: "c".repeat(40), sharedSymbolVersion: "v7" });
    expect(nodes.get(k(COPY)).version).toBeUndefined();
    expect(nodes.get(k(SET)).key).toBe("b".repeat(40)); // sets keep key 319
    // Each variant: one implicit def per explicit non-VARIANT def, its bindings on its own implicit ids.
    for (const [v, t] of [
      [V1, T1],
      [V2, T2],
    ]) {
      const defs = nodes.get(k(v)).componentPropDefs;
      expect(defs.map((d: any) => [d.name, d.type, k(d.parentPropDefId)])).toEqual([
        ["Label", "TEXT", k(LABEL)],
        ["Show icon", "BOOL", k(SHOW)],
      ]);
      const label = defs[0];
      expect(label.initialValue.textValue.characters).toBe("Go");
      const text = nodes.get(k(t));
      expect(k(text.parameterConsumptionMap.entries[0].variableData.value.propRefValue.defId)).toBe(k(label.id));
      expect(text.componentPropRefs).toEqual([{ nodeField: 42, defID: label.id, componentPropNodeField: "TEXT_DATA", isDeleted: undefined, zombieFallbackName: undefined }].map((r) => JSON.parse(JSON.stringify(r))));
    }
    const ids = [...nodes.get(k(V1)).componentPropDefs, ...nodes.get(k(V2)).componentPropDefs].map((d: any) => k(d.id));
    expect(new Set(ids).size).toBe(4);
    for (const id of ids) expect(nodes.has(id)).toBe(false);
    expect(nodes.get(k(R1)).componentPropRefs[0]).toMatchObject({ nodeField: 6, componentPropNodeField: "VISIBLE" });
    expect(nodes.get(k(INST)).symbolData.symbolOverrides[0].guidPath.guids).toEqual([LOCAL]);
  });

  it("reads back through our importer as the model it came from", () => {
    const canvas = decodeCanvas(encodeFigmaCanvas(components(), codecs), codecs);
    const { message: back } = decodeAnySchema(canvas.schema, canvas.message, { keepDerived: true });
    const before = byKey(components());
    const after = byKey(back);
    for (const id of [SET, V1, V2, T1, T2, R1, LOCAL, COPY, INST].map((x) => `${x.sessionID}:${x.localID}`)) {
      const a = after.get(id);
      const b = before.get(id);
      for (const f of ["key", "version", "componentPropDefs", "parameterConsumptionMap", "variantPropSpecs", "symbolData", "sourceLibraryKey"]) expect(a[f], `${id}.${f}`).toEqual(b[f]);
      expect(a.componentKey).toBeUndefined();
      expect(a.componentPropRefs).toBeUndefined();
    }
  });
});
