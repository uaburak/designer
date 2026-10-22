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
import { t, tp } from "@/i18n";
import Fuse from "fuse.js";
import type { IconName } from "@/ds";
import type { Guid, NodeChange } from "@/engine/codec";

// ---- Schema shapes (the facade doesn't type them yet) -----------------------------------------------------------

export interface GuidValue {
  sessionID: number;
  localID: number;
}

export type ComponentPropType = "BOOL" | "TEXT" | "INSTANCE_SWAP" | "VARIANT" | "NUMBER" | "SLOT";

export interface ComponentPropValue {
  boolValue?: boolean;
  textValue?: { characters: string };
  guidValue?: GuidValue;
  /** NUMBER (2 decimals) */
  floatValue?: number;
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

/** A GUID structure as "s:l" (the engine writes `{sessionID, localID}`; payloads read back from the store may hold "s:l"). */
export const guidStr = (g: GuidValue | Guid | undefined | null): Guid => (!g ? "" : typeof g === "string" ? g : `${g.sessionID}:${g.localID}`);
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

export const PROPERTY_TYPE_LABEL: Record<ComponentPropType, string> = { BOOL: "Boolean", TEXT: "Text", INSTANCE_SWAP: "Instance swap", VARIANT: "Variant", NUMBER: "Number", SLOT: "Slot" };

/** Each property type's glyph (the Properties rows, the Create property menu, Reset ▸ a property's value). */
export const PROPERTY_ICON: Record<ComponentPropType, IconName> = {
  // Live (2026-10-22): an outlined diamond, a T in a box, a diamond in corner marks
  VARIANT: "16.instance",
  BOOL: "24.variable.type.boolean",
  TEXT: "24.variable.type.string",
  INSTANCE_SWAP: "24.instance.swap.small",
  NUMBER: "16.number",
  SLOT: "16.slot",
};

/** The binding each property type makes on a layer (docs/schema.md §5.5). */
export const BINDING_OF: Record<Exclude<ComponentPropType, "VARIANT">, { field: BindableField; resolved: string }> = {
  BOOL: { field: "VISIBLE", resolved: "BOOLEAN" },
  TEXT: { field: "TEXT_DATA", resolved: "TEXT_DATA" },
  INSTANCE_SWAP: { field: "OVERRIDDEN_SYMBOL_ID", resolved: "SYMBOL_ID" },
  NUMBER: { field: "TEXT_DATA", resolved: "FLOAT" },
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

/**
 * Figma's base name for a new property of a type (docs/research/rea/components.md §2.20): a boolean bound to one
 * layer takes the layer's name; else Boolean, Text, Instance, Slot, and Property for a variant property. The engine's
 * ADD_COMPONENT_PROPERTY uses the same bases.
 */
export function propertyBaseName(type: ComponentPropType, layerName?: string): string {
  if (type === "BOOL" && layerName?.trim()) return layerName;
  return type === "BOOL" ? "Boolean" : type === "TEXT" ? "Text" : type === "NUMBER" ? "Number" : type === "INSTANCE_SWAP" ? "Instance" : type === "SLOT" ? "Slot" : "Property";
}

/** Figma's default name for a new property: `base` when neither it nor any "base N" is taken, else "base " + (max N, 1) + 1 — Slot, Slot 2, Slot 3. */
export function newPropertyName(defs: readonly ComponentPropDef[], base = "Property"): string {
  let any = false;
  let top = 1;
  const prefix = `${base} `;
  for (const d of defs) {
    const name = d.name ?? "";
    if (name === base) any = true;
    else if (name.startsWith(prefix) && /^\d{1,9}$/.test(name.slice(prefix.length))) {
      any = true;
      top = Math.max(top, Number(name.slice(prefix.length)));
    }
  }
  return any ? `${prefix}${top + 1}` : base;
}

/** A new definition of `type` with Figma's defaults (Boolean true, Text "Text", Number 0, the given component, Variant "Default"). */
export function newPropertyDef(type: ComponentPropType, id: GuidValue, name: string, value?: ComponentPropValue): ComponentPropDef {
  const initialValue: ComponentPropValue =
    value ??
    (type === "BOOL" ? { boolValue: true } : type === "TEXT" ? { textValue: { characters: "Text" } } : type === "NUMBER" ? { floatValue: 0 } : type === "VARIANT" ? { textValue: { characters: "Default" } } : {});
  return { id, name, type, initialValue };
}

/**
 * A NUMBER property's typed value (atlas 10 §5.2, the engine's propNumber): an optional sign and digits with an
 * optional decimal part, or a decimal starting with "." — not blank — rounded to 2 decimals; null for anything else.
 */
export function parsePropertyNumber(text: string): number | null {
  const s = text.trim();
  if (!/^[+-]?(\d+(\.\d*)?|\.\d+)$/.test(s)) return null;
  const x = Number(s);
  return Number.isFinite(x) ? Math.round(x * 100) / 100 : null;
}

/** A NUMBER as Figma shows it: 2 decimals at most, no trailing zeros or "." ("1.50" → "1.5"; NaN → "0"). */
export function formatPropertyNumber(v: number | undefined): string {
  if (v === undefined || !Number.isFinite(v)) return "0";
  const s = (Math.round(v * 100) / 100).toFixed(2).replace(/0+$/, "").replace(/\.$/, "");
  return s === "-0" ? "0" : s;
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
    case "NUMBER":
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

/**
 * Figma's reset kinds (ResetOverridesKind, reset-variable-modes, reset-prop-assignments; round 17 B): the engine's
 * RESET_OVERRIDES {kind}. SLOT_ASSIGNMENT is Reset slot's (the slot's own row), not a "Reset ▸" item.
 */
export type ResetKind =
  | "EXPORTS"
  | "EFFECTS"
  | "LAYER"
  | "VISIBLE"
  | "NAME"
  | "FILL"
  | "STROKE"
  | "TEXT"
  | "TEXT_STYLE"
  | "SIZE"
  | "PROTOTYPE_INTERACTIONS"
  | "OVERLAY"
  | "OVERRIDDEN_SYMBOL"
  | "SLOT_ASSIGNMENT"
  | "VARIABLE_MODES"
  | "PROPERTY_ASSIGNMENTS";

/**
 * "Reset ▸" in Figma's order (its reset-* actions: exports, effects, layer, visibility, name, fill, stroke, text, text
 * style, size, prototype interactions, overlay), then the instance swap, variable modes and property values. Layer is
 * Figma's "others": every field no other kind names (opacity, corners, auto layout, layout guides, …).
 */
const RESET_KINDS: { kind: ResetKind; label: string; fields: string[] }[] = [
  { kind: "EXPORTS", label: "Exports", fields: ["exportSettings"] },
  { kind: "EFFECTS", label: "Effects", fields: ["effects", "styleIdForEffect"] },
  { kind: "LAYER", label: "Layer", fields: [] },
  { kind: "VISIBLE", label: "Visibility", fields: ["visible"] },
  { kind: "NAME", label: "Name", fields: ["name"] },
  { kind: "FILL", label: "Fill", fields: ["fillPaints", "styleIdForFill"] },
  {
    kind: "STROKE",
    label: "Stroke",
    fields: ["strokePaints", "strokeWeight", "strokeAlign", "strokeCap", "strokeJoin", "miterLimit", "dashPattern", "styleIdForStrokeFill", "borderTopWeight", "borderRightWeight", "borderBottomWeight", "borderLeftWeight", "borderStrokeWeightsIndependent"],
  },
  { kind: "TEXT", label: "Text", fields: ["textData"] },
  {
    kind: "TEXT_STYLE",
    label: "Text style",
    fields: ["fontName", "fontSize", "lineHeight", "letterSpacing", "paragraphSpacing", "paragraphIndent", "textCase", "textDecoration", "textAlignHorizontal", "textAlignVertical", "textTruncation", "maxLines", "styleIdForText"],
  },
  { kind: "SIZE", label: "Size", fields: ["size", "stackPrimarySizing", "stackCounterSizing", "minSize", "maxSize", "textAutoResize"] },
  { kind: "PROTOTYPE_INTERACTIONS", label: "Prototype interactions", fields: ["prototypeInteractions"] },
  { kind: "OVERLAY", label: "Overlay", fields: ["overlayPositionType", "overlayRelativePosition", "overlayBackgroundInteraction", "overlayBackgroundAppearance"] },
  { kind: "OVERRIDDEN_SYMBOL", label: "Instance", fields: ["overriddenSymbolID"] },
  { kind: "VARIABLE_MODES", label: "Variable modes", fields: ["variableModeBySetMap"] },
  { kind: "PROPERTY_ASSIGNMENTS", label: "Properties", fields: ["componentPropAssignments"] },
];

/**
 * The kinds Figma's "Reset specific changes" lists (figma_app's fixed order of twelve; atlas 10 §6.2), each only when
 * the instance has it; one "Reset {property}" per changed property value follows them. A nested swap is reset with its
 * instance's Reset, variable modes with their own action ("Reset variable modes").
 */
export const RESET_MENU_KINDS: ReadonlySet<ResetKind> = new Set<ResetKind>(["EXPORTS", "EFFECTS", "LAYER", "VISIBLE", "NAME", "FILL", "STROKE", "TEXT", "TEXT_STYLE", "SIZE", "PROTOTYPE_INTERACTIONS", "OVERLAY"]);

/**
 * Figma's variant errors (StateGroupError, atlas 10 §4.2), worst last: a set past 1000 variants (a warning only), a
 * variant with no value for one of the set's Variant properties, two variants with the same values, a variant name
 * that isn't "Property=Value, …".
 */
export type VariantError = "NONE" | "TOO_MANY_STATES_ERROR" | "MISSING_PROPERTIES_ERROR" | "DUPLICATE_STATE_ERROR" | "PARSE_ERROR";
const VARIANT_ERROR_ORDER: readonly VariantError[] = ["NONE", "TOO_MANY_STATES_ERROR", "MISSING_PROPERTIES_ERROR", "DUPLICATE_STATE_ERROR", "PARSE_ERROR"];

/** The worst of several variants' errors (Figma takes the highest). */
export const worstVariantError = (errors: readonly VariantError[]): VariantError =>
  errors.reduce<VariantError>((worst, e) => (VARIANT_ERROR_ORDER.indexOf(e) > VARIANT_ERROR_ORDER.indexOf(worst) ? e : worst), "NONE");

/**
 * Figma's publish errors for a component or a set's properties (componentPropDefError; round 17 B): a property no
 * layer uses (UNUSED_DEF_ERROR — Variant properties aside), two with one name (CONFLICTING_NAMES_ERROR), and a
 * property named as a Variant property (CONFLICTING_NAMES_WITH_VARIANT_ERROR). Figma doesn't publish such a component.
 */
export type PropertyPublishError = { kind: "UNUSED_DEF_ERROR" | "CONFLICTING_NAMES_ERROR" | "CONFLICTING_NAMES_WITH_VARIANT_ERROR"; property: string };

export function propertyPublishErrors(properties: readonly { name: string; type: ComponentPropType; boundLayers?: readonly unknown[] }[]): PropertyPublishError[] {
  const out: PropertyPublishError[] = [];
  const variants = new Set(properties.filter((p) => p.type === "VARIANT").map((p) => p.name));
  // Variant properties and the others are named apart: a clash between the two is the "with variant" error.
  const keyOf = (p: { name: string; type: ComponentPropType }) => `${p.type === "VARIANT" ? "variant" : "property"}:${p.name}`;
  const seen = new Map<string, number>();
  for (const p of properties) seen.set(keyOf(p), (seen.get(keyOf(p)) ?? 0) + 1);
  const reported = new Set<string>();
  for (const p of properties) {
    const own = keyOf(p);
    if ((seen.get(own) ?? 0) > 1 && !reported.has(own)) {
      reported.add(own);
      out.push({ kind: "CONFLICTING_NAMES_ERROR", property: p.name });
    } else if (p.type !== "VARIANT" && variants.has(p.name) && !reported.has(own)) {
      reported.add(own);
      out.push({ kind: "CONFLICTING_NAMES_WITH_VARIANT_ERROR", property: p.name });
    }
    if (p.type !== "VARIANT" && p.boundLayers && p.boundLayers.length === 0) out.push({ kind: "UNUSED_DEF_ERROR", property: p.name });
  }
  return out;
}

/** One "Reset ▸" item: Figma's kind, its label, and the changed fields it covers. */
export interface ResetGroup {
  kind: ResetKind;
  label: string;
  fields: string[];
}

/** The fields an instance changed: its overrides' fields, and its own property values. */
export function changedFields(instance: CNode): Set<string> {
  const fields = new Set<string>();
  for (const e of instance.symbolData?.symbolOverrides ?? []) for (const k of Object.keys(e)) if (k !== "guidPath" && k !== "guid") fields.add(k);
  if (instance.componentPropAssignments?.length) fields.add("componentPropAssignments");
  return fields;
}

/** The groups of changes an instance has, in menu order. */
export function changedGroups(instance: CNode): ResetGroup[] {
  return groupChanges(changedFields(instance));
}

/** Changed fields as Figma's "Reset ▸" items (one per kind it has), in menu order; Layer takes the fields no kind names. */
export function groupChanges(fields: ReadonlySet<string>): ResetGroup[] {
  const known = new Set(RESET_KINDS.flatMap((k) => k.fields));
  const out: ResetGroup[] = [];
  for (const { kind, label, fields: group } of RESET_KINDS) {
    const hit = kind === "LAYER" ? [...fields].filter((f) => !known.has(f)) : group.filter((f) => fields.has(f));
    if (hit.length) out.push({ kind, label, fields: hit });
  }
  return out;
}

/** The override fields a reset kind covers (Layer: `changed` fields no other kind names). */
export function resetKindFields(kind: ResetKind, changed: ReadonlySet<string> = new Set()): string[] {
  if (kind === "LAYER") {
    const known = new Set(RESET_KINDS.flatMap((k) => k.fields));
    return [...changed].filter((f) => !known.has(f));
  }
  return RESET_KINDS.find((k) => k.kind === kind)?.fields ?? [];
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

/**
 * Figma's tile layouts of a library grid (atlas 10 §8.2): WIDE when every item is at least 3× wider than tall, SMALL
 * when every item fits in 64 × 64 (the Assets panel's component grid passes `small: false`), else NORMAL — an item
 * without a size forces NORMAL.
 */
export type TileLayout = "WIDE" | "SMALL" | "NORMAL";
export function tileLayoutOf(sizes: readonly ({ x: number; y: number } | null | undefined)[], small = true): TileLayout {
  if (!sizes.length || sizes.some((s) => !s || !(s.x > 0) || !(s.y > 0))) return "NORMAL";
  const known = sizes as readonly { x: number; y: number }[];
  if (known.every((s) => s.x >= 3 * s.y)) return "WIDE";
  if (small && known.every((s) => s.x <= 64 && s.y <= 64)) return "SMALL";
  return "NORMAL";
}

/** Each layout's columns, tile aspect (w / h) and its max height, which is its min size too (WIDE: the whole row). */
const TILE_SPECS: Record<TileLayout, { min: number; max: number; aspect: number; size: number | null }> = {
  NORMAL: { min: 2, max: 3, aspect: 1, size: 115 },
  SMALL: { min: 3, max: 5, aspect: 1, size: 72 },
  WIDE: { min: 1, max: 1, aspect: 3.25, size: null },
};
/** The grid's gutters (16 a side) and gap (16). */
const TILE_GUTTER = 16;
const TILE_GAP = 16;

/**
 * Figma's grid math for a sidebar `width` px wide: the room is the width less two gutters; columns =
 * clamp(⌊(room + gap) / (min size + gap)⌋, min, max); a tile ⌊(room − (columns − 1)·gap) / columns⌋ wide and
 * min(max height, ⌊width / aspect⌋) tall. At Figma's 240 px: NORMAL two 96 × 96 tiles, SMALL three 58s, WIDE one 208 × 64;
 * NORMAL reaches three columns at 409 px.
 */
export function tileGrid(layout: TileLayout, width: number): { columns: number; width: number; height: number } {
  const spec = TILE_SPECS[layout];
  const room = Math.max(0, width - 2 * TILE_GUTTER);
  const min = spec.size ?? room;
  const columns = Math.min(spec.max, Math.max(spec.min, Math.floor((room + TILE_GAP) / (min + TILE_GAP))));
  const w = Math.floor((room - (columns - 1) * TILE_GAP) / columns);
  const h = Math.floor(w / spec.aspect);
  return { columns, width: w, height: spec.size === null ? h : Math.min(spec.size, h) };
}

/**
 * Figma's asset search (atlas 10 §8.3; its Assets panel runs Fuse.js 3 with these options): the name weighs 0.6, the
 * frame it sits in and its page 0.1 each, the description 0.05; a fuzzy match within threshold 0.3, word by word
 * (`tokenize`), best first. An empty (or blank) query lists every asset as it was.
 */
const ASSET_SEARCH: Fuse.FuseOptions<ComponentAsset> = {
  keys: [
    { name: "name", weight: 0.6 },
    { name: "containingFrame.name", weight: 0.1 },
    { name: "containingFrame.pageName", weight: 0.1 },
    { name: "description", weight: 0.05 },
  ],
  threshold: 0.3,
  tokenize: true,
  shouldSort: true,
  // Figma's keys name a library asset's fields; ours sit on the asset itself.
  getFn: (a: ComponentAsset, path: string) => (path === "containingFrame.name" ? a.frameName : path === "containingFrame.pageName" ? a.pageName : path === "description" ? a.description : a.name) ?? "",
};

export function searchAssets<T extends ComponentAsset>(assets: readonly T[], query: string): T[] {
  const q = query.trim();
  if (!q) return [...assets];
  return new Fuse<T, Fuse.FuseOptions<T>>(assets, ASSET_SEARCH as Fuse.FuseOptions<T>).search(q) as T[];
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

// ---- Slots (round 6; help "Create and use slots", R4 §15) ---------------------------------------------------------

export type SlotConfig = NonNullable<ComponentPropDef["slotPropConfig"]>;
/** The plugin API's `limitViolations`: BELOW_MIN and ABOVE_MAX exclude each other. */
export type SlotViolation = "BELOW_MIN" | "ABOVE_MAX" | "HAS_NON_PREFERRED";

/** A limit counts when it is set (a stored 0 is "not set", as the API's null). */
export const slotMin = (c: SlotConfig | undefined): number | null => (c?.minChildren && c.minChildren > 0 ? c.minChildren : null);
export const slotMax = (c: SlotConfig | undefined): number | null => (c?.maxChildren && c.maxChildren > 0 ? c.maxChildren : null);

/** Whether the slot has guidelines to show (the "Limits" label). */
export const hasSlotLimits = (c: SlotConfig | undefined, preferredCount: number): boolean =>
  slotMin(c) !== null || slotMax(c) !== null || (c?.allowPreferredValuesOnly === true && preferredCount > 0);

/**
 * What a slot breaks (guidance, never a block): fewer layers than its minimum, more than its maximum, a layer that
 * isn't an instance of a preferred component while only preferred instances are allowed.
 */
export function slotViolations(c: SlotConfig | undefined, children: readonly { preferred: boolean }[], preferredCount: number): SlotViolation[] {
  const out: SlotViolation[] = [];
  const min = slotMin(c);
  const max = slotMax(c);
  if (min !== null && children.length < min) out.push("BELOW_MIN");
  else if (max !== null && children.length > max) out.push("ABOVE_MAX");
  if (c?.allowPreferredValuesOnly && preferredCount > 0 && children.some((k) => !k.preferred)) out.push("HAS_NON_PREFERRED");
  return out;
}

/** The Limits details: each guideline with whether the slot meets it (a green check or an orange warning). */
export function slotGuidelines(c: SlotConfig | undefined, children: readonly { preferred: boolean }[], preferredCount: number): { text: string; ok: boolean }[] {
  const out: { text: string; ok: boolean }[] = [];
  const min = slotMin(c);
  const max = slotMax(c);
  const v = slotViolations(c, children, preferredCount);
  if (min !== null && max !== null) out.push({ text: tp(max, "{min}–{n} layer", "{min}–{n} layers", { min }), ok: !v.includes("BELOW_MIN") && !v.includes("ABOVE_MAX") });
  else if (min !== null) out.push({ text: tp(min, "At least {n} layer", "At least {n} layers"), ok: !v.includes("BELOW_MIN") });
  else if (max !== null) out.push({ text: tp(max, "Up to {n} layer", "Up to {n} layers"), ok: !v.includes("ABOVE_MAX") });
  if (c?.allowPreferredValuesOnly && preferredCount > 0) out.push({ text: t("Preferred instances only"), ok: !v.includes("HAS_NON_PREFERRED") });
  return out;
}

// ---- Variant properties (round 6) ----------------------------------------------------------------------------------

const TOGGLE_PAIRS: [string, string][] = [
  ["true", "false"],
  ["yes", "no"],
  ["on", "off"],
];

/**
 * A two-value variant property shows as a toggle when its values are True / False, Yes / No or On / Off (Figma; any
 * case): the value that means "on" and the one that means "off". Null otherwise.
 */
export function variantToggle(values: readonly string[]): { on: string; off: string } | null {
  if (values.length !== 2) return null;
  const lower = values.map((v) => v.trim().toLowerCase());
  for (const [on, off] of TOGGLE_PAIRS) {
    const i = lower.indexOf(on);
    const j = lower.indexOf(off);
    if (i >= 0 && j >= 0) return { on: values[i], off: values[j] };
  }
  return null;
}

/** A variant property's values with the one at `from` moved to before index `to` (the Values list's drag). */
export function moveValue(values: readonly string[], from: number, to: number): string[] {
  const out = [...values];
  if (from < 0 || from >= out.length) return out;
  const [v] = out.splice(from, 1);
  out.splice(Math.max(0, Math.min(out.length, to > from ? to - 1 : to)), 0, v);
  return out;
}
