/**
 * The `canvas.fig` of a Save Local Copy, written the way Figma writes its own (docs/data.md §11.2). Our snapshots are
 * not that: their header carries our DOCUMENT_FORMAT_VERSION (1, where Figma's files carry 15..106), their schema has
 * our reserved `_rN` placeholders at the numbers of Figma's fields we drop and fields Figma doesn't have
 * (`Message.derivedDataVersion = 100`, NodeChange 1000..1002), their Message carries our session and our engine's
 * derived data, and their zstd frame has a checksum. Real Figma took such a file into its file list but never finished
 * opening it (2026-10-12, a Save Local Copy of "sansato"), so an export is re-encoded:
 *
 *   header      "fig-kiwi", FIGMA_FILE_VERSION (the version of the newest Figma export we have, sections.fig / the
 *               owner's file: 106)
 *   chunk 0     deflate-raw of `figmaExportSchema()`: our schema without the placeholders and our own fields — a strict
 *               subset of Figma's (every definition, field, number and type as Figma's; checked against Figma's 106
 *               schema in figmaExport.test.ts)
 *   chunk 1     the Message (`toFigmaMessage`), zstd as Figma 106 writes it (the caller's codec; no checksum)
 *
 * The Message is encoded with our codec: with our fields removed, its bytes are the same under the subset schema.
 */
import { decodeBinarySchema, encodeBinarySchema, type Definition, type Schema } from "kiwi-schema";
import { codec, FIELD_FLAGS, NODE_FIELDS, SCHEMA_BINARY, type Message, type NodeChange } from "../schema/document.generated";
import { guidKey } from "../schema/guid";
import { NodeTable } from "../schema/patch";
import type { FigCodecs } from "./compression";
import { encodeCanvas, PRELUDE_DESIGN, writeCanvasChunks } from "./container";
import { FIGMA_DERIVED_DATA_VERSION } from "./convert";
import { figmaPrototypeDevice } from "./figmaDevices";
import { sha1 } from "../sha1";

/** The `fig-kiwi` version Figma writes today (docs/research/figma/samples/sections.fig, the owner's 2026-10 export). */
export const FIGMA_FILE_VERSION = 106;

/** NodeChange fields Figma doesn't have (`@ours`): never in an export. */
const OUR_NODE_FIELDS: ReadonlySet<string> = new Set(NODE_FIELDS.filter((f) => f.flags & FIELD_FLAGS.OURS).map((f) => f.name));
/** Message fields Figma doesn't have (`@ours` in schema/document.kiwi). */
const OUR_MESSAGE_FIELDS: ReadonlySet<string> = new Set(["derivedDataVersion"]);
const PLACEHOLDER = /^_r\d+$/;

function reachable(defs: Definition[], root: string): Set<string> {
  const byName = new Map(defs.map((d) => [d.name, d]));
  const seen = new Set<string>();
  const stack = [root];
  while (stack.length) {
    const name = stack.pop()!;
    if (seen.has(name)) continue;
    const d = byName.get(name);
    if (!d) continue;
    seen.add(name);
    for (const f of d.fields) if (f.type && byName.has(f.type)) stack.push(f.type);
  }
  return seen;
}

let exportSchema: Uint8Array | null = null;

/** Our schema as Figma knows it: placeholders, `@ours` fields and the definitions only they used are left out. */
export function figmaExportSchema(): Uint8Array {
  if (exportSchema) return exportSchema;
  const ours = decodeBinarySchema(SCHEMA_BINARY);
  const before = reachable(ours.definitions, "Message");
  const definitions: Definition[] = ours.definitions.map((d) => ({
    ...d,
    fields:
      d.kind !== "MESSAGE"
        ? d.fields
        : d.fields.filter((f) => !PLACEHOLDER.test(f.name) && !(d.name === "NodeChange" && OUR_NODE_FIELDS.has(f.name)) && !(d.name === "Message" && OUR_MESSAGE_FIELDS.has(f.name))),
  }));
  const after = reachable(definitions, "Message");
  const schema: Schema = { package: ours.package, definitions: definitions.filter((d) => !(before.has(d.name) && !after.has(d.name))) };
  return (exportSchema = encodeBinarySchema(schema));
}

