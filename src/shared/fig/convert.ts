/**
 * Figma Message → our Message (docs/data.md §11.1 step 4, docs/schema.md §11.1). Used by .fig import (store) and by
 * paste from Figma (renderer), so it is pure and eval-free.
 *
 * 1. Projection by name: every definition, field and enum value is kept when ours has the same name (and, for
 *    fields, the same type and array-ness); everything else is dropped and counted. A message whose `type` enum
 *    value is unknown is dropped whole (a NOISE paint must not become a SOLID one); a node of an unknown type is
 *    dropped with its subtree.
 * 2. The mappings of docs/schema.md §11.1: componentPropRefs → PROP_REF entries; variableConsumptionMap only when
 *    parameterConsumptionMap is absent; root override paths [symbolID] → empty path; variant-level
 *    ComponentPropDef.parentPropDefId → the set's def id; library copies' sharedSymbolReference / sharedStyleReference /
 *    componentKey / sharedSymbolVersion → sourceLibraryKey, publishID, key, version (§8.2; the per-node
 *    libraryGUIDToSubscribingGUID → overrideKey mapping is not done: no sample has a library copy);
 *    symbol/styleDescription → description; inherit*StyleID → styleIdFor* {guid}; assetRef → the local copy's guid;
 *    the GUID sentinel 4294967295:4294967295 → absent; GROUP → FRAME + resizeToFit; RECTANGLE → ROUNDED_RECTANGLE;
 *    derived data dropped.
 */
import type { Message, NodeChange } from "../schema/document.generated";
import { guidKey, NONE_ID } from "../schema/guid";
import { MODEL, NATIVE_TYPES, SchemaModel, type FieldDef } from "../schema/model";
import { DERIVED_FIELDS } from "../schema/patch";
import { mapValue } from "../schema/visit";

/* eslint-disable @typescript-eslint/no-explicit-any -- foreign values are shaped by their own schema */

export interface ImportReport {
  nodesIn: number;
  nodesOut: number;
  /** Nodes dropped because ours has no such node type, by type name */
  droppedNodeTypes: Record<string, number>;
  /** Nodes dropped because an ancestor was dropped (or their parent is missing) */
  droppedOrphans: number;
  /** Fields ours does not have, by "Definition.field" */
  droppedFields: Record<string, number>;
  /** Enum values ours does not have, by "Enum.VALUE" */
  droppedEnumValues: Record<string, number>;
  /** Definitions ours does not have */
  droppedDefinitions: Record<string, number>;
  /** @derived values dropped (recomputed by the engine) */
  droppedDerived: number;
  /** The §11.1 mappings that fired, by name */
  mappings: Record<string, number>;
}

export const newImportReport = (): ImportReport => ({
  nodesIn: 0,
  nodesOut: 0,
  droppedNodeTypes: {},
  droppedOrphans: 0,
  droppedFields: {},
  droppedEnumValues: {},
  droppedDefinitions: {},
  droppedDerived: 0,
  mappings: {},
});

const inc = (rec: Record<string, number>, key: string, n = 1) => {
  rec[key] = (rec[key] ?? 0) + n;
};

const isSentinel = (g: any) => !!g && g.sessionID === NONE_ID && g.localID === NONE_ID;

// ---------------------------------------------------------------------------------------------------------------------
// 1. Projection by name
// ---------------------------------------------------------------------------------------------------------------------

class Projector {
  constructor(
    readonly theirs: SchemaModel,
    readonly ours: SchemaModel,
    readonly report: ImportReport,
  ) {}

  value(def: string, v: any): any {
    const od = this.ours.defs.get(def);
    if (!od) {
      inc(this.report.droppedDefinitions, def);
      return undefined;
    }
    if (od.kind === "ENUM") {
      if (typeof v === "string" && od.byName.has(v)) return v;
      inc(this.report.droppedEnumValues, `${def}.${v ?? "?"}`);
      return undefined;
    }
    if (v == null || typeof v !== "object") return undefined;
    if (od.kind === "STRUCT") {
      const out: any = {};
      for (const f of od.fields) {
        if (v[f.name] === undefined) return undefined;
        const p = this.field(def, f, v[f.name]);
        if (p === undefined) return undefined;
        out[f.name] = p;
      }
      return out;
    }
    const td = this.theirs.defs.get(def);
    const out: any = {};
    for (const key in v) {
      const x = v[key];
      if (x === undefined) continue;
      const of = od.byName.get(key);
      if (!of) {
        inc(this.report.droppedFields, `${def}.${key}`);
        continue;
      }
      const tf = td?.byName.get(key);
      if (tf && (tf.type !== of.type || tf.isArray !== of.isArray)) {
        inc(this.report.droppedFields, `${def}.${key}`);
        continue;
      }
      const p = this.field(def, of, x);
      if (p === undefined) {
        // An unknown discriminator makes the whole value meaningless (Paint.type NOISE, Effect.type CUSTOM, …).
        if (key === "type" && this.ours.defs.get(of.type ?? "")?.kind === "ENUM") return undefined;
        continue;
      }
      out[key] = p;
    }
    return out;
  }

