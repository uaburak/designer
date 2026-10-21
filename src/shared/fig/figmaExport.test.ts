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
import { guidKey } from "../schema/guid";
import { DERIVED_FIELDS, NodeTable, tablesEqual } from "../schema/patch";
import { interpretSchema } from "../schema/dynamic";
import type { FigCodecs } from "./compression";
import { decodeCanvas, readCanvasChunks } from "./container";
import { FIGMA_DERIVED_DATA_VERSION } from "./convert";
import { readFigFile } from "./figFile";
import { encodeFigmaCanvas, FIGMA_FILE_VERSION, figmaExportSchema, figmaVariantDefId, toFigmaMessage } from "./figmaExport";
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

/** Where the export writes `m`'s GUIDs: as they are (Figma's own files carry sessions ≥ 2^20 too, e.g. 4162906152). */
function exportIds(_m: Message) {
  const guid = (x: any) => ({ sessionID: x.sessionID, localID: x.localID });
  return { key: (x: any) => `${x.sessionID}:${x.localID}`, guid, deep: (v: any) => v };
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
    const X = exportIds(ourSnapshot()).key;
    expect(nodes.get("0:0").librarySubscriptions).toBeUndefined();
    expect(nodes.get(X(g(S + 1, 1))).invertedCornerMask).toBeUndefined();
    // Our engine's derived data is not Figma's: it goes, and so do the blobs only it used.
    for (const n of nodes.values()) for (const f of DERIVED_FIELDS) expect(n[f], f).toBeUndefined();
    expect(m.blobs).toHaveLength(1);
    expect(nodes.get(X(g(S + 1, 3))).vectorData.vectorNetworkBlob).toBe(0);
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
    const text = nodes.get(X(g(S + 1, 2)));
    expect(text).toMatchObject({ fontSize: 12, fontName: { family: "Inter", style: "Regular" }, lineHeight: { value: 100, units: "PERCENT" }, textAlignVertical: "TOP" });
    expect(text.textData.lines).toHaveLength(2); // one per paragraph, as Figma writes
    expect(text.textData.lines[0]).toMatchObject({ lineType: "PLAIN", styleId: 0 });
  });

  it("keeps Figma's own derived data (a .fig import's text layout) and round-trips through our importer", () => {
    const figmaStamped = { ...ourSnapshot(), derivedDataVersion: FIGMA_DERIVED_DATA_VERSION };
    const kept = byKey(toFigmaMessage(figmaStamped));
    expect(kept.get(exportIds(figmaStamped).key(g(S + 1, 2))).derivedTextData).toBeDefined();

    const exported = toFigmaMessage(ourSnapshot());
    const canvas = decodeCanvas(encodeFigmaCanvas(ourSnapshot(), codecs), codecs);
    const { message: back } = decodeAnySchema(canvas.schema, canvas.message, { keepDerived: true });
    expect(tablesEqual(NodeTable.fromMessage(back), NodeTable.fromMessage(exported))).toBe(true);
    // Nothing but derived data, our own fields and Figma's always-written defaults changed.
    const before = byKey(exportIds(ourSnapshot()).deep(ourSnapshot()));
    for (const [k, n] of byKey(back)) expect(n.name).toBe(before.get(k).name);
  });
});

