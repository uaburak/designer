/**
 * Components, instances, variants and component properties as plain data (no
 * engine, no React): schema/document.kiwi's shapes (`componentPropDefs`,
 * `componentPropAssignments`, `symbolData`, `variantPropSpecs`,
 * `parameterConsumptionMap` PROP_REF bindings — docs/schema.md §5) and
 * Figma's rules for them (docs/research/figma/R4-components.md): variant
 * names `Prop=Value, Prop2=Value`, "Combine as variants" naming, the default
 * variant (top-left), a variant switch's target, the instance panel's
 * property rows, the "Reset ▸" list, and local components grouped by page and
 * frame for Assets and the instance menu.
 */
import type { Guid, NodeChange } from "@/engine/codec";

// ---- Schema shapes (the facade doesn't type them yet) -----------------------------------------------------------

export interface GuidValue {
  sessionID: number;
  localID: number;
}

export type ComponentPropType = "BOOL" | "TEXT" | "INSTANCE_SWAP" | "VARIANT" | "SLOT";

export interface ComponentPropValue {
  boolValue?: boolean;
  textValue?: { characters: string };
  guidValue?: GuidValue;
}

export interface InstanceSwapPreferredValue {
  type: "COMPONENT" | "STATE_GROUP";
  key: string;
}

export interface ComponentPropDef {
  id: GuidValue;
  name: string;
  type: ComponentPropType;
  initialValue?: ComponentPropValue;
  sortPosition?: string;
  preferredValues?: { stringValues?: string[]; instanceSwapValues?: InstanceSwapPreferredValue[] };
  description?: string;
  slotPropConfig?: { stretchChildOnInsert?: boolean; displayByDefault?: boolean; minChildren?: number; maxChildren?: number; allowPreferredValuesOnly?: boolean };
  [other: string]: unknown;
}

export interface ComponentPropAssignment {
  defID: GuidValue;
  value?: ComponentPropValue;
  varValue?: unknown;
}

export interface VariantPropSpec {
  propDefId: GuidValue;
  value: string;
}

export interface GuidPath {
  guids?: GuidValue[];
}

export type OverrideEntry = Record<string, unknown> & { guidPath?: GuidPath };

export interface SymbolData {
  symbolID?: GuidValue;
  symbolOverrides?: OverrideEntry[];
  uniformScaleFactor?: number;
}

export type BindableField = "VISIBLE" | "TEXT_DATA" | "OVERRIDDEN_SYMBOL_ID" | "SLOT_CONTENT_ID";

export interface ParameterEntry {
  variableField: string;
  variableData: { dataType?: string; resolvedDataType?: string; value?: { propRefValue?: { defId: GuidValue } } & Record<string, unknown> };
}

/** The component fields of a node (all optional; schema names). */
export interface ComponentFields {
  componentPropDefs?: ComponentPropDef[];
  componentPropAssignments?: ComponentPropAssignment[];
  isStateGroup?: boolean;
  stateGroupPropertyValueOrders?: { property: string; values: string[] }[];
  variantPropSpecs?: VariantPropSpec[];
  symbolData?: SymbolData;
  overriddenSymbolID?: GuidValue;
  propsAreBubbled?: boolean;
  overrideKey?: GuidValue;
  parameterConsumptionMap?: { entries?: ParameterEntry[] };
  description?: string;
  key?: string;
  isSoftDeleted?: boolean;
  isSymbolPublishable?: boolean;
  textData?: { characters?: string };
  internalOnly?: boolean;
}

/** A node as these helpers read it: a NodeChange with its component fields and its real type. */
export type CNode = Omit<NodeChange, "type"> & ComponentFields & { type?: string };

// ---- GUIDs ------------------------------------------------------------------------------------------------------

export const guidStr = (g: GuidValue | undefined | null): Guid => (g ? `${g.sessionID}:${g.localID}` : "");
export function guidVal(s: Guid): GuidValue {
  const [a, b] = s.split(":").map(Number);
  return { sessionID: a >>> 0, localID: b >>> 0 };
}
export const sameGuid = (a: GuidValue | undefined, b: GuidValue | undefined) => !!a && !!b && a.sessionID === b.sessionID && a.localID === b.localID;

