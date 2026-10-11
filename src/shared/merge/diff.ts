/**
 * The diff of two node tables (docs/data.md §15.3): per node, per field — and per item for the keyed fields — the
 * difference that turns table `a` into table `b`. It generalizes Restore version's `diffTables` / `restoreDiff`
 * (src/shared/schema/patch.ts, src/shared/store/assetIdentity.ts):
 *
 * - equality is on decoded values; `@blob` fields compare the bytes their indices point at, each through its own table;
 * - a field absent on one side and holding what absence means on the other is no change (docs/schema.md §3.4);
 * - `@derived` fields are never compared;
 * - the keyed fields (§15.3's table) are diffed per item, so two sides editing different items of one property don't
 *   collide; everything else is one value (docs/schema.md §4.2).
 *
 * Pure: no Node or DOM. The three-way merge (merge3.ts) is built on it.
 */
import type { NodeChange } from "../schema/document.generated";
import { guidKey, compareGuids, type GUID } from "../schema/guid";
import { DERIVED_FIELDS, isTypeConversion, type NodeTable } from "../schema/patch";
import { MODEL, type SchemaModel } from "../schema/model";
import { valuesEqual } from "../schema/visit";
import { isAbsentValue } from "../store/assetIdentity";
import { ABSENT, type FieldChange, type ItemChange, type NodeDelta, type TableDiff, type Value } from "./types";

/* eslint-disable @typescript-eslint/no-explicit-any -- generic field access on decoded kiwi objects */

/** Fields of a NodeChange that are never data: the address and the patch bookkeeping. */
const NOT_DATA: ReadonlySet<string> = new Set(["guid", "phase", "clearedFields", "guidPath"]);

type Blob = (index: number) => Uint8Array | undefined;

// ---------------------------------------------------------------------------------------------------------------------
// Keyed fields (§15.3)
// ---------------------------------------------------------------------------------------------------------------------

/** One keyed field: how to split its value into items by key, compare an item, and put a value back together. */
export interface KeyedField {
  field: string;
  /** itemKey → item value (a list element, or one override's field) */
  items(value: any): Map<string, any>;
  /** Item equality, blob-aware */
  itemEqual(itemKey: string, a: any, b: any, blobA: Blob, blobB: Blob): boolean;
  /**
   * The field's value holding exactly `items`, in `order` (item keys; keys not in it go last, in insertion order).
   * `template` is a value of the field to take the non-item parts from (null: none). ABSENT when nothing is left.
   */
  rebuild(template: any, items: Map<string, any>, order: string[]): Value;
}

const gk = (g: GUID | undefined | null): string => (g ? guidKey(g) : "");

function ordered(items: Map<string, any>, order: string[]): [string, any][] {
  const out: [string, any][] = [];
  const seen = new Set<string>();
  for (const k of order) {
    if (seen.has(k) || !items.has(k)) continue;
    seen.add(k);
    out.push([k, items.get(k)]);
  }
  for (const [k, v] of items) if (!seen.has(k)) out.push([k, v]);
  return out;
}

/** A list field whose elements carry their own key. */
function listField(field: string, key: (item: any) => string, model: SchemaModel = MODEL): KeyedField {
  const fd = model.def("NodeChange").byName.get(field)!;
  return {
    field,
    items(value) {
      const m = new Map<string, any>();
      if (Array.isArray(value)) for (const it of value) if (it != null) m.set(key(it), it);
      return m;
    },
    itemEqual: (_k, a, b, blobA, blobB) => valuesEqual(model, fd.type!, false, a, b, blobA, blobB),
    rebuild(_template, items, order) {
      const list = ordered(items, order).map(([, v]) => v);
      return list.length ? list : ABSENT;
    },
  };
}

/** A message field holding one keyed list in `entries` (VariableDataMap, VariableDataValues). */
function entriesField(field: string, entryType: string, key: (entry: any) => string, model: SchemaModel = MODEL): KeyedField {
  return {
    field,
    items(value) {
      const m = new Map<string, any>();
      for (const e of value?.entries ?? []) if (e != null) m.set(key(e), e);
      return m;
    },
    itemEqual: (_k, a, b, blobA, blobB) => valuesEqual(model, entryType, false, a, b, blobA, blobB),
    rebuild(template, items, order) {
      const entries = ordered(items, order).map(([, v]) => v);
      const rest: any = template && typeof template === "object" ? { ...template } : {};
      delete rest.entries;
      if (!entries.length && !Object.keys(rest).length) return ABSENT;
      return { ...rest, entries };
    },
  };
}