  field(_def: string, f: FieldDef, x: any): any {
    const type = f.type ?? "";
    if (f.isArray) {
      if (type === "byte") return x instanceof Uint8Array ? x : undefined;
      if (!Array.isArray(x)) return undefined;
      if (NATIVE_TYPES.has(type)) return x.slice();
      const out: any[] = [];
      for (const e of x) {
        const p = this.value(type, e);
        if (p !== undefined) out.push(p);
      }
      return out;
    }
    if (NATIVE_TYPES.has(type)) return x;
    return this.value(type, x);
  }
}

/**
 * Pure projection by name (docs/schema.md §1.1 point 5): unknown fields, definitions and enum values dropped, nodes of
 * unknown types dropped. No other mapping.
 */
export function projectMessageByName(message: any, theirs: SchemaModel, ours: SchemaModel = MODEL, report: ImportReport = newImportReport()): Message {
  const p = new Projector(theirs, ours, report);
  const nodes: NodeChange[] = [];
  for (const n of message.nodeChanges ?? []) {
    report.nodesIn++;
    const out = p.value("NodeChange", n);
    if (!out || (n.type !== undefined && out.type === undefined)) {
      inc(report.droppedNodeTypes, String(n.type ?? "?"));
      continue;
    }
    nodes.push(out);
  }
  const top: any = p.value("Message", { ...message, nodeChanges: undefined, blobs: undefined }) ?? {};
  report.nodesOut = nodes.length;
  return {
    ...top,
    type: "NODE_CHANGES",
    sessionID: top.sessionID ?? 0,
    ackID: top.ackID ?? 0,
    nodeChanges: nodes,
    blobs: (message.blobs ?? []).map((b: any) => ({ bytes: b?.bytes instanceof Uint8Array ? b.bytes : new Uint8Array(0) })),
  };
}

// ---------------------------------------------------------------------------------------------------------------------
// 2. Figma's encodings → ours
// ---------------------------------------------------------------------------------------------------------------------

/** ComponentPropRef.componentPropNodeField (or its NodeChange field id) → our PROP_REF binding. */
const PROP_REF_FIELDS: Record<string, { variableField: string; resolved: string }> = {
  VISIBLE: { variableField: "VISIBLE", resolved: "BOOLEAN" },
  TEXT_DATA: { variableField: "TEXT_DATA", resolved: "TEXT_DATA" },
  OVERRIDDEN_SYMBOL_ID: { variableField: "OVERRIDDEN_SYMBOL_ID", resolved: "SYMBOL_ID" },
  SLOT_CONTENT_ID: { variableField: "SLOT_CONTENT_ID", resolved: "SLOT_CONTENT_ID" },
};
const PROP_REF_BY_FIELD_ID: Record<number, string> = { 6: "VISIBLE", 42: "TEXT_DATA", 143: "OVERRIDDEN_SYMBOL_ID" };

const INHERITED_STYLES: [string, string][] = [
  ["inheritFillStyleID", "styleIdForFill"],
  ["inheritFillStyleIDForStroke", "styleIdForStrokeFill"],
  ["inheritTextStyleID", "styleIdForText"],
  ["inheritEffectStyleID", "styleIdForEffect"],
  ["inheritGridStyleID", "styleIdForGrid"],
];