const IDENTITY = { m00: 1, m01: 0, m02: 0, m10: 0, m11: 1, m12: 0 };

/** Override entries without `@ours` fields; an entry that held nothing else (only its guidPath left) is dropped. */
function withoutOurFields(entries: NodeChange[]): NodeChange[] {
  const out: NodeChange[] = [];
  for (const e of entries) {
    const keys = Object.keys(e).filter((k) => (e as Record<string, unknown>)[k] !== undefined);
    if (!keys.some((k) => OUR_NODE_FIELDS.has(k))) {
      out.push(e);
      continue;
    }
    const kept: Record<string, unknown> = {};
    for (const k of keys) if (!OUR_NODE_FIELDS.has(k)) kept[k] = (e as Record<string, unknown>)[k];
    if (Object.keys(kept).some((k) => k !== "guidPath")) out.push(kept as NodeChange);
  }
  return out;
}

/**
 * One node as Figma writes it. Figma writes `visible`, `opacity`, `transform` and the stroke basics on every node (and
 * a TEXT's type settings and paragraph lines) even at their defaults; absence means our default (schema/document.kiwi
 * `@default`, else the kiwi zero value), which need not be Figma's, so they are written out.
 */
function figmaNode(n: NodeChange): NodeChange {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(n)) if (!OUR_NODE_FIELDS.has(k) && v !== undefined) out[k] = v;
  // An instance's overrides (and derived sublayer data) are NodeChanges too: `@ours` fields set on a sublayer (a text
  // input's Prototype › Text input, a Cursor) go, and an entry left with only its path goes with them.
  const sd = out.symbolData as NodeChange["symbolData"] | undefined;
  if (sd?.symbolOverrides?.length) out.symbolData = { ...sd, symbolOverrides: withoutOurFields(sd.symbolOverrides) };
  if (Array.isArray(out.derivedSymbolData)) out.derivedSymbolData = withoutOurFields(out.derivedSymbolData as NodeChange[]);
  // Variables and collections carry no layer fields in Figma's files (Kardora.fig, AnexEUI - B2C.fig).
  if (n.type === "VARIABLE" || n.type === "VARIABLE_SET") return out as NodeChange;
  const root = n.type === "DOCUMENT" || n.type === "CANVAS";
  out.visible ??= true;
  out.opacity ??= 1;
  out.transform ??= IDENTITY;
  out.strokeWeight ??= 0;
  out.strokeAlign ??= "CENTER";
  out.strokeJoin ??= root ? "BEVEL" : "MITER";
  if (!root) out.size ??= { x: 0, y: 0 };
  if (out.prototypeDevice) out.prototypeDevice = figmaPrototypeDevice(out.prototypeDevice);
  if (n.type === "TEXT") {
    out.fontName ??= { family: "Inter", style: "Regular", postscript: "Inter-Regular" };
    out.fontSize ??= 12;
    out.lineHeight ??= { value: 100, units: "PERCENT" };
    out.letterSpacing ??= { value: 0, units: "PERCENT" };
    out.textAlignHorizontal ??= "LEFT";
    out.textAlignVertical ??= "TOP";
    const td = (out.textData ?? { characters: "" }) as NonNullable<NodeChange["textData"]>;
    if (!td.lines?.length) {
      const paragraphs = (td.characters ?? "").split("\n").length;
      const line = { lineType: "PLAIN", styleId: 0, indentationLevel: 0, sourceDirectionality: "AUTO", listStartOffset: 0, isFirstLineOfList: false } as const;
      out.textData = { ...td, lines: Array.from({ length: paragraphs }, () => ({ ...line })) };
    }
  }
  return out as NodeChange;
}

/** Our PROP_REF bindings → Figma's legacy ComponentPropRef kind (Figma's own files write no `nodeField` beside it). */
const PROP_REF_NODE_FIELDS: Record<string, { kind: string }> = {
  VISIBLE: { kind: "VISIBLE" },
  TEXT_DATA: { kind: "TEXT_DATA" },
  OVERRIDDEN_SYMBOL_ID: { kind: "OVERRIDDEN_SYMBOL_ID" },
  SLOT_CONTENT_ID: { kind: "SLOT_CONTENT_ID" },
};