/** Item keys of `symbolData`: its own fields as "@<field>", each override's fields as "<path>#<field>". */
const SYMBOL_OWN = "@";
const pathKeyOf = (entry: any): string => ((entry?.guidPath?.guids ?? []) as GUID[]).map(guidKey).join("/");

function symbolDataField(model: SchemaModel = MODEL): KeyedField {
  const sd = model.def("SymbolData");
  const nc = model.def("NodeChange");
  /** guidPath objects by path key, so a rebuilt entry keeps its address */
  const paths = new Map<string, any>();
  return {
    field: "symbolData",
    items(value) {
      const m = new Map<string, any>();
      if (!value || typeof value !== "object") return m;
      for (const f of Object.keys(value)) if (f !== "symbolOverrides" && value[f] !== undefined) m.set(SYMBOL_OWN + f, value[f]);
      for (const e of value.symbolOverrides ?? []) {
        if (!e) continue;
        const p = pathKeyOf(e);
        if (!paths.has(p)) paths.set(p, e.guidPath ?? { guids: [] });
        for (const f of Object.keys(e)) {
          if (NOT_DATA.has(f) || e[f] === undefined) continue;
          m.set(`${p}#${f}`, e[f]);
        }
      }
      return m;
    },
    itemEqual(k, a, b, blobA, blobB) {
      if (k.startsWith(SYMBOL_OWN)) {
        const fd = sd.byName.get(k.slice(1));
        return fd?.type ? valuesEqual(model, fd.type, fd.isArray, a, b, blobA, blobB) : a === b;
      }
      const fd = nc.byName.get(k.slice(k.indexOf("#") + 1));
      return fd?.type ? valuesEqual(model, fd.type, fd.isArray, a, b, blobA, blobB) : a === b;
    },
    rebuild(template, items, order) {
      const out: any = {};
      const entries = new Map<string, any>();
      for (const [k, v] of ordered(items, order)) {
        if (k.startsWith(SYMBOL_OWN)) {
          out[k.slice(1)] = v;
          continue;
        }
        const hash = k.indexOf("#");
        const p = k.slice(0, hash);
        let e = entries.get(p);
        if (!e) entries.set(p, (e = { guidPath: paths.get(p) ?? { guids: p ? p.split("/").map(parseKey) : [] } }));
        e[k.slice(hash + 1)] = v;
      }
      if (entries.size) out.symbolOverrides = [...entries.values()];
      else if (template?.symbolOverrides && Object.keys(out).length) out.symbolOverrides = [];
      return Object.keys(out).length ? out : ABSENT;
    },
  };
}

function parseKey(k: string): GUID {
  const [s, l] = k.split(":");
  return { sessionID: Number(s), localID: Number(l) };
}

/** The keyed fields of §15.3, by field name. A fresh set per diff (the symbolData one remembers override paths). */
export function keyedFields(model: SchemaModel = MODEL): Map<string, KeyedField> {
  const list: KeyedField[] = [
    symbolDataField(model),
    listField("componentPropAssignments", (a) => gk(a.defID), model),
    listField("componentPropDefs", (d) => gk(d.id), model),
    entriesField("parameterConsumptionMap", "VariableDataMapEntry", (e) => String(e.variableField ?? ""), model),
    entriesField("variableDataValues", "VariableDataValuesEntry", (e) => gk(e.modeID), model),
    listField("variableSetModes", (m) => gk(m.id), model),
    listField("prototypeInteractions", (i) => gk(i.id), model),
    listField("librarySubscriptions", (s) => String(s.libraryKey ?? ""), model),
  ];
  return new Map(list.map((k) => [k.field, k]));
}

// ---------------------------------------------------------------------------------------------------------------------
// Field equality
// ---------------------------------------------------------------------------------------------------------------------

/** `v` as a diff value: ABSENT for a missing field. */
export const valueOf = (node: any, field: string): Value => (node && node[field] !== undefined ? node[field] : ABSENT);

/**
 * Field equality across two tables: both absent (or holding what absence means) is equal (docs/schema.md §3.4);
 * otherwise deep, blob-aware equality.
 */