/** The pre-projection pass over every NodeChange (nodes, overrides, text runs): Figma's names → ours. */
function figmaNodeFixups(n: any, report: ImportReport, variantDefs: Map<string, any>): any {
  const m: any = { ...n };
  if (m.type === "GROUP") {
    m.type = "FRAME";
    m.resizeToFit = true;
    inc(report.mappings, "GROUP → FRAME + resizeToFit");
  } else if (m.type === "RECTANGLE") {
    m.type = "ROUNDED_RECTANGLE";
    inc(report.mappings, "RECTANGLE → ROUNDED_RECTANGLE");
  }
  if (m.variableConsumptionMap !== undefined) {
    if (m.parameterConsumptionMap === undefined) {
      m.parameterConsumptionMap = m.variableConsumptionMap;
      inc(report.mappings, "variableConsumptionMap → parameterConsumptionMap");
    }
    delete m.variableConsumptionMap;
  }
  if (Array.isArray(m.componentPropRefs)) {
    const entries: any[] = [...(m.parameterConsumptionMap?.entries ?? [])];
    for (const ref of m.componentPropRefs) {
      if (ref?.isDeleted || !ref?.defID) continue;
      const kind = typeof ref.componentPropNodeField === "string" ? ref.componentPropNodeField : PROP_REF_BY_FIELD_ID[ref.nodeField];
      const target = kind ? PROP_REF_FIELDS[kind] : undefined;
      if (!target) {
        inc(report.droppedFields, `ComponentPropRef.${kind ?? `nodeField ${ref.nodeField}`}`);
        continue;
      }
      if (entries.some((e) => e?.variableField === target.variableField)) continue;
      entries.push({
        variableField: target.variableField,
        variableData: { dataType: "PROP_REF", resolvedDataType: target.resolved, value: { propRefValue: { defId: ref.defID } } },
      });
      inc(report.mappings, "componentPropRefs → PROP_REF");
    }
    if (entries.length) m.parameterConsumptionMap = { ...(m.parameterConsumptionMap ?? {}), entries };
    delete m.componentPropRefs;
  }
  // Library copies (docs/schema.md §8.2): Figma's shared references → sourceLibraryKey / publishID / key / version.
  const ssr = m.sharedSymbolReference;
  const sstr = m.sharedStyleReference;
  const isCopy = !!(ssr || sstr || m.sourceLibraryKey);
  if (ssr) {
    if (m.sourceLibraryKey === undefined && ssr.fileKey) m.sourceLibraryKey = ssr.fileKey;
    if (m.publishID === undefined && ssr.symbolID) m.publishID = ssr.symbolID;
    if (m.key === undefined && ssr.componentKey) m.key = ssr.componentKey;
    if (m.version === undefined && ssr.versionHash) m.version = ssr.versionHash;
    inc(report.mappings, "sharedSymbolReference → sourceLibraryKey/publishID/key/version");
    delete m.sharedSymbolReference;
  }
  if (sstr) {
    if (m.key === undefined && sstr.styleKey) m.key = sstr.styleKey;
    if (m.version === undefined && sstr.versionHash) m.version = sstr.versionHash;
    inc(report.mappings, "sharedStyleReference → key/version");
    delete m.sharedStyleReference;
  }
  if (m.componentKey !== undefined) {
    if (m.key === undefined && m.componentKey) m.key = m.componentKey;
    delete m.componentKey;
  }
  if (m.sharedSymbolVersion !== undefined) {
    // Only a copy's version means "the versionHash it was copied at"; on a local component it is Figma's own counter.
    if (isCopy && m.version === undefined) {
      m.version = m.sharedSymbolVersion;
      inc(report.mappings, "sharedSymbolVersion → version");
    } else inc(report.droppedFields, "NodeChange.sharedSymbolVersion");
    delete m.sharedSymbolVersion;
  }
  for (const k of ["symbolDescription", "styleDescription"]) {
    if (m[k] === undefined) continue;
    if (m.description === undefined && m[k] !== "") {
      m.description = m[k];
      inc(report.mappings, `${k} → description`);
    }
    delete m[k];
  }
  for (const [from, to] of INHERITED_STYLES) {
    if (m[from] === undefined) continue;
    if (m[to] === undefined && !isSentinel(m[from])) {
      m[to] = { guid: m[from] };
      inc(report.mappings, `${from} → ${to}`);
    }
    delete m[from];
  }
  for (const f of DERIVED_FIELDS) {
    if (m[f] !== undefined) {
      delete m[f];
      report.droppedDerived++;
    }
  }
  if (Array.isArray(m.componentPropDefs)) {
    const own = m.componentPropDefs.filter((d: any) => {
      if (d?.parentPropDefId && d.id) {
        variantDefs.set(guidKey(d.id), d.parentPropDefId);
        return false;
      }
      return true;
    });
    if (own.length !== m.componentPropDefs.length) inc(report.mappings, "variant ComponentPropDef → the set's def", m.componentPropDefs.length - own.length);
    if (own.length) m.componentPropDefs = own;
    else delete m.componentPropDefs;
  }
  const sd = m.symbolData;
  if (sd?.symbolID && Array.isArray(sd.symbolOverrides)) {
    let changed = false;
    const overrides = sd.symbolOverrides.map((o: any) => {
      const g = o?.guidPath?.guids;
      if (Array.isArray(g) && g.length === 1 && g[0].sessionID === sd.symbolID.sessionID && g[0].localID === sd.symbolID.localID) {
        changed = true;
        inc(report.mappings, "root override [symbolID] → empty path");
        return { ...o, guidPath: { ...o.guidPath, guids: [] } };
      }
      return o;
    });
    if (changed) m.symbolData = { ...sd, symbolOverrides: overrides };
  }
  return m;
}