/* eslint-disable @typescript-eslint/no-explicit-any -- Figma-shaped records built field by field */

/** Every `propRefValue.defId` in `v` (a node's bindings, a nested instance's bound values) through `map`. */
function remapPropRefs(v: any, map: Map<string, any>): any {
  if (Array.isArray(v)) return v.map((x) => remapPropRefs(x, map));
  if (!v || typeof v !== "object" || v instanceof Uint8Array) return v;
  const out: any = {};
  for (const [k, x] of Object.entries(v)) {
    if (k === "propRefValue" && x && typeof x === "object" && (x as any).defId) {
      const to = map.get(guidKey((x as any).defId));
      out[k] = to ? { ...x, defId: to } : x;
    } else {
      out[k] = remapPropRefs(x, map);
    }
  }
  return out;
}

/**
 * Figma's id of a variant property: made from its name, so every set's "State" is the same def — SHA-1 of the UTF-8
 * name, its first two little-endian words: session = word 1 | 2^31, local = word 0 with the low bit cleared (every
 * variant property of the owner's "Front End Demo Project 2.fig" — "State" → 3479705717:100804006, "Mode", "Size" …).
 * Wecra gives them ids of its own; Figma then fails to rebuild the set's properties ("could not create explicit prop
 * def" with "mismatching type and default value" for each) and its editor aborts.
 */
export function figmaVariantDefId(name: string): { sessionID: number; localID: number } {
  const hex = sha1(new TextEncoder().encode(name));
  const word = (i: number) => parseInt(hex.slice(i * 8 + 6, i * 8 + 8) + hex.slice(i * 8 + 4, i * 8 + 6) + hex.slice(i * 8 + 2, i * 8 + 4) + hex.slice(i * 8, i * 8 + 2), 16);
  return { sessionID: (word(1) | 0x80000000) >>> 0, localID: (word(0) & ~1) >>> 0 };
}

/** Variant property defs on Figma's ids, with every variant's spec and every reference (`guidKey`) following. */
function figmaVariantIds(nodes: any[]): void {
  const map = new Map<string, any>();
  for (const n of nodes)
    for (const d of n.componentPropDefs ?? []) if (d.type === "VARIANT" && d.id && d.name) map.set(guidKey(d.id), figmaVariantDefId(d.name));
  if (!map.size) return;
  const to = (g: any) => (g && map.get(guidKey(g))) ?? g;
  const keys = (v: any): any => {
    if (Array.isArray(v)) return v.map(keys);
    if (!v || typeof v !== "object" || v instanceof Uint8Array) return v;
    const out: any = {};
    for (const [k, x] of Object.entries(v)) out[k] = k === "guidKey" ? to(x) : keys(x);
    return out;
  };
  for (const n of nodes) {
    if (n.componentPropDefs) n.componentPropDefs = n.componentPropDefs.map((d: any) => (d.type === "VARIANT" && d.id ? { ...d, id: to(d.id) } : d));
    if (n.variantPropSpecs) n.variantPropSpecs = n.variantPropSpecs.map((s: any) => ({ ...s, propDefId: to(s.propDefId) }));
    for (const f of ["parameterConsumptionMap", "prototypeInteractions", "symbolData"]) if (n[f]) n[f] = keys(n[f]);
  }
}

/**
 * Every component-property binding resolves on the component it sits in (its nearest symbol, or that variant's set):
 * Figma aborts opening a file with one that doesn't (2026-10-20, the owner's "Prototype deneme": a symbol's texts
 * bound to another set's defs, left by an import that resolved Figma's implicit def ids file-wide — fixed in
 * convert.ts, but documents imported before keep them). An unresolved one goes to the component's def of the same
 * name and type, or is dropped.
 */