export function fieldEqual(field: string, a: Value, b: Value, blobA: Blob, blobB: Blob, model: SchemaModel = MODEL): boolean {
  const aAbsent = a === ABSENT || isAbsentValue(field, a, model);
  const bAbsent = b === ABSENT || isAbsentValue(field, b, model);
  if (aAbsent || bAbsent) return aAbsent && bAbsent;
  const fd = model.def("NodeChange").byName.get(field);
  if (!fd?.type) return a === b;
  return valuesEqual(model, fd.type, fd.isArray, a, b, blobA, blobB);
}

const ITEM_ABSENT = (v: any): Value => (v === undefined ? ABSENT : v);

// ---------------------------------------------------------------------------------------------------------------------
// diff
// ---------------------------------------------------------------------------------------------------------------------

export interface DiffOptions {
  model?: SchemaModel;
  /** Keys to compare (default: every key of either table) */
  keys?: Iterable<string>;
}

/**
 * The per-node, per-field difference that turns `a` into `b`. A node only in `b` is "created" (every field), only in
 * `a` "removed", in both "updated" with its changed fields and keyed items — except a type change that is not one of
 * the conversions (docs/schema.md §3.2), which is a full replace and comes out "created".
 */
export function diff(a: NodeTable, b: NodeTable, opts: DiffOptions = {}): TableDiff {
  const model = opts.model ?? MODEL;
  const keyed = keyedFields(model);
  const deltas = new Map<string, NodeDelta>();
  const keys = opts.keys ? new Set(opts.keys) : new Set([...a.nodes.keys(), ...b.nodes.keys()]);
  const blobA: Blob = (i) => a.blob(i);
  const blobB: Blob = (i) => b.blob(i);
  for (const key of keys) {
    const na: any = a.nodes.get(key);
    const nb: any = b.nodes.get(key);
    if (na === nb) continue;
    if (!nb) {
      if (na) deltas.set(key, { key, guid: na.guid, phase: "removed", fields: [], items: [] });
      continue;
    }
    if (!na || !isTypeConversion(na.type, nb.type)) {
      deltas.set(key, { key, guid: nb.guid, phase: "created", fields: allFields(nb, na), items: [] });
      continue;
    }
    const d = nodeDelta(na, nb, keyed, blobA, blobB, model);
    if (d) deltas.set(key, d);
  }
  return { deltas };
}

function allFields(n: any, before: any): FieldChange[] {
  const out: FieldChange[] = [];
  for (const f of Object.keys(n)) {
    if (NOT_DATA.has(f) || DERIVED_FIELDS.has(f) || n[f] === undefined) continue;
    out.push({ field: f, before: valueOf(before, f), after: n[f] });
  }
  return out;
}

/** The changed fields and items of a node in both tables; null when nothing changed. */
export function nodeDelta(na: any, nb: any, keyed: Map<string, KeyedField>, blobA: Blob, blobB: Blob, model: SchemaModel = MODEL): NodeDelta | null {
  const fields: FieldChange[] = [];
  const items: ItemChange[] = [];
  const names = new Set([...Object.keys(na), ...Object.keys(nb)]);
  for (const f of names) {
    if (NOT_DATA.has(f) || DERIVED_FIELDS.has(f)) continue;
    const va = valueOf(na, f);
    const vb = valueOf(nb, f);
    if (va === vb) continue;
    const k = keyed.get(f);
    if (k) {
      const ia = k.items(va === ABSENT ? undefined : va);
      const ib = k.items(vb === ABSENT ? undefined : vb);
      for (const ik of new Set([...ia.keys(), ...ib.keys()])) {
        const x = ia.get(ik);
        const y = ib.get(ik);
        if (x !== undefined && y !== undefined && k.itemEqual(ik, x, y, blobA, blobB)) continue;
        if (x === undefined && y === undefined) continue;
        items.push({ field: f, itemKey: ik, before: ITEM_ABSENT(x), after: ITEM_ABSENT(y) });
      }
      continue;
    }
    if (fieldEqual(f, va, vb, blobA, blobB, model)) continue;
    fields.push({ field: f, before: va, after: vb });
  }
  if (!fields.length && !items.length) return null;
  return { key: guidKey(nb.guid ?? na.guid), guid: nb.guid ?? na.guid, phase: "updated", fields, items };
}

/** Keys in GUID order (deterministic output). */
export function sortKeys(keys: Iterable<string>): string[] {
  return [...keys].sort((x, y) => compareGuids(parseKey(x), parseKey(y)));
}

/** A node's parent key ("" for none). */
export const parentOf = (n: NodeChange | undefined): string => (n?.parentIndex?.guid ? guidKey(n.parentIndex.guid) : "");