export interface ConvertResult {
  message: Message;
  report: ImportReport;
}

/**
 * Converts a Message decoded with Figma's schema (`theirs`) to ours: the fixups, the projection by name, then the
 * reference fixups (variant defs, assetRef, sentinels) and the removal of subtrees whose root was dropped.
 */
export function convertFigMessage(message: any, theirs: SchemaModel, ours: SchemaModel = MODEL): ConvertResult {
  const report = newImportReport();
  const variantDefs = new Map<string, any>();
  const nodeTargets = new Set(["NodeChange"]);
  const fixed = {
    ...message,
    nodeChanges: (message.nodeChanges ?? []).map((n: any) => mapValue(theirs, "NodeChange", n, nodeTargets, (_def, v) => figmaNodeFixups(v, report, variantDefs))),
  };
  const projected = projectMessageByName(fixed, theirs, ours, report);
  let nodes = projected.nodeChanges ?? [];

  // Keys of local assets and library copies, for assetRef references.
  const byKey = new Map<string, any>();
  for (const n of nodes) if (n.key && n.guid && !byKey.has(n.key)) byKey.set(n.key, n.guid);

  const refTargets = new Set(["PropRefValue", "ComponentPropAssignment", "VariantPropSpec", "StyleId", "VariableID", "VariableSetID", "SymbolId", "GUID"]);
  const remapDef = (g: any) => (g ? variantDefs.get(guidKey(g)) : undefined);
  nodes = nodes.map((n) =>
    mapValue(ours, "NodeChange", n, refTargets, (def, v, ctx) => {
      switch (def) {
        case "GUID":
          // Only optional (message) fields can become absent; a struct's GUID (ParentIndex.guid) is required.
          if (!ctx.inArray && isSentinel(v) && ours.defs.get(ctx.parent)?.kind === "MESSAGE") {
            inc(report.mappings, "GUID sentinel → absent");
            return undefined;
          }
          return v;
        case "PropRefValue": {
          const to = remapDef(v.defId);
          return to ? { ...v, defId: to } : v;
        }
        case "ComponentPropAssignment": {
          const to = remapDef(v.defID);
          return to ? { ...v, defID: to } : v;
        }
        case "VariantPropSpec": {
          const to = remapDef(v.propDefId);
          return to ? { ...v, propDefId: to } : v;
        }
        default: {
          // StyleId, VariableID, VariableSetID, SymbolId: {guid?, assetRef?}
          if (v.guid || !v.assetRef?.key) return v;
          const local = byKey.get(v.assetRef.key);
          if (!local) return v;
          inc(report.mappings, "assetRef → local copy guid");
          return { guid: local };
        }
      }
    }),
  );

  // Drop nodes whose parent is gone (the subtree of a dropped node), repeatedly.
  const keys = new Set(nodes.filter((n) => n.guid).map((n) => guidKey(n.guid!)));
  for (;;) {
    const before = nodes.length;
    nodes = nodes.filter((n) => {
      if (!n.guid) return false;
      const p = n.parentIndex?.guid;
      if (!p || n.type === "DOCUMENT" || keys.has(guidKey(p))) return true;
      keys.delete(guidKey(n.guid));
      report.droppedOrphans++;
      return false;
    });
    if (nodes.length === before) break;
  }
  report.nodesOut = nodes.length;
  return { message: { ...projected, nodeChanges: nodes }, report };
}