function resolvePropRefs(nodes: any[]): void {
  const byId = new Map(nodes.filter((n) => n.guid).map((n) => [guidKey(n.guid), n]));
  const defs = new Map<string, any>();
  for (const n of nodes) for (const d of n.componentPropDefs ?? []) if (d.id) defs.set(guidKey(d.id), d);
  const scopeOf = new Map<string, Map<string, any> | null>();
  const scope = (n: any): Map<string, any> | null => {
    let c = n;
    for (let i = 0; c && c.type !== "SYMBOL" && i < 400; i++) c = c.parentIndex ? byId.get(guidKey(c.parentIndex.guid)) : undefined;
    if (!c || c.type !== "SYMBOL") return null;
    const k = guidKey(c.guid);
    if (!scopeOf.has(k)) {
      const set = c.parentIndex ? byId.get(guidKey(c.parentIndex.guid)) : undefined;
      const own = new Map<string, any>();
      for (const d of [...(c.componentPropDefs ?? []), ...(set?.isStateGroup ? (set.componentPropDefs ?? []) : [])]) if (d.id) own.set(guidKey(d.id), d);
      scopeOf.set(k, own);
    }
    return scopeOf.get(k)!;
  };
  for (const n of nodes) {
    const entries = n.parameterConsumptionMap?.entries;
    if (!entries?.some((e: any) => e?.variableData?.value?.propRefValue?.defId)) continue;
    const own = scope(n);
    if (!own) continue;
    const fixed = entries.flatMap((e: any) => {
      const id = e?.variableData?.value?.propRefValue?.defId;
      if (!id || own.has(guidKey(id))) return [e];
      const was = defs.get(guidKey(id));
      const same = was && [...own.values()].find((d) => d.name === was.name && d.type === was.type);
      if (!same) return [];
      return [{ ...e, variableData: { ...e.variableData, value: { ...e.variableData.value, propRefValue: { ...e.variableData.value.propRefValue, defId: same.id } } } }];
    });
    n.parameterConsumptionMap = { ...n.parameterConsumptionMap, entries: fixed };
  }
}

/** Text with one PLAIN line per paragraph, as Figma writes every TextData. */
function withLines(td: any): any {
  if (td?.lines?.length) return td;
  const line = { lineType: "PLAIN", styleId: 0, indentationLevel: 0, sourceDirectionality: "AUTO", listStartOffset: 0, isFirstLineOfList: false };
  return { ...td, characters: td?.characters ?? "", lines: Array.from({ length: (td?.characters ?? "").split("\n").length }, () => ({ ...line })) };
}

/** A component property value as Figma's VariableData (a def's default, an assignment's value). */
function defaultVar(type: string | undefined, v: any): any {
  if (type === "TEXT" || (!type && v?.textValue)) return { value: { textDataValue: withLines(v?.textValue ?? { characters: "" }) }, dataType: "TEXT_DATA", resolvedDataType: "TEXT_DATA" };
  if (type === "BOOL" || (!type && v?.boolValue !== undefined)) return { value: { boolValue: !!v?.boolValue }, dataType: "BOOLEAN", resolvedDataType: "BOOLEAN" };
  if (type === "VARIANT") return { value: { textValue: "" }, dataType: "STRING", resolvedDataType: "STRING" };
  if ((type === "INSTANCE_SWAP" || !type) && v?.guidValue) return { value: { symbolIdValue: { guid: v.guidValue } }, dataType: "SYMBOL_ID", resolvedDataType: "SYMBOL_ID" };
  return undefined;
}

const NO_IDS = new Map<string, any>();

function figmaAssignments(list: any[], implicitOf: Map<string, any>): any[] {
  return list.map((a) => {
    const x = { ...a };
    const to = x.defID && implicitOf.get(guidKey(x.defID));
    if (to) x.defID = to;
    if (x.value?.textValue) x.value = { ...x.value, textValue: withLines(x.value.textValue) };
    x.varValue ??= defaultVar(undefined, x.value);
    if (!x.varValue) delete x.varValue;
    return x;
  });
}

/**
 * Components as Figma stores them (research components.md task 8; the import maps each of these back, convert.ts):
 * - a SYMBOL's asset key in `componentKey` (216), a library copy's version in `sharedSymbolVersion` (126) — sets,
 *   styles and variables keep `key` / `version`;
 * - on each variant, one implicit def per explicit (non-VARIANT) def of its set, `parentPropDefId` (5) pointing at it,
 *   with the variant's own bindings re-pointed at its implicit defs (Figma resolves implicit → explicit);
 * - beside each PROP_REF binding, the legacy `componentPropRefs` (267) entry Figma still writes;
 * - the root override entry addressed as `[symbolID]`.
 */