describe("prototype devices as Figma's presentation knows them (figmaDevices)", () => {
  it("writes Figma's presetIdentifier, and no device where Figma has none", () => {
    const base = ourSnapshot();
    const pages = base.nodeChanges!.map((n: any) => (n.type === "CANVAS" && !n.internalOnly ? { ...n, prototypeDevice: { type: "PRESET", presetIdentifier: "DESKTOP", size: { x: 1440, y: 1024 }, rotation: "NONE" } } : n));
    const page2 = node(g(0, 3), "CANVAS", g(0, 0), "#", { name: "Phone", prototypeDevice: { type: "PRESET", presetIdentifier: "IPHONE_16_PRO_MAX", size: { x: 440, y: 956 }, rotation: "NONE" } });
    const page3 = node(g(0, 4), "CANVAS", g(0, 0), "$", { name: "Figma's", prototypeDevice: { type: "PRESET", presetIdentifier: "APPLE_IPHONE_16_PRO_MAX_BLACKTITANIUM", size: { x: 440, y: 956 }, rotation: "NONE" } });
    const out = byKey(figma.decode("Message", decodeCanvas(encodeFigmaCanvas({ ...base, nodeChanges: [...pages, page2, page3] } as Message, codecs), codecs).message));
    // The owner's "Yeni Test Dosyası": Figma's presentation crashed on "DESKTOP" ("DESKTOP OS could not be inferred").
    expect(out.get("0:1").prototypeDevice).toMatchObject({ type: "NONE", size: { x: 1440, y: 1024 } });
    expect(out.get("0:3").prototypeDevice).toMatchObject({ type: "PRESET", presetIdentifier: "APPLE_IPHONE_16_PRO_MAX_BLACKTITANIUM" });
    expect(out.get("0:4").prototypeDevice.presetIdentifier).toBe("APPLE_IPHONE_16_PRO_MAX_BLACKTITANIUM");
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
    const withRect = { ...base, nodeChanges: [...base.nodeChanges!, rect] } as Message;
    const canvas = decodeCanvas(encodeFigmaCanvas(withRect, codecs), codecs);
    const out = byKey(figma.decode("Message", canvas.message)).get(exportIds(withRect).key(g(S + 3, 1)));
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
    const xs = exportIds(components());
    const k = (x: any) => xs.key(x);
    expect(nodes.get(k(LOCAL))).toMatchObject({ componentKey: KEY });
    expect(nodes.get(k(LOCAL)).key).toBeUndefined();
    expect(nodes.get(k(COPY))).toMatchObject({ componentKey: "c".repeat(40), sharedSymbolVersion: "v7" });
    expect(nodes.get(k(COPY)).version).toBeUndefined();
    expect(nodes.get(k(SET)).key).toBe("b".repeat(40)); // sets keep key 319
    // Each variant: one implicit def per explicit non-VARIANT def — only {id, parentPropDefId}, the same ids on every
    // variant (Figma's own export) — its bindings on them.
    for (const [v, t] of [
      [V1, T1],
      [V2, T2],
    ]) {
      const defs = nodes.get(k(v)).componentPropDefs;
      expect(defs.map((d: any) => [k(d.parentPropDefId), Object.keys(JSON.parse(JSON.stringify(d))).sort()])).toEqual([
        [k(LABEL), ["id", "parentPropDefId"]],
        [k(SHOW), ["id", "parentPropDefId"]],
      ]);
      const label = defs[0];
      const text = nodes.get(k(t));
      expect(k(text.parameterConsumptionMap.entries[0].variableData.value.propRefValue.defId)).toBe(k(label.id));
      expect(text.componentPropRefs).toEqual([{ defID: label.id, componentPropNodeField: "TEXT_DATA", isDeleted: undefined, zombieFallbackName: undefined }].map((r) => JSON.parse(JSON.stringify(r))));
    }
    const ids = [...nodes.get(k(V1)).componentPropDefs, ...nodes.get(k(V2)).componentPropDefs].map((d: any) => k(d.id));
    expect(new Set(ids).size).toBe(2);
    for (const id of ids) expect(nodes.has(id)).toBe(false);
    // The explicit defs carry their default as a VariableData too, text with its lines.
    const setDefs = nodes.get(k(SET)).componentPropDefs;
    expect(setDefs.find((d: any) => d.name === "Label")).toMatchObject({ type: "TEXT", preferredValues: {}, initialValue: { textValue: { characters: "Go" } }, varValue: { dataType: "TEXT_DATA", value: { textDataValue: { characters: "Go" } } } });
    expect(setDefs.find((d: any) => d.name === "Label").initialValue.textValue.lines).toHaveLength(1);
    expect(setDefs.find((d: any) => d.name === "Show icon")).toMatchObject({ varValue: { dataType: "BOOLEAN", value: { boolValue: true } } });
    expect(setDefs.find((d: any) => d.name === "Size")).toMatchObject({ varValue: { dataType: "STRING", value: { textValue: "" } } });
    // A variant property's def on Figma's id for its name, the variants' specs on it.
    expect(setDefs.find((d: any) => d.name === "Size").id).toEqual(figmaVariantDefId("Size"));
    expect(nodes.get(k(V2)).variantPropSpecs[0].propDefId).toEqual(figmaVariantDefId("Size"));
    expect(nodes.get(k(R1)).componentPropRefs[0]).toMatchObject({ componentPropNodeField: "VISIBLE" });
    expect(nodes.get(k(R1)).componentPropRefs[0].nodeField).toBeUndefined(); // Figma's own files write none
    expect(nodes.get(k(INST)).symbolData.symbolOverrides[0].guidPath.guids).toEqual([xs.guid(LOCAL)]);
  });

  it("keeps every property binding and assignment within its own component (Figma aborts opening the file otherwise)", () => {
    // A duplicated set (SET2) keeps the def ids of the first; an instance of each set's variant; a component of its
    // own (LOCAL) whose text a stale import bound to the set's "Label" — it has a "Label" of its own.
    const SET2 = g(9, 1), V3 = g(9, 2), T3 = g(9, 3), TL = g(9, 4), I1 = g(9, 5), I3 = g(9, 6), OWN = g(9, 7);
    const m = components();
    const nodes = m.nodeChanges!.map((n) => (guidKey(n.guid!) === guidKey(LOCAL) ? { ...n, componentPropDefs: [{ id: OWN, name: "Label", type: "TEXT", initialValue: { textValue: { characters: "x" } } }] } : n));
    const set = nodes.find((n) => guidKey(n.guid!) === guidKey(SET))!;
    nodes.push(
      node(SET2, "FRAME", g(0, 1), "&", { name: "Button copy", isStateGroup: true, size: { x: 200, y: 100 }, componentPropDefs: set.componentPropDefs }),
      node(V3, "SYMBOL", SET2, "!", { name: "Size=S", size: { x: 100, y: 40 }, variantPropSpecs: [{ propDefId: SIZE, value: "S" }] }),
      node(T3, "TEXT", V3, "!", { name: "Label", textData: { characters: "Go" }, parameterConsumptionMap: { entries: [ref("TEXT_DATA", "TEXT_DATA", LABEL)] } }),
      node(TL, "TEXT", LOCAL, "!", { name: "Label", textData: { characters: "x" }, parameterConsumptionMap: { entries: [ref("TEXT_DATA", "TEXT_DATA", LABEL)] } }),
      node(I1, "INSTANCE", g(0, 1), "'", { size: { x: 100, y: 40 }, symbolData: { symbolID: V1, symbolOverrides: [] }, componentPropAssignments: [{ defID: LABEL, value: { textValue: { characters: "a" } } }] }),
      node(I3, "INSTANCE", g(0, 1), "(", { size: { x: 100, y: 40 }, symbolData: { symbolID: V3, symbolOverrides: [] }, componentPropAssignments: [{ defID: LABEL, value: { textValue: { characters: "b" } } }] }),
    );
    const msg = { ...m, nodeChanges: nodes } as Message;
    const out = byKey(figma.decode("Message", decodeCanvas(encodeFigmaCanvas(msg, codecs), codecs).message));
    const xs = exportIds(msg);
    const k = (x: any) => xs.key(x);
    const implicit = (v: any) => k(out.get(k(v)).componentPropDefs.find((d: any) => k(d.parentPropDefId) === k(LABEL)).id);
    expect(implicit(V1)).not.toBe(implicit(V3));
    expect(k(out.get(k(I1)).componentPropAssignments[0].defID)).toBe(implicit(V1));
    expect(k(out.get(k(I3)).componentPropAssignments[0].defID)).toBe(implicit(V3));
    expect(k(out.get(k(T3)).componentPropRefs[0].defID)).toBe(implicit(V3));
    expect(k(out.get(k(TL)).componentPropRefs[0].defID)).toBe(k(OWN));
  });

  it("refers to a library's variables and styles by assetRef, as Figma writes them; local ones by guid", () => {
    const VAR = g(9, 10), LVAR = g(9, 11), STYLE = g(9, 12), R = g(9, 13);
    const m = components();
    const alias = (id: any) => ({ dataType: "ALIAS", resolvedDataType: "COLOR", value: { alias: { guid: id } } });
    m.nodeChanges!.push(
      node(VAR, "VARIABLE", g(0, 2), "\"", { name: "brand", key: "d".repeat(40), version: "12:3", sourceLibraryKey: "LIB" }),
      node(LVAR, "VARIABLE", g(0, 2), "#", { name: "local", key: "e".repeat(40) }),
      node(STYLE, "RECTANGLE", g(0, 2), "$", { name: "Fill", styleType: "FILL", key: "f".repeat(40), version: "4:5", isPublishable: false }),
      node(R, "RECTANGLE", g(0, 1), ")", {
        size: { x: 10, y: 10 },
        fillPaints: [{ type: "SOLID", color: { r: 0, g: 0, b: 0, a: 1 }, opacity: 1, visible: true, colorVar: alias(VAR) }],
        strokePaints: [{ type: "SOLID", color: { r: 0, g: 0, b: 0, a: 1 }, opacity: 1, visible: true, colorVar: alias(LVAR) }],
        styleIdForFill: { guid: STYLE },
      }),
      node(g(9, 14), "FRAME", g(0, 1), "*", { size: { x: 10, y: 10 }, detachedSymbolId: { assetRef: { key: "9".repeat(40) } } }),
    );
    const out = new Map(toFigmaMessage(m).nodeChanges!.map((n) => [guidKey(n.guid!), n as any]));
    const r = out.get(guidKey(R))!;
    expect(r.fillPaints[0].colorVar.value.alias).toEqual({ assetRef: { key: "d".repeat(40), version: "12:3" } });
    expect(r.styleIdForFill).toEqual({ assetRef: { key: "f".repeat(40), version: "4:5" } });
    expect(r.strokePaints[0].colorVar.value.alias).toEqual({ guid: LVAR });
    expect(out.get(guidKey(VAR))!.guid).toEqual(VAR); // the copy itself keeps its guid
    // A detached instance's main by key alone: Figma's editor aborts on an assetRef without a version ("" as Figma writes).
    expect(out.get("9:14")!.detachedSymbolId).toEqual({ assetRef: { key: "9".repeat(40), version: "" } });
  });

  it("makes a variant property's id from its name as Figma does", () => {
    // Figma's own "Front End Demo Project 2.fig".
    expect(figmaVariantDefId("State")).toEqual(g(3479705717, 100804006));
    expect(figmaVariantDefId("Mode")).toEqual(g(4162906152, 557693350));
    expect(figmaVariantDefId("Property 1")).toEqual(g(3042298610, 1086140708));
    expect(figmaVariantDefId("isIconOnly")).toEqual(g(3493905706, 449148450));
  });

  it("reads back through our importer as the model it came from", () => {
    const canvas = decodeCanvas(encodeFigmaCanvas(components(), codecs), codecs);
    const { message: back } = decodeAnySchema(canvas.schema, canvas.message, { keepDerived: true });
    const ids = exportIds(components());
    // The variant property comes back on Figma's id for its name.
    const sizeF = figmaVariantDefId("Size");
    const before = byKey(JSON.parse(JSON.stringify(components()), (_k, v) => (v && v.sessionID === SIZE.sessionID && v.localID === SIZE.localID ? sizeF : v)));
    const after = byKey(back);
    for (const id of [SET, V1, V2, T1, T2, R1, LOCAL, COPY, INST].map(ids.key)) {
      const a = after.get(id);
      const b = before.get(id);
      for (const f of ["key", "version", "parameterConsumptionMap", "variantPropSpecs", "symbolData", "sourceLibraryKey"]) expect(a[f], `${id}.${f}`).toEqual(b[f]);
      // Defs come back with the defaults Figma writes beside them (preferredValues, varValue, text lines).
      if (b.componentPropDefs) expect(a.componentPropDefs, `${id}.componentPropDefs`).toMatchObject(b.componentPropDefs);
      else expect(a.componentPropDefs).toBeUndefined();
      expect(a.componentKey).toBeUndefined();
      expect(a.componentPropRefs).toBeUndefined();
    }
  });
});