/** A node's effective override key (docs/schema.md §5.1): `overrideKey`, else its own GUID. */
export const effectiveKey = (n: CNode): GuidValue => n.overrideKey ?? guidVal(n.guid);

/** A derived sublayer's id (docs/schema.md §5.1): "I" + instance + (";" + key)*. */
export const derivedId = (instance: Guid, path: readonly GuidValue[]): Guid => `I${instance}${path.map((k) => `;${guidStr(k)}`).join("")}`;

/** The instance and the key path of a derived id, or null for a real node's id. */
export function parseDerivedId(id: Guid): { instance: Guid; path: GuidValue[] } | null {
  if (!id.startsWith("I")) return null;
  const [instance, ...keys] = id.slice(1).split(";");
  return { instance, path: keys.map(guidVal) };
}

/**
 * Ids for definitions (`ComponentPropDef.id`): unique within the file and apart from node GUIDs, which the engine
 * allocates from the bottom of the session's range — so the editor counts down from the top of it.
 */
export const DEF_ID_BASE = 0x7ff00000;
const DEF_ID_TOP = 0x7fffffff;
export function nextDefId(session: number, used: Iterable<GuidValue>): GuidValue {
  let low = DEF_ID_TOP;
  for (const g of used) if (g.sessionID === session && g.localID >= DEF_ID_BASE && g.localID <= low) low = g.localID - 1;
  return { sessionID: session, localID: low };
}

// ---- Kinds ------------------------------------------------------------------------------------------------------

export const isComponent = (n: CNode | null | undefined): boolean => n?.type === "SYMBOL";
export const isInstance = (n: CNode | null | undefined): boolean => n?.type === "INSTANCE";
export const isComponentSet = (n: CNode | null | undefined): boolean => n?.type === "FRAME" && n.isStateGroup === true;

// ---- Variants -----------------------------------------------------------------------------------------------------

/** "Size=Large, State=Hover" → [["Size","Large"],["State","Hover"]]; null when the name isn't a variant name. */
export function parseVariantName(name: string): [string, string][] | null {
  const parts = name.split(",").map((p) => p.trim()).filter(Boolean);
  if (!parts.length) return null;
  const out: [string, string][] = [];
  for (const p of parts) {
    const eq = p.indexOf("=");
    if (eq <= 0) return null;
    out.push([p.slice(0, eq).trim(), p.slice(eq + 1).trim()]);
  }
  return out;
}

export const formatVariantName = (pairs: readonly (readonly [string, string])[]): string => pairs.map(([k, v]) => `${k}=${v}`).join(", ");

/**
 * "Combine as variants" (R4 §5): each component's slash name becomes its values; the properties are named
 * Variant, Property 2, Property 3… (a name already in Prop=Value form keeps its properties). Values that would
 * repeat a combination are made unique with a number, as Figma does to avoid a conflict.
 */
export function combineNames(names: readonly string[]): { properties: string[]; values: string[][] } {
  const parsed = names.map(parseVariantName);
  if (parsed.every((p) => p !== null)) {
    const properties: string[] = [];
    for (const p of parsed) for (const [k] of p!) if (!properties.includes(k)) properties.push(k);
    const values = parsed.map((p) => properties.map((k) => p!.find(([pk]) => pk === k)?.[1] ?? "Default"));
    return { properties, values: uniqueRows(values) };
  }
  const split = names.map((n) => n.split("/").map((s) => s.trim()).filter(Boolean));
  const width = Math.max(1, ...split.map((s) => s.length));
  const properties = Array.from({ length: width }, (_, i) => (i === 0 ? "Variant" : `Property ${i + 1}`));
  const values = split.map((s) => properties.map((_, i) => s[i] ?? "Default"));
  return { properties, values: uniqueRows(values) };
}

function uniqueRows(rows: string[][]): string[][] {
  const seen = new Set<string>();
  return rows.map((row) => {
    let r = row;
    let n = 2;
    while (seen.has(r.join("\u0000"))) r = [...row.slice(0, -1), `${row[row.length - 1]} ${n++}`];
    seen.add(r.join("\u0000"));
    return r;
  });
}