function figmaComponents(nodes: NodeChange[]): NodeChange[] {
  const out = nodes.map((n) => ({ ...n }) as any);
  figmaVariantIds(out);
  resolvePropRefs(out);
  const children = new Map<string, any[]>();
  for (const n of out) {
    const p = n.parentIndex?.guid;
    if (!p) continue;
    const k = guidKey(p);
    if (!children.has(k)) children.set(k, []);
    children.get(k)!.push(n);
  }
  // Fresh ids for implicit defs: above every localID a session already uses (nodes and defs).
  const top = new Map<number, number>();
  const see = (g: any) => g && top.set(g.sessionID, Math.max(top.get(g.sessionID) ?? 0, g.localID));
  for (const n of out) {
    see(n.guid);
    for (const d of n.componentPropDefs ?? []) see(d.id);
  }
  const fresh = (session: number) => {
    const localID = (top.get(session) ?? 0) + 1;
    top.set(session, localID);
    return { sessionID: session, localID };
  };
  // One implicit id per explicit def of a set, the same on every variant, holding only `id` and `parentPropDefId`
  // (Figma's own export, "Front End Demo Project 2.fig": every variant of a set carries {6024:19 → 6024:18}); the
  // variants' bindings and the instances' assignments use it. Defs with a name, type and default but no `varValue` on
  // each variant made Figma log "mismatching type and default value" / "could not create explicit prop def" for each
  // and crash opening the file (2026-10-20, the owner's "Prototype deneme" exports).
  // Per set: a def id is only unique within its component (a duplicated set keeps its defs' ids), so an assignment
  // goes through the set of the symbol its instance shows; the file-wide map only for an id no other set reuses.
  const implicitOf = new Map<string, any>();
  const implicitBySet = new Map<string, Map<string, any>>();
  const reused = new Set<string>();
  for (const set of out) {
    if (!set.isStateGroup || !set.componentPropDefs?.length) continue;
    const explicit = (set.componentPropDefs as any[]).filter((d) => d.type !== "VARIANT" && d.id);
    if (!explicit.length) continue;
    const map = new Map<string, any>();
    for (const d of explicit) {
      const id = fresh(d.id.sessionID);
      map.set(guidKey(d.id), id);
      if (implicitOf.has(guidKey(d.id))) reused.add(guidKey(d.id));
      implicitOf.set(guidKey(d.id), id);
    }
    implicitBySet.set(guidKey(set.guid), map);
    for (const variant of children.get(guidKey(set.guid)) ?? []) {
      if (variant.type !== "SYMBOL") continue;
      variant.componentPropDefs = [...(variant.componentPropDefs ?? []), ...explicit.map((d) => ({ id: map.get(guidKey(d.id)), parentPropDefId: d.id }))];
      const stack = [variant];
      while (stack.length) {
        const n = stack.pop();
        if (n.parameterConsumptionMap) n.parameterConsumptionMap = remapPropRefs(n.parameterConsumptionMap, map);
        if (n.componentPropAssignments) n.componentPropAssignments = remapPropRefs(n.componentPropAssignments, map);
        if (n.symbolData) n.symbolData = remapPropRefs(n.symbolData, map);
        stack.push(...(children.get(guidKey(n.guid)) ?? []));
      }
    }
  }
  const byId = new Map(out.filter((n) => n.guid).map((n) => [guidKey(n.guid), n]));
  const unique = new Map([...implicitOf].filter(([k]) => !reused.has(k)));
  /** The implicit ids an instance's assignments use: the set's of the symbol it shows (else the unambiguous ones). */
  const scopeOfShown = (inst: any): Map<string, any> => {
    const sym = inst?.symbolData?.symbolID ? byId.get(guidKey(inst.symbolData.symbolID)) : undefined;
    const set = sym?.parentIndex ? byId.get(guidKey(sym.parentIndex.guid)) : undefined;
    if (!sym) return unique;
    return (set?.isStateGroup && implicitBySet.get(guidKey(set.guid))) || NO_IDS; // a component of its own: its own defs
  };
  for (const n of out) {
    // Explicit defs and assignments as Figma writes them: the value also as a VariableData (`varValue`), text with its
    // paragraph lines; assignments to a set's def on its implicit id (nested instances' ones in overrides too).
    if (n.componentPropDefs)
      n.componentPropDefs = n.componentPropDefs.map((d: any) => {
        if (d.parentPropDefId) return d;
        const x = { ...d, preferredValues: d.preferredValues ?? {} };
        if (x.initialValue?.textValue) x.initialValue = { ...x.initialValue, textValue: withLines(x.initialValue.textValue) };
        x.varValue ??= defaultVar(x.type, x.initialValue);
        if (!x.varValue) delete x.varValue;
        return x;
      });
    if (n.componentPropAssignments) n.componentPropAssignments = figmaAssignments(n.componentPropAssignments, scopeOfShown(n));
    if (n.symbolData?.symbolOverrides?.some((o: any) => o.componentPropAssignments))
      n.symbolData = {
        ...n.symbolData,
        symbolOverrides: n.symbolData.symbolOverrides.map((o: any) => {
          if (!o.componentPropAssignments) return o;
          const g = o.guidPath?.guids;
          return { ...o, componentPropAssignments: figmaAssignments(o.componentPropAssignments, scopeOfShown(g?.length ? byId.get(guidKey(g[g.length - 1])) : n)) };
        }),
      };
    if (n.type === "SYMBOL") {
      if (n.key) n.componentKey = n.key;
      delete n.key;
      if (n.version && n.sourceLibraryKey) {
        n.sharedSymbolVersion = n.version;
        delete n.version;
      }
    }
    const refs: any[] = [];
    for (const e of n.parameterConsumptionMap?.entries ?? []) {
      const f = PROP_REF_NODE_FIELDS[e?.variableField];
      const defID = e?.variableData?.dataType === "PROP_REF" ? e.variableData.value?.propRefValue?.defId : undefined;
      if (!f || !defID) continue;
      refs.push({ defID, componentPropNodeField: f.kind });
    }
    if (refs.length) n.componentPropRefs = refs;
    const sd = n.symbolData;
    if (sd?.symbolID && sd.symbolOverrides?.some((o: any) => !o.guidPath?.guids?.length))
      n.symbolData = { ...sd, symbolOverrides: sd.symbolOverrides.map((o: any) => (o.guidPath?.guids?.length ? o : { ...o, guidPath: { guids: [sd.symbolID] } })) };
  }
  return out;
}