describe("Wecra-only prototype settings stay out of the export (overlay Fit to window, docs/engine.md §3.4)", () => {
  const withFit = (fit: string | undefined): Message => {
    const base = ourSnapshot();
    const overlay = node(g(S + 1, 9), "FRAME", g(0, 1), "#", {
      name: "Drawer",
      size: { x: 360, y: 1280 },
      overlayPositionType: "TOP_LEFT",
      ...(fit ? { overlayFitWindow: fit } : {}),
    });
    return { ...base, nodeChanges: [...base.nodeChanges!, overlay] } as Message;
  };

  it("never writes overlayFitWindow; the file is byte for byte the one without it", () => {
    const without = decodeCanvas(encodeFigmaCanvas(withFit(undefined), codecs), codecs);
    for (const fit of ["WIDTH", "HEIGHT", "BOTH"]) {
      const withIt = decodeCanvas(encodeFigmaCanvas(withFit(fit), codecs), codecs);
      expect(withIt.message).toEqual(without.message);
      expect(withIt.schema).toEqual(without.schema);
      const drawer = byKey(figma.decode("Message", withIt.message)).get(exportIds(withFit(fit)).key(g(S + 1, 9)));
      expect(drawer.overlayFitWindow).toBeUndefined();
      expect(drawer.overlayPositionType).toBe("TOP_LEFT"); // Figma's own overlay settings are kept
    }
    // Neither the field nor its enum is in the schema the export embeds.
    const schema = decodeBinarySchema(figmaExportSchema());
    expect(schema.definitions.some((d) => d.name === "OverlayFitWindow")).toBe(false);
    expect(schema.definitions.find((d) => d.name === "NodeChange")!.fields.some((f) => f.name === "overlayFitWindow")).toBe(false);
  });

  it("never writes Text input or Cursor (website behaviours), on a layer or in an instance's override; byte for byte the file without them", () => {
    const COMP = g(S + 1, 20), LABEL = g(S + 1, 21), INST = g(S + 1, 22), FIELD = g(S + 1, 23), BOX = g(S + 1, 24), INST2 = g(S + 1, 25), INST3 = g(S + 1, 26);
    const build = (web: boolean): Message => {
      const base = ourSnapshot();
      const extra = (fields: Record<string, unknown>) => (web ? fields : {});
      return {
        ...base,
        nodeChanges: [
          ...base.nodeChanges!,
          node(BOX, "FRAME", g(0, 1), "$", { name: "Box", size: { x: 300, y: 60 }, ...extra({ prototypeCursor: "POINTER" }) }),
          node(FIELD, "TEXT", BOX, "!", { name: "Email", size: { x: 200, y: 20 }, textData: { characters: "Email" }, ...extra({ prototypeTextInput: { type: "EMAIL", maxLength: 40 }, prototypeCursor: "TEXT" }) }),
          node(COMP, "SYMBOL", g(0, 1), "%", { name: "Input", size: { x: 200, y: 40 } }),
          node(LABEL, "TEXT", COMP, "!", { name: "Value", size: { x: 180, y: 20 }, textData: { characters: "Value" }, ...extra({ prototypeTextInput: { type: "TEXT" } }) }),
          // An override holding only Wecra's fields (dropped whole), and one holding Figma's too (kept without ours).
          node(INST, "INSTANCE", g(0, 1), "&", {
            name: "Input",
            size: { x: 200, y: 40 },
            symbolData: { symbolID: COMP, symbolOverrides: web ? [{ guidPath: { guids: [LABEL] }, prototypeTextInput: { type: "PASSWORD" }, prototypeCursor: "HELP" }] : [] },
          }),
          node(INST2, "INSTANCE", g(0, 1), "'", {
            name: "Input 2",
            size: { x: 200, y: 40 },
            symbolData: { symbolID: COMP, symbolOverrides: [{ guidPath: { guids: [LABEL] }, opacity: 0.5, ...extra({ prototypeTextInput: { type: "NUMBER" }, prototypeCursor: "TEXT" }) }] },
          }),
          // As the engine writes an instance's own Text input / Cursor (2026-10-21: overridable): one field per entry,
          // beside a Figma override on the same layer and one on another.
          node(INST3, "INSTANCE", g(0, 1), "(", {
            name: "Input 3",
            size: { x: 200, y: 40 },
            symbolData: {
              symbolID: COMP,
              symbolOverrides: [
                ...(web ? [{ guidPath: { guids: [LABEL] }, prototypeCursor: "CROSSHAIR" }] : []),
                { guidPath: { guids: [LABEL] }, visible: false, ...extra({ prototypeTextInput: { type: "EMAIL", maxLength: 8 } }) },
                ...(web ? [{ guidPath: { guids: [LABEL] }, prototypeTextInput: { type: "MULTI_LINE" } }] : []),
              ],
            },
          }),
        ],
      } as Message;
    };
    const without = decodeCanvas(encodeFigmaCanvas(build(false), codecs), codecs);
    const withIt = decodeCanvas(encodeFigmaCanvas(build(true), codecs), codecs);
    expect(withIt.schema).toEqual(without.schema);
    // Byte for byte: the override entry that held only Wecra's fields goes too.
    expect(withIt.message).toEqual(without.message);
    const all = JSON.stringify(figma.decode("Message", withIt.message));
    expect(all).not.toContain("prototypeTextInput");
    expect(all).not.toContain("prototypeCursor");
    const schema = decodeBinarySchema(figmaExportSchema());
    for (const name of ["PrototypeTextInput", "PrototypeTextInputType", "PrototypeCursor"]) expect(schema.definitions.some((d) => d.name === name)).toBe(false);
    const fields = schema.definitions.find((d) => d.name === "NodeChange")!.fields.map((f) => f.name);
    expect(fields).not.toContain("prototypeTextInput");
    expect(fields).not.toContain("prototypeCursor");
  });

  it("never writes the website behaviours' overlayEdgeBehavior / overlayStack either; byte for byte the file without them", () => {
    const withWeb = (fields: Record<string, unknown>): Message => {
      const base = withFit(undefined);
      return { ...base, nodeChanges: base.nodeChanges!.map((n) => (n.name === "Drawer" ? { ...n, overlayPositionType: "MANUAL", ...fields } : n)) } as Message;
    };
    const without = decodeCanvas(encodeFigmaCanvas(withWeb({}), codecs), codecs);
    for (const fields of [{ overlayEdgeBehavior: "NONE" }, { overlayEdgeBehavior: "FOLLOW_ONLY" }, { overlayStack: { gap: 8, max: 3 } }, { overlayEdgeBehavior: "AUTO", overlayStack: { gap: 0, max: 0 } }]) {
      const withIt = decodeCanvas(encodeFigmaCanvas(withWeb(fields), codecs), codecs);
      expect(withIt.message).toEqual(without.message);
      expect(withIt.schema).toEqual(without.schema);
      const drawer = byKey(figma.decode("Message", withIt.message)).get(exportIds(withWeb(fields)).key(g(S + 1, 9)));
      expect(drawer.overlayEdgeBehavior).toBeUndefined();
      expect(drawer.overlayStack).toBeUndefined();
      expect(drawer.overlayPositionType).toBe("MANUAL");
    }
    // Neither the fields nor their types are in the schema the export embeds.
    const schema = decodeBinarySchema(figmaExportSchema());
    for (const name of ["OverlayEdgeBehavior", "OverlayStack"]) expect(schema.definitions.some((d) => d.name === name)).toBe(false);
    const node = schema.definitions.find((d) => d.name === "NodeChange")!;
    expect(node.fields.some((f) => f.name === "overlayEdgeBehavior" || f.name === "overlayStack")).toBe(false);
  });

  it("a Figma file read and written back has none (import → export round trip unchanged)", () => {
    const { message } = decodeAnySchema(sampleCanvas.schema, sampleCanvas.message, { keepDerived: true });
    expect(message.nodeChanges!.some((n: any) => n.overlayFitWindow !== undefined)).toBe(false);
    const out = figma.decode("Message", decodeCanvas(encodeFigmaCanvas(message, codecs), codecs).message);
    expect(out.nodeChanges.some((n: any) => n.overlayFitWindow !== undefined)).toBe(false);
  });
});