/** A variant's value per property name (from `variantPropSpecs` and the set's defs, else its name). */
export function variantValues(variant: CNode, setDefs: readonly ComponentPropDef[]): Map<string, string> {
  const out = new Map<string, string>();
  for (const spec of variant.variantPropSpecs ?? []) {
    const def = setDefs.find((d) => sameGuid(d.id, spec.propDefId));
    if (def) out.set(def.name, spec.value);
  }
  if (!out.size) for (const [k, v] of parseVariantName(variant.name ?? "") ?? []) out.set(k, v);
  return out;
}

/** The set's variant properties, in the set's order, each with its values in the UI's order. */
export function variantProperties(set: CNode, variants: readonly CNode[]): { name: string; def?: ComponentPropDef; values: string[] }[] {
  const defs = (set.componentPropDefs ?? []).filter((d) => d.type === "VARIANT");
  const names: string[] = defs.map((d) => d.name);
  const all = variants.map((v) => variantValues(v, set.componentPropDefs ?? []));
  for (const m of all) for (const k of m.keys()) if (!names.includes(k)) names.push(k);
  return names.map((name) => {
    const order = set.stateGroupPropertyValueOrders?.find((o) => o.property === name)?.values ?? [];
    const values = [...order];
    for (const m of all) {
      const v = m.get(name);
      if (v !== undefined && !values.includes(v)) values.push(v);
    }
    return { name, def: defs.find((d) => d.name === name), values };
  });
}

/** The set's default variant: the top-left one (R4 §5), by y then x. */
export function defaultVariant<T extends CNode>(variants: readonly T[]): T | null {
  let best: T | null = null;
  for (const v of variants) {
    const x = v.transform?.m02 ?? 0;
    const y = v.transform?.m12 ?? 0;
    const bx = best?.transform?.m02 ?? 0;
    const by = best?.transform?.m12 ?? 0;
    if (!best || y < by - 0.5 || (Math.abs(y - by) <= 0.5 && x < bx)) best = v;
  }
  return best;
}

/**
 * A variant switch: the variant with `property` = `value` that keeps the most of the current one's other values
 * (an exact match first); null when no variant has that value.
 */
export function variantFor<T extends CNode>(current: T, variants: readonly T[], setDefs: readonly ComponentPropDef[], property: string, value: string): T | null {
  const now = variantValues(current, setDefs);
  let best: T | null = null;
  let bestScore = -1;
  for (const v of variants) {
    const vals = variantValues(v, setDefs);
    if (vals.get(property) !== value) continue;
    let score = 0;
    for (const [k, val] of now) if (k !== property && vals.get(k) === val) score++;
    if (score > bestScore) {
      best = v;
      bestScore = score;
    }
  }
  return best;
}

/** The variant name after renaming a property or one of its values (null: unchanged). */
export function renameInVariantName(name: string, property: string, next: { property?: string; value?: [string, string] }): string | null {
  const pairs = parseVariantName(name);
  if (!pairs) return null;
  let changed = false;
  const out = pairs.map(([k, v]) => {
    if (k !== property) return [k, v] as [string, string];
    let nk = k;
    let nv = v;
    if (next.property && next.property !== k) nk = next.property;
    if (next.value && next.value[0] === v) nv = next.value[1];
    if (nk !== k || nv !== v) changed = true;
    return [nk, nv] as [string, string];
  });
  return changed ? formatVariantName(out) : null;
}

// ---- Properties -------------------------------------------------------------------------------------------------

export const PROPERTY_TYPE_LABEL: Record<ComponentPropType, string> = { BOOL: "Boolean", TEXT: "Text", INSTANCE_SWAP: "Instance swap", VARIANT: "Variant", SLOT: "Slot" };

/** The binding each property type makes on a layer (docs/schema.md §5.5). */
export const BINDING_OF: Record<Exclude<ComponentPropType, "VARIANT">, { field: BindableField; resolved: string }> = {
  BOOL: { field: "VISIBLE", resolved: "BOOLEAN" },
  TEXT: { field: "TEXT_DATA", resolved: "TEXT_DATA" },
  INSTANCE_SWAP: { field: "OVERRIDDEN_SYMBOL_ID", resolved: "SYMBOL_ID" },
  SLOT: { field: "SLOT_CONTENT_ID", resolved: "SLOT_CONTENT_ID" },
};