/**
 * References to a library's variables, collections and styles as Figma writes them: `{assetRef: {key, version}}`, not
 * the local copy's guid (the import maps them the other way, convert.ts "assetRef → local copy guid"). With the guid,
 * Figma's presentation never switched a library collection's mode (Set variable mode did nothing) and the bindings
 * weren't the library's.
 */
/**
 * Every `assetRef` with a `version`, "" when there is none (Figma writes `{key, version: ""}` for a detached
 * instance's `detachedSymbolId`). Without it Figma's editor aborts applying the node changes — "[fatalEmptyOptional
 * Dereferenced] empty optional dereferenced" in visitMessage_nodeChanges, read off its Sentry event (2026-10-20, the
 * owner's "Prototype deneme": every frame holding a detached instance).
 */
function withAssetVersions(v: any): any {
  if (Array.isArray(v)) return v.map(withAssetVersions);
  if (!v || typeof v !== "object" || v instanceof Uint8Array) return v;
  const out: any = {};
  for (const [k, x] of Object.entries(v)) out[k] = withAssetVersions(x);
  if (out.assetRef && typeof out.assetRef === "object" && out.assetRef.key !== undefined && out.assetRef.version === undefined) out.assetRef = { ...out.assetRef, version: "" };
  return out;
}

function figmaAssetRefs(nodes: any[]): any[] {
  const refs = new Map<string, { key: string; version?: string }>();
  // A library's copy: a variable or collection with its library's key; a style Figma keeps unpublishable (the library's
  // styles in Figma's own files carry no other mark).
  const libraryCopy = (n: any) => !!n.key && (n.type === "VARIABLE" || n.type === "VARIABLE_SET" ? !!n.sourceLibraryKey : !!n.styleType && (!!n.sourceLibraryKey || n.isPublishable === false));
  for (const n of nodes)
    if (libraryCopy(n)) refs.set(guidKey(n.guid), { key: n.key, ...(n.version ? { version: n.version } : {}) });
  if (!refs.size) return nodes;
  const fix = (v: any): any => {
    if (Array.isArray(v)) return v.map(fix);
    if (!v || typeof v !== "object" || v instanceof Uint8Array) return v;
    const keys = Object.keys(v);
    if (keys.length === 1 && keys[0] === "guid" && v.guid && typeof v.guid.sessionID === "number") {
      const r = refs.get(guidKey(v.guid));
      return r ? { assetRef: r } : v;
    }
    const out: any = {};
    for (const [k, x] of Object.entries(v)) out[k] = k === "guid" || k === "parentIndex" ? x : fix(x);
    return out;
  };
  return nodes.map(fix);
}

/**
 * This file's own variables, collections and styles as Figma writes them: no `key` and `isPublishable` written out
 * (true unless hidden from publishing). Figma's files mark a library's copy by a key with `isPublishable: false`
 * (Kardora.fig, HeroUI.fig, AnexEUI - B2C.fig); ours went out with their key and without `isPublishable` (our schema's
 * default, left out), and Figma took them for library copies: an exported file opened with no local variables
 * (2026-10-22, the owner's "Wecra Design System"). Runs after figmaAssetRefs, which reads the library copies' keys.
 */
function figmaLocalAssets(nodes: any[]): any[] {
  return nodes.map((n) => {
    const asset = n.type === "VARIABLE" || n.type === "VARIABLE_SET" || !!n.styleType;
    if (!asset || n.sourceLibraryKey || (n.styleType && n.isPublishable === false && n.key)) return n;
    const { key: _key, ...rest } = n;
    return { ...rest, isPublishable: n.isPublishable ?? true };
  });
}

/* eslint-enable @typescript-eslint/no-explicit-any */

/**
 * The Message of an export: every live node CREATED in our snapshot order (DOCUMENT first, parents before children),
 * session 0 as in Figma's files, and a dense blob table of what is still referenced. `@derived` fields go unless they
 * are Figma's own (a `.fig` import keeps Figma's text layout and instance geometry, stamped FIGMA_DERIVED_DATA_VERSION):
 * our engine's glyph outlines and layout are not what Figma's text engine writes, and Figma lays text out, builds
 * instance sublayers and geometry itself when they are absent.
 */
export function toFigmaMessage(message: Message): Message {
  const table = NodeTable.fromMessage(message);
  const plain = table.toMessage({ keepDerived: table.derivedDataVersion === FIGMA_DERIVED_DATA_VERSION, sessionID: 0 });
  return { type: "NODE_CHANGES", sessionID: 0, ackID: 0, nodeChanges: figmaLocalAssets(figmaAssetRefs(figmaComponents((plain.nodeChanges ?? []).map(figmaNode)))).map(withAssetVersions), blobs: plain.blobs ?? [] };
}

/** `canvas.fig` bytes for a `.fig` export of `message` (zstd when the codecs have it, else deflate-raw). */
export function encodeFigmaCanvas(message: Message, codecs: FigCodecs): Uint8Array {
  return encodeCanvas(
    {
      prelude: PRELUDE_DESIGN,
      version: FIGMA_FILE_VERSION,
      schema: figmaExportSchema(),
      message: codec.encodeMessage(toFigmaMessage(message)),
      compression: codecs.zstdCompress ? "zstd" : "deflate-raw",
      zstdLevel: 3,
    },
    codecs,
  );
}

/**
 * `encodeFigmaCanvas` with an asynchronous deflate (a browser's CompressionStream; the web app's Save local copy…):
 * both chunks deflate-raw, which Figma reads as it reads its older files.
 */
export async function encodeFigmaCanvasAsync(message: Message, deflateRaw: (data: Uint8Array) => Promise<Uint8Array>): Promise<Uint8Array> {
  const [schema, body] = await Promise.all([deflateRaw(figmaExportSchema()), deflateRaw(codec.encodeMessage(toFigmaMessage(message)))]);
  return writeCanvasChunks({ prelude: PRELUDE_DESIGN, version: FIGMA_FILE_VERSION, chunks: [schema, body] });
}