/** Defs in the panel's order: variant properties first (R4 §6), then by sortPosition, else as stored. */
export function sortedDefs(defs: readonly ComponentPropDef[]): ComponentPropDef[] {
  return defs
    .map((d, i) => ({ d, i }))
    .sort((a, b) => {
      const va = a.d.type === "VARIANT" ? 0 : 1;
      const vb = b.d.type === "VARIANT" ? 0 : 1;
      if (va !== vb) return va - vb;
      const sa = a.d.sortPosition ?? "";
      const sb = b.d.sortPosition ?? "";
      if (sa && sb && sa !== sb) return sa < sb ? -1 : 1;
      return a.i - b.i;
    })
    .map((x) => x.d);
}

/** Figma's default name for a new property of a type ("Property 1", "Property 2"… unique among `defs`). */
export function newPropertyName(defs: readonly ComponentPropDef[], base = "Property"): string {
  const names = new Set(defs.map((d) => d.name));
  for (let i = 1; ; i++) if (!names.has(`${base} ${i}`)) return `${base} ${i}`;
}

/** A new definition of `type` with Figma's defaults (Boolean true, Text "Text", the given component, Variant "Default"). */
export function newPropertyDef(type: ComponentPropType, id: GuidValue, name: string, value?: ComponentPropValue): ComponentPropDef {
  const initialValue: ComponentPropValue =
    value ?? (type === "BOOL" ? { boolValue: true } : type === "TEXT" ? { textValue: { characters: "Text" } } : type === "VARIANT" ? { textValue: { characters: "Default" } } : {});
  return { id, name, type, initialValue };
}

/** The API name (Figma's `Name#id` for non-variant properties). */
export const propertyApiName = (d: ComponentPropDef): string => (d.type === "VARIANT" ? d.name : `${d.name}#${guidStr(d.id)}`);

/** An instance's value for a def: its assignment, else the def's default. */
export function assignedValue(def: ComponentPropDef, assignments: readonly ComponentPropAssignment[] | undefined): ComponentPropValue | undefined {
  return assignments?.find((a) => sameGuid(a.defID, def.id))?.value ?? def.initialValue;
}

/** `assignments` with `def` set to `value` (one entry per def). */
export function withAssignment(assignments: readonly ComponentPropAssignment[] | undefined, def: ComponentPropDef, value: ComponentPropValue): ComponentPropAssignment[] {
  const out = (assignments ?? []).filter((a) => !sameGuid(a.defID, def.id));
  out.push({ defID: def.id, value });
  return out;
}

/** The node's PROP_REF bindings: field → def id. */
export function bindingsOf(n: CNode): Map<string, GuidValue> {
  const out = new Map<string, GuidValue>();
  for (const e of n.parameterConsumptionMap?.entries ?? []) {
    const id = e.variableData?.value?.propRefValue?.defId;
    if (e.variableData?.dataType === "PROP_REF" && id) out.set(e.variableField, id);
  }
  return out;
}

/** The node's `parameterConsumptionMap` with `field` bound to `def` (null: unbound), other entries kept. */
export function withBinding(n: CNode, field: BindableField, def: ComponentPropDef | null): { entries: ParameterEntry[] } {
  const entries = (n.parameterConsumptionMap?.entries ?? []).filter((e) => e.variableField !== field);
  if (def && def.type !== "VARIANT") {
    const resolved = BINDING_OF[def.type].resolved;
    entries.push({ variableField: field, variableData: { dataType: "PROP_REF", resolvedDataType: resolved, value: { propRefValue: { defId: def.id } } } });
  }
  return { entries };
}

/** Which binding a property type makes, and whether a layer of `type` can take it. */
export function canBind(def: Pick<ComponentPropDef, "type">, layerType: string): boolean {
  switch (def.type) {
    case "BOOL":
      return true;
    case "TEXT":
      return layerType === "TEXT";
    case "INSTANCE_SWAP":
      return layerType === "INSTANCE";
    case "SLOT":
      return layerType === "FRAME";
    default:
      return false;
  }
}

/** Every layer in a component bound to `def` loses the binding (a deleted property): the nodes to rewrite. */
export function unbindAll(nodes: readonly CNode[], def: ComponentPropDef): { guid: Guid; parameterConsumptionMap: { entries: ParameterEntry[] } }[] {
  const out: { guid: Guid; parameterConsumptionMap: { entries: ParameterEntry[] } }[] = [];
  for (const n of nodes) {
    const entries = n.parameterConsumptionMap?.entries ?? [];
    const kept = entries.filter((e) => !sameGuid(e.variableData?.value?.propRefValue?.defId, def.id));
    if (kept.length !== entries.length) out.push({ guid: n.guid, parameterConsumptionMap: { entries: kept } });
  }
  return out;
}

// ---- Overrides ("changes") --------------------------------------------------------------------------------------

const pathKey = (p: GuidPath | undefined) => (p?.guids ?? []).map(guidStr).join(";");

/** The override entry at `path` (empty = the instance root), or undefined. */
export function overrideAt(sd: SymbolData | undefined, path: readonly GuidValue[]): OverrideEntry | undefined {
  const key = path.map(guidStr).join(";");
  return sd?.symbolOverrides?.find((e) => pathKey(e.guidPath) === key);
}

/** `symbolData` with `fields` merged into the entry at `path` (a whole-value rewrite, docs/schema.md §5.2). */
export function withOverride(sd: SymbolData, path: readonly GuidValue[], fields: Record<string, unknown>): SymbolData {
  const key = path.map(guidStr).join(";");
  const entries = [...(sd.symbolOverrides ?? [])];
  const at = entries.findIndex((e) => pathKey(e.guidPath) === key);
  const next: OverrideEntry = { ...(at >= 0 ? entries[at] : {}), ...fields, guidPath: { guids: [...path] } };
  if (at >= 0) entries[at] = next;
  else entries.push(next);
  return { ...sd, symbolOverrides: entries };
}

/** Figma's "Reset ▸" names for overridden fields (one item per group). */
const RESET_GROUPS: [string, string[]][] = [
  ["Fill", ["fillPaints", "styleIdForFill"]],
  ["Stroke", ["strokePaints", "strokeWeight", "strokeAlign", "strokeCap", "strokeJoin", "dashPattern", "styleIdForStrokeFill", "borderTopWeight", "borderRightWeight", "borderBottomWeight", "borderLeftWeight", "borderStrokeWeightsIndependent"]],
  ["Effects", ["effects", "styleIdForEffect"]],
  ["Text", ["textData"]],
  ["Text style", ["fontName", "fontSize", "lineHeight", "letterSpacing", "paragraphSpacing", "paragraphIndent", "textCase", "textDecoration", "textAlignHorizontal", "textAlignVertical", "styleIdForText"]],
  ["Layer name", ["name"]],
  ["Visibility", ["visible"]],
  ["Opacity", ["opacity", "blendMode"]],
  ["Size", ["size", "stackPrimarySizing", "stackCounterSizing", "minSize", "maxSize", "textAutoResize"]],
  ["Corner radius", ["cornerRadius", "rectangleTopLeftCornerRadius", "rectangleTopRightCornerRadius", "rectangleBottomLeftCornerRadius", "rectangleBottomRightCornerRadius", "rectangleCornerRadiiIndependent"]],
  ["Auto layout", ["stackSpacing", "stackHorizontalPadding", "stackVerticalPadding", "stackPaddingRight", "stackPaddingBottom", "stackPrimaryAlignItems", "stackCounterAlignItems", "stackChildPrimaryGrow", "stackChildAlignSelf", "stackPositioning"]],
  ["Layout guide", ["layoutGrids"]],
  ["Export", ["exportSettings"]],
  ["Instance", ["overriddenSymbolID"]],
  ["Properties", ["componentPropAssignments"]],
];

/** The fields an instance changed: its overrides' fields, and its own property values. */
export function changedFields(instance: CNode): Set<string> {
  const fields = new Set<string>();
  for (const e of instance.symbolData?.symbolOverrides ?? []) for (const k of Object.keys(e)) if (k !== "guidPath" && k !== "guid") fields.add(k);
  if (instance.componentPropAssignments?.length) fields.add("componentPropAssignments");
  return fields;
}

/** The groups of changes an instance has, in menu order. */
export function changedGroups(instance: CNode): { label: string; fields: string[] }[] {
  return groupChanges(changedFields(instance));
}

/** Changed fields as Figma's "Reset ▸" items (one per group it has), in menu order. */
export function groupChanges(fields: ReadonlySet<string>): { label: string; fields: string[] }[] {
  const out: { label: string; fields: string[] }[] = [];
  const known = new Set<string>();
  for (const [label, group] of RESET_GROUPS) {
    group.forEach((f) => known.add(f));
    const hit = group.filter((f) => fields.has(f));
    if (hit.length) out.push({ label, fields: hit });
  }
  const other = [...fields].filter((f) => !known.has(f));
  if (other.length) out.push({ label: "Other changes", fields: other });
  return out;
}

/** `symbolData` without `fields` in any entry (entries left empty go). */
export function withoutOverrides(sd: SymbolData, fields: readonly string[] | null): SymbolData {
  if (!fields) return { ...sd, symbolOverrides: [] };
  const drop = new Set(fields);
  const entries: OverrideEntry[] = [];
  for (const e of sd.symbolOverrides ?? []) {
    const kept = Object.fromEntries(Object.entries(e).filter(([k]) => !drop.has(k))) as OverrideEntry;
    if (Object.keys(kept).some((k) => k !== "guidPath" && k !== "guid")) entries.push(kept);
  }
  return { ...sd, symbolOverrides: entries };
}

// ---- Local components (Assets, the instance menu) ----------------------------------------------------------------

export interface ComponentAsset {
  /** The component, or the set (its default variant is what gets inserted) */
  id: Guid;
  name: string;
  kind: "component" | "set";
  /** What an insert or a swap uses: the component, or the set's default variant */
  target: Guid;
  page: Guid;
  pageName: string;
  /** The top-level frame it sits in (Figma groups by it), or null when it is on the page */
  frame: Guid | null;
  frameName: string | null;
  description?: string;
  key?: string;
  variantCount?: number;
}

export interface AssetGroup {
  page: Guid;
  pageName: string;
  frames: { frame: Guid | null; frameName: string | null; items: ComponentAsset[] }[];
}

/** Assets grouped by page, then by frame (on-page ones first), each in name order. */
export function groupAssets(assets: readonly ComponentAsset[], pageOrder: readonly Guid[]): AssetGroup[] {
  const pages = new Map<Guid, AssetGroup>();
  for (const a of assets) {
    let g = pages.get(a.page);
    if (!g) pages.set(a.page, (g = { page: a.page, pageName: a.pageName, frames: [] }));
    let f = g.frames.find((x) => x.frame === a.frame);
    if (!f) g.frames.push((f = { frame: a.frame, frameName: a.frameName, items: [] }));
    f.items.push(a);
  }
  const collator = new Intl.Collator("en", { numeric: true, sensitivity: "base" });
  for (const g of pages.values()) {
    g.frames.sort((a, b) => (a.frame === null ? -1 : b.frame === null ? 1 : collator.compare(a.frameName ?? "", b.frameName ?? "")));
    for (const f of g.frames) f.items.sort((a, b) => collator.compare(a.name, b.name));
  }
  return [...pages.values()].sort((a, b) => pageOrder.indexOf(a.page) - pageOrder.indexOf(b.page));
}

/** Assets matching a search (name, page, frame, description; every word must match). */
export function searchAssets(assets: readonly ComponentAsset[], query: string): ComponentAsset[] {
  const words = query.toLowerCase().split(/\s+/).filter(Boolean);
  if (!words.length) return [...assets];
  return assets.filter((a) => {
    const hay = `${a.name} ${a.pageName} ${a.frameName ?? ""} ${a.description ?? ""}`.toLowerCase();
    return words.every((w) => hay.includes(w));
  });
}

/**
 * Does a preferred value point at this asset? Local components are keyed by their GUID string ("s:l", the
 * engine's rule); published ones by their `key`.
 */
export const isPreferred = (a: Pick<ComponentAsset, "id" | "target" | "key">, key: string): boolean => key === a.id || key === a.target || (!!a.key && key === a.key);

/** The key a new preferred value gets for an asset (its GUID string; docs/engine-build.md E6). */
export const preferredKey = (a: Pick<ComponentAsset, "id">): string => a.id;

/** The name an asset shows: the last part of a slash name ("Buttons/Primary" → "Primary"). */
export const assetLabel = (name: string): string => name.split("/").map((s) => s.trim()).filter(Boolean).pop() ?? name;
