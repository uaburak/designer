/**
 * Variables, collections and modes as plain data (no engine, no React):
 * schema/document.kiwi's shapes (VARIABLE_SET / VARIABLE nodes under the
 * internal canvas, `variableDataValues`, `parameterConsumptionMap` ALIAS
 * entries, `Paint.colorVar`, `variableModeBySetMap` — docs/schema.md §6) and
 * Figma's rules for them (docs/research/figma/R3-variables.md): the default
 * mode is the first by sortPosition, groups are slash paths, aliases resolve
 * with the consumer's mode of each collection along the chain and never
 * cycle, scopes decide which pickers list a variable, a node's mode is the
 * nearest explicit one up to the page (else the collection's default).
 */
import type { Color, Guid, NodeChange, Paint } from "@/engine/codec";
import { guidStr, guidVal, type GuidValue } from "./components";

export { guidStr, guidVal, type GuidValue };

// ---- Schema shapes --------------------------------------------------------------------------------------------

/** The four types Design shows (EASING / TIMING come with Motion). */
export type VarType = "COLOR" | "FLOAT" | "STRING" | "BOOLEAN";
export const VAR_TYPES: readonly VarType[] = ["COLOR", "FLOAT", "STRING", "BOOLEAN"];
/** Figma's names for them ("+ Create variable" menu, the Edit variable header). */
export const VAR_TYPE_LABEL: Record<VarType, string> = { COLOR: "Color", FLOAT: "Number", STRING: "String", BOOLEAN: "Boolean" };
/** The 16px glyph of each type (the table's name column, the pickers). */
export const VAR_TYPE_ICON = { COLOR: "16.variable.color", FLOAT: "16.number", STRING: "16.text", BOOLEAN: "16.variable.boolean" } as const;

export interface AliasRef {
  guid: GuidValue;
}

export interface VariableAnyValue {
  boolValue?: boolean;
  textValue?: string;
  floatValue?: number;
  colorValue?: Color;
  alias?: AliasRef;
  [other: string]: unknown;
}

export interface VariableData {
  value?: VariableAnyValue;
  dataType?: string;
  resolvedDataType?: string;
}

export interface VariableSetMode {
  id: GuidValue;
  name: string;
  sortPosition?: string;
  /** An extended collection's mode: the collection it extends and that collection's mode. */
  parentVariableSetId?: AliasRef;
  parentModeId?: GuidValue;
}

export interface CodeSyntaxEntry {
  platform: "WEB" | "ANDROID" | "iOS";
  value: string;
}

/** A VARIABLE_SET or VARIABLE node as the editor reads it (every field optional, as the engine hands them back). */
export interface VNode {
  guid: Guid;
  type?: string;
  name?: string;
  parentIndex?: { guid: Guid; position: string };
  description?: string;
  sortPosition?: string;
  isPublishable?: boolean;
  isSoftDeleted?: boolean;
  // VARIABLE_SET
  variableSetModes?: VariableSetMode[];
  // VARIABLE
  variableSetID?: AliasRef;
  variableResolvedType?: VarType | string;
  variableDataValues?: { entries?: { modeID: GuidValue; variableData: VariableData }[] };
  variableScopes?: string[];
  codeSyntax?: { entries?: CodeSyntaxEntry[] };
  [other: string]: unknown;
}

/** A collection as the panels use it. */
export interface Collection {
  id: Guid;
  name: string;
  /** An extended collection's modes name the parent mode they inherit (`parentMode`). */
  modes: { id: Guid; name: string; sortPosition: string; parentMode?: Guid }[];
  defaultMode: Guid;
  sortPosition: string;
  hidden: boolean;
  node: VNode;
  /** An extended collection (Figma's "Extend collection"): the collection it extends (null: not one). */
  parent: Guid | null;
  /** The extended collection's own values: variable → mode → value (VARIABLE_OVERRIDE nodes; filled by the index). */
  overrides: Map<Guid, Map<Guid, VarValue>>;
  /** The collection it extends, linked by the index (values not overridden come from it). */
  parentCollection?: Collection;
}

/** The root of an extension chain (itself when not an extended collection). */
export function rootOf(c: Collection): Collection {
  let cur = c;
  for (let i = 0; cur.parentCollection && i < 16; i++) cur = cur.parentCollection;
  return cur;
}

/** A variable as the panels use it. */
export interface Variable {
  id: Guid;
  name: string;
  collection: Guid;
  type: VarType;
  /** mode id → its value as stored (absent: the default mode's) */
  values: Map<Guid, VarValue>;
  scopes: string[] | null;
  description: string;
  codeSyntax: CodeSyntaxEntry[];
  hidden: boolean;
  sortPosition: string;
  node: VNode;
}

/** A value in a mode: a literal of the variable's type, or an alias to another variable. */
export type VarValue = { kind: "alias"; id: Guid } | { kind: "literal"; value: Literal };
export type Literal = boolean | number | string | Color;

// ---- Reading ---------------------------------------------------------------------------------------------------

export const isCollectionNode = (n: { type?: string } | null | undefined): boolean => n?.type === "VARIABLE_SET";
export const isVariableNode = (n: { type?: string } | null | undefined): boolean => n?.type === "VARIABLE";

export const byPosition = <T extends { sortPosition: string; name?: string }>(a: T, b: T) =>
  a.sortPosition < b.sortPosition ? -1 : a.sortPosition > b.sortPosition ? 1 : (a.name ?? "").localeCompare(b.name ?? "");

export function readCollection(n: VNode): Collection {
  const modes = (n.variableSetModes ?? [])
    .map((m) => ({ id: guidStr(m.id), name: m.name, sortPosition: m.sortPosition ?? "", ...(m.parentModeId ? { parentMode: guidStr(m.parentModeId) } : {}) }))
    .sort(byPosition);
  const name = n.name ?? "Collection";
  const parentRef = (n.variableSetModes ?? []).find((m) => m.parentVariableSetId?.guid)?.parentVariableSetId;
  return {
    parent: parentRef ? guidStr(parentRef.guid) : null,
    overrides: new Map(),
    id: n.guid,
    name,
    modes,
    defaultMode: modes[0]?.id ?? "",
    sortPosition: n.sortPosition ?? "",
    hidden: n.isPublishable === false || name.startsWith("_") || name.startsWith("."),
    node: n,
  };
}

/** VariableData → a value (null: an expression or anything else Design doesn't edit). */
export function fromData(d: VariableData | undefined): VarValue | null {
  const v = d?.value;
  if (!d || !v) return null;
  if (d.dataType === "ALIAS" && v.alias?.guid) return { kind: "alias", id: guidStr(v.alias.guid) };
  if (v.colorValue) return { kind: "literal", value: v.colorValue };
  if (typeof v.floatValue === "number") return { kind: "literal", value: v.floatValue };
  if (typeof v.textValue === "string") return { kind: "literal", value: v.textValue };
  if (typeof v.boolValue === "boolean") return { kind: "literal", value: v.boolValue };
  // Absent fields are kiwi's defaults: a FLOAT 0, a BOOLEAN false, a STRING "".
  if (d.dataType === "FLOAT") return { kind: "literal", value: 0 };
  if (d.dataType === "BOOLEAN") return { kind: "literal", value: false };
  if (d.dataType === "STRING") return { kind: "literal", value: "" };
  return null;
}

/** A value → VariableData of `type` (an alias's resolvedDataType is the variable's own type: aliases never change type). */
export function toData(type: VarType, value: VarValue): VariableData {
  if (value.kind === "alias") return { dataType: "ALIAS", resolvedDataType: type, value: { alias: { guid: guidVal(value.id) } } };
  const v = value.value;
  switch (type) {
    case "COLOR":
      return { dataType: "COLOR", resolvedDataType: "COLOR", value: { colorValue: v as Color } };
    case "FLOAT":
      return { dataType: "FLOAT", resolvedDataType: "FLOAT", value: { floatValue: Number(v) } };
    case "STRING":
      return { dataType: "STRING", resolvedDataType: "STRING", value: { textValue: String(v) } };
    case "BOOLEAN":
      return { dataType: "BOOLEAN", resolvedDataType: "BOOLEAN", value: { boolValue: v === true } };
  }
}

export function readVariable(n: VNode): Variable {
  const values = new Map<Guid, VarValue>();
  for (const e of n.variableDataValues?.entries ?? []) {
    const v = fromData(e.variableData);
    if (v) values.set(guidStr(e.modeID), v);
  }
  // Absent = BOOLEAN in the kiwi enum (0); some writers leave it out then, so the values' own type decides.
  const declared = n.variableResolvedType ?? n.variableDataValues?.entries?.find((e) => e.variableData?.resolvedDataType)?.variableData?.resolvedDataType;
  const type = (VAR_TYPES as readonly string[]).includes(declared ?? "") ? (declared as VarType) : "FLOAT";
  return {
    id: n.guid,
    name: n.name ?? "",
    collection: guidStr(n.variableSetID?.guid),
    type,
    values,
    scopes: n.variableScopes ?? null,
    description: n.description ?? "",
    codeSyntax: n.codeSyntax?.entries ?? [],
    hidden: n.isPublishable === false,
    sortPosition: n.sortPosition ?? "",
    node: n,
  };
}

/**
 * The variable's value in `mode`: its own entry, else the collection's default mode's, else the type's default. In an
 * extended collection (`c` one, `mode` its mode): its override, else the parent's value for the parent mode.
 */
export function valueIn(v: Variable, mode: Guid, c: Collection | undefined): VarValue {
  for (let i = 0; c?.parent && c.parentCollection && i < 16; i++) {
    const own = c.overrides.get(v.id)?.get(mode);
    if (own) return own;
    const m = c.modes.find((x) => x.id === mode);
    mode = m?.parentMode ?? c.parentCollection.defaultMode;
    c = c.parentCollection;
  }
  return v.values.get(mode) ?? (c ? v.values.get(c.defaultMode) : undefined) ?? v.values.values().next().value ?? { kind: "literal", value: defaultLiteral(v.type) };
}

export function defaultLiteral(type: VarType): Literal {
  switch (type) {
    case "COLOR":
      return { r: 1, g: 1, b: 1, a: 1 };
    case "FLOAT":
      return 0;
    case "STRING":
      return "";
    case "BOOLEAN":
      return false;
  }
}

/** The `variableDataValues` entries with `mode` set to `value` (others kept). */
export function withValue(v: Variable, mode: Guid, value: VarValue): { entries: { modeID: GuidValue; variableData: VariableData }[] } {
  const entries = (v.node.variableDataValues?.entries ?? []).filter((e) => guidStr(e.modeID) !== mode);
  entries.push({ modeID: guidVal(mode), variableData: toData(v.type, value) });
  return { entries };
}

// ---- Resolution -------------------------------------------------------------------------------------------------

export interface VariableLookup {
  variable(id: Guid): Variable | undefined;
  collection(id: Guid): Collection | undefined;
}

/** Figma's limit on alias chains (docs/schema.md §6.4). */
export const MAX_ALIAS_DEPTH = 16;

/**
 * The literal a variable resolves to for a consumer whose mode of collection C is `modeFor(C)` (absent: C's
 * default). Every alias in the chain is read in the consumer's mode of its own collection (Figma's
 * `resolveForConsumer`); a cycle, a missing target or a chain past 16 is unresolved (null).
 */
export function resolveVariable(id: Guid, lookup: VariableLookup, modeFor: (collection: Guid) => Guid | undefined = () => undefined): Literal | null {
  const seen = new Set<Guid>();
  let current: Guid | null = id;
  for (let depth = 0; current && depth <= MAX_ALIAS_DEPTH; depth++) {
    if (seen.has(current)) return null;
    seen.add(current);
    const v = lookup.variable(current);
    if (!v) return null;
    const c = lookup.collection(v.collection);
    const value = valueIn(v, modeFor(v.collection) ?? c?.defaultMode ?? "", c);
    if (value.kind === "literal") return value.value;
    current = value.id;
  }
  return null;
}

/** Would `from` aliasing `to` make a cycle (or alias itself)? Checked through every mode of every variable on the way. */
export function aliasMakesCycle(from: Guid, to: Guid, lookup: VariableLookup): boolean {
  const stack = [to];
  const seen = new Set<Guid>();
  while (stack.length) {
    const id = stack.pop()!;
    if (id === from) return true;
    if (seen.has(id)) continue;
    seen.add(id);
    const v = lookup.variable(id);
    if (!v) continue;
    for (const value of v.values.values()) if (value.kind === "alias") stack.push(value.id);
  }
  return false;
}

/** A lookup over plain lists. */
export function lookupOf(collections: readonly Collection[], variables: readonly Variable[]): VariableLookup {
  const c = new Map(collections.map((x) => [x.id, x]));
  const v = new Map(variables.map((x) => [x.id, x]));
  return { variable: (id) => v.get(id), collection: (id) => c.get(id) };
}

// ---- Modes on nodes ---------------------------------------------------------------------------------------------

export interface ModeEntry {
  variableSetID: AliasRef;
  variableModeID: GuidValue;
  /** An extended collection's mode: that collection (`variableSetID` is its root). */
  variableSetExtensionID?: AliasRef;
}

/** A node's explicit modes: collection (an extended one by its own id) → mode (no entry = Auto). */
export function explicitModes(n: { variableModeBySetMap?: { entries?: ModeEntry[] } } | null | undefined): Map<Guid, Guid> {
  const out = new Map<Guid, Guid>();
  for (const e of n?.variableModeBySetMap?.entries ?? []) out.set(guidStr(e.variableSetExtensionID?.guid ?? e.variableSetID?.guid), guidStr(e.variableModeID));
  return out;
}

/** `variableModeBySetMap` with collection `c` set to `mode` (null: back to Auto). */
export function withExplicitMode(n: { variableModeBySetMap?: { entries?: ModeEntry[] } } | null | undefined, c: Guid, mode: Guid | null): { entries: ModeEntry[] } {
  const entries = (n?.variableModeBySetMap?.entries ?? []).filter((e) => guidStr(e.variableSetID?.guid) !== c);
  if (mode) entries.push({ variableSetID: { guid: guidVal(c) }, variableModeID: guidVal(mode) });
  return { entries };
}

/** The mode of collection `c` for a node whose ancestors-or-self (innermost first, the page last) are `chain`. */
export function modeAt(chain: readonly { variableModeBySetMap?: { entries?: ModeEntry[] } }[], c: Collection): Guid {
  for (const n of chain) {
    const m = explicitModes(n).get(c.id);
    if (m && c.modes.some((x) => x.id === m)) return m;
  }
  return c.defaultMode;
}

/** Collections whose mode can be chosen ("Apply variable mode" lists those with more than one mode). */
export const modeCollections = (collections: readonly Collection[]) => collections.filter((c) => c.modes.length > 1);

// ---- Names, groups, positions -----------------------------------------------------------------------------------

/** A name's slash path cleaned up as Figma does ("color / bg" → "color/bg"; empty segments dropped). */
export const cleanName = (name: string) =>
  name
    .split("/")
    .map((s) => s.trim())
    .filter(Boolean)
    .join("/");

/** "color/bg/primary" → { group: "color/bg", leaf: "primary" }. */
export function splitName(name: string): { group: string; leaf: string } {
  const i = name.lastIndexOf("/");
  return i < 0 ? { group: "", leaf: name } : { group: name.slice(0, i), leaf: name.slice(i + 1) };
}

/** Is `name` in group `group` (or below it)? "" is every variable ("All variables"). */
export const inGroup = (name: string, group: string) => !group || name.startsWith(group + "/");

export interface GroupNode {
  path: string;
  name: string;
  count: number;
  children: GroupNode[];
}

/** The group tree of some names (the Variables sidebar under "All variables", the Styles folders). */
export function groupTree(names: readonly string[]): GroupNode[] {
  const root: GroupNode = { path: "", name: "", count: 0, children: [] };
  for (const name of names) {
    const parts = name.split("/");
    parts.pop();
    let at = root;
    let path = "";
    for (const p of parts) {
      path = path ? `${path}/${p}` : p;
      let child = at.children.find((c) => c.name === p);
      if (!child) at.children.push((child = { path, name: p, count: 0, children: [] }));
      child.count++;
      at = child;
    }
  }
  return root.children;
}

/** The new name of a variable in a renamed group ("color/bg/x", "color" → "brand" = "brand/bg/x"); null when not in it. */
export function renameGroupIn(name: string, from: string, to: string): string | null {
  if (!inGroup(name, from) || !from) return null;
  return cleanName(`${to}/${name.slice(from.length + 1)}`);
}

/** "Color", "Color 2", … — the first free name of a new variable (or mode, collection) among `taken`. */
export function nextName(base: string, taken: Iterable<string>): string {
  const used = new Set(taken);
  if (!used.has(base)) return base;
  for (let i = 2; ; i++) if (!used.has(`${base} ${i}`)) return `${base} ${i}`;
}

/** "Mode 1", "Mode 2", … */
export function nextModeName(c: Pick<Collection, "modes">): string {
  const used = new Set(c.modes.map((m) => m.name));
  for (let i = c.modes.length + 1; ; i++) if (!used.has(`Mode ${i}`)) return `Mode ${i}`;
}

/** Limits Figma's UI enforces (R3-07): 5,000 variables per collection, 40 modes, mode names ≤ 40 characters. */
export const LIMITS = { variables: 5000, modes: 40, modeName: 40 } as const;

/** Names can't contain "." "{" "}" (R3-07); they're cleaned of empty slash segments. */
export function validVariableName(name: string): string | null {
  const clean = cleanName(name);
  if (!clean || /[.{}]/.test(clean)) return null;
  return clean;
}

const LOW = 33;
const HIGH = 126;
const BASE = HIGH - LOW + 1;

/**
 * A fractional position strictly between `a` and `b` (docs/schema.md §3.5: printable ASCII strings compared
 * byte-wise; "" is the start, null the end).
 */
export function positionBetween(a: string, b: string | null): string {
  const len = Math.max(a.length, b?.length ?? 0) + 1;
  const digits = (s: string) => Array.from({ length: len }, (_, i) => (i < s.length ? s.charCodeAt(i) - LOW : 0));
  const da = digits(a);
  const db = b === null ? null : digits(b);
  // sum = a + b (b = 1.0 at the end), then halve
  const sum = new Array<number>(len).fill(0);
  let carry = 0;
  for (let i = len - 1; i >= 0; i--) {
    const s = da[i] + (db ? db[i] : 0) + carry;
    sum[i] = s % BASE;
    carry = Math.floor(s / BASE);
  }
  if (!db) carry += 1;
  const out: number[] = [];
  let rem = carry;
  for (let i = 0; i < len; i++) {
    const cur = rem * BASE + sum[i];
    out.push(Math.floor(cur / 2));
    rem = cur % 2;
  }
  if (rem) out.push(Math.floor(BASE / 2));
  while (out.length > 1 && out[out.length - 1] === 0) out.pop();
  return String.fromCharCode(...out.map((d) => d + LOW));
}

/** A position after every one of `positions`. */
export const positionAfter = (positions: Iterable<string>) => {
  let last = "";
  for (const p of positions) if (p > last) last = p;
  return positionBetween(last, null);
};

// ---- Scopes ----------------------------------------------------------------------------------------------------

export interface ScopeOption {
  scope: string;
  label: string;
  /** Fill's sub-scopes (Frame / Shape / Text) */
  children?: ScopeOption[];
}

/** The Edit variable modal's scoping checkboxes per type (R3-16, R3-17), Figma's labels. Booleans have none. */
export const SCOPE_OPTIONS: Record<VarType, ScopeOption[]> = {
  COLOR: [
    {
      scope: "ALL_FILLS",
      label: "Fill",
      children: [
        { scope: "FRAME_FILL", label: "Frame" },
        { scope: "SHAPE_FILL", label: "Shape" },
        { scope: "TEXT_FILL", label: "Text" },
      ],
    },
    { scope: "STROKE", label: "Stroke" },
    { scope: "EFFECT_COLOR", label: "Effects" },
  ],
  FLOAT: [
    { scope: "CORNER_RADIUS", label: "Corner radius" },
    { scope: "WIDTH_HEIGHT", label: "Width and height" },
    { scope: "GAP", label: "Gap" },
    { scope: "STROKE_FLOAT", label: "Stroke" },
    { scope: "OPACITY", label: "Layer opacity" },
    { scope: "EFFECT_FLOAT", label: "Effects" },
    { scope: "FONT_STYLE", label: "Font weight" },
    { scope: "FONT_SIZE", label: "Font size" },
    { scope: "LINE_HEIGHT", label: "Line height" },
    { scope: "LETTER_SPACING", label: "Letter spacing" },
    { scope: "PARAGRAPH_SPACING", label: "Paragraph spacing" },
    { scope: "PARAGRAPH_INDENT", label: "Paragraph indent" },
  ],
  STRING: [
    { scope: "TEXT_CONTENT", label: "Text content" },
    { scope: "FONT_FAMILY", label: "Font family" },
    { scope: "FONT_STYLE", label: "Font style" },
  ],
  BOOLEAN: [],
};

/** Every scope a type's checkboxes can set (flattened). */
export const scopesOfType = (type: VarType): string[] => SCOPE_OPTIONS[type].flatMap((o) => [o.scope, ...(o.children ?? []).map((c) => c.scope)]);

/** Does a variable with `scopes` show in a picker for `need`? (absent = all; ALL_FILLS covers the three fills). */
export function scopeAllows(scopes: readonly string[] | null, need: string | null): boolean {
  if (!need || scopes === null) return true;
  if (scopes.includes("ALL_SCOPES") || scopes.includes(need)) return true;
  return scopes.includes("ALL_FILLS") && (need === "FRAME_FILL" || need === "SHAPE_FILL" || need === "TEXT_FILL");
}

/** A checkbox flipped: the new scope list ("Show in all supported properties" = ALL_SCOPES; all ticked collapses to it). */
export function toggleScope(type: VarType, scopes: readonly string[] | null, scope: string, on: boolean): string[] {
  if (scope === "ALL_SCOPES") return on ? ["ALL_SCOPES"] : [];
  const all = SCOPE_OPTIONS[type];
  // From "all": every top-level option ticked, then this one changed.
  let set = new Set(scopes === null || scopes.includes("ALL_SCOPES") ? all.map((o) => o.scope) : scopes);
  const parent = all.find((o) => o.children?.some((c) => c.scope === scope));
  const option = all.find((o) => o.scope === scope);
  if (option?.children) {
    for (const c of option.children) set.delete(c.scope);
    if (on) set.add(scope);
    else set.delete(scope);
  } else if (parent) {
    // A fill sub-scope: "Fill" (ALL_FILLS) splits into its children.
    if (set.has(parent.scope)) {
      set.delete(parent.scope);
      for (const c of parent.children!) set.add(c.scope);
    }
    if (on) set.add(scope);
    else set.delete(scope);
    if (parent.children!.every((c) => set.has(c.scope))) {
      for (const c of parent.children!) set.delete(c.scope);
      set.add(parent.scope);
    }
  } else if (on) set.add(scope);
  else set.delete(scope);
  if (all.every((o) => set.has(o.scope))) set = new Set(["ALL_SCOPES"]);
  return all.flatMap((o) => [o.scope, ...(o.children ?? []).map((c) => c.scope)]).filter((s) => set.has(s)).concat(set.has("ALL_SCOPES") ? ["ALL_SCOPES"] : []);
}

/** Is `scope` ticked (directly, through "Fill", or through "all")? */
export function scopeChecked(scopes: readonly string[] | null, scope: string): boolean {
  if (scopes === null || scopes.includes("ALL_SCOPES")) return true;
  if (scopes.includes(scope)) return true;
  return scopes.includes("ALL_FILLS") && (scope === "FRAME_FILL" || scope === "SHAPE_FILL" || scope === "TEXT_FILL");
}

/** Code syntax platforms, in Figma's order. */
export const CODE_PLATFORMS: { platform: CodeSyntaxEntry["platform"]; label: string }[] = [
  { platform: "WEB", label: "Web" },
  { platform: "ANDROID", label: "Android" },
  { platform: "iOS", label: "iOS" },
];

// ---- Binding node fields ----------------------------------------------------------------------------------------

/** The VariableFields the Design panel binds (schema `@bind` tags) with their type, scope and node fields. */
export type BindField =
  | "CORNER_RADIUS"
  | "RECTANGLE_TOP_LEFT_CORNER_RADIUS"
  | "RECTANGLE_TOP_RIGHT_CORNER_RADIUS"
  | "RECTANGLE_BOTTOM_LEFT_CORNER_RADIUS"
  | "RECTANGLE_BOTTOM_RIGHT_CORNER_RADIUS"
  | "OPACITY"
  | "WIDTH"
  | "HEIGHT"
  | "MIN_WIDTH"
  | "MAX_WIDTH"
  | "MIN_HEIGHT"
  | "MAX_HEIGHT"
  | "STACK_SPACING"
  | "STACK_COUNTER_SPACING"
  | "STACK_PADDING_LEFT"
  | "STACK_PADDING_TOP"
  | "STACK_PADDING_RIGHT"
  | "STACK_PADDING_BOTTOM"
  | "STROKE_WEIGHT"
  | "BORDER_TOP_WEIGHT"
  | "BORDER_BOTTOM_WEIGHT"
  | "BORDER_LEFT_WEIGHT"
  | "BORDER_RIGHT_WEIGHT"
  | "VISIBLE"
  | "TEXT_DATA"
  | "FONT_FAMILY"
  | "FONT_STYLE"
  | "FONT_SIZE"
  | "LINE_HEIGHT"
  | "LETTER_SPACING"
  | "PARAGRAPH_SPACING"
  | "PARAGRAPH_INDENT";

export const BIND_TYPE: Record<BindField, { type: VarType; scope: string | null; label: string }> = {
  CORNER_RADIUS: { type: "FLOAT", scope: "CORNER_RADIUS", label: "Corner radius" },
  RECTANGLE_TOP_LEFT_CORNER_RADIUS: { type: "FLOAT", scope: "CORNER_RADIUS", label: "Top left corner radius" },
  RECTANGLE_TOP_RIGHT_CORNER_RADIUS: { type: "FLOAT", scope: "CORNER_RADIUS", label: "Top right corner radius" },
  RECTANGLE_BOTTOM_LEFT_CORNER_RADIUS: { type: "FLOAT", scope: "CORNER_RADIUS", label: "Bottom left corner radius" },
  RECTANGLE_BOTTOM_RIGHT_CORNER_RADIUS: { type: "FLOAT", scope: "CORNER_RADIUS", label: "Bottom right corner radius" },
  OPACITY: { type: "FLOAT", scope: "OPACITY", label: "Opacity" },
  WIDTH: { type: "FLOAT", scope: "WIDTH_HEIGHT", label: "Width" },
  HEIGHT: { type: "FLOAT", scope: "WIDTH_HEIGHT", label: "Height" },
  MIN_WIDTH: { type: "FLOAT", scope: "WIDTH_HEIGHT", label: "Min width" },
  MAX_WIDTH: { type: "FLOAT", scope: "WIDTH_HEIGHT", label: "Max width" },
  MIN_HEIGHT: { type: "FLOAT", scope: "WIDTH_HEIGHT", label: "Min height" },
  MAX_HEIGHT: { type: "FLOAT", scope: "WIDTH_HEIGHT", label: "Max height" },
  STACK_SPACING: { type: "FLOAT", scope: "GAP", label: "Gap between items" },
  STACK_COUNTER_SPACING: { type: "FLOAT", scope: "GAP", label: "Gap between rows" },
  STACK_PADDING_LEFT: { type: "FLOAT", scope: "GAP", label: "Left padding" },
  STACK_PADDING_TOP: { type: "FLOAT", scope: "GAP", label: "Top padding" },
  STACK_PADDING_RIGHT: { type: "FLOAT", scope: "GAP", label: "Right padding" },
  STACK_PADDING_BOTTOM: { type: "FLOAT", scope: "GAP", label: "Bottom padding" },
  STROKE_WEIGHT: { type: "FLOAT", scope: "STROKE_FLOAT", label: "Stroke weight" },
  BORDER_TOP_WEIGHT: { type: "FLOAT", scope: "STROKE_FLOAT", label: "Top stroke weight" },
  BORDER_BOTTOM_WEIGHT: { type: "FLOAT", scope: "STROKE_FLOAT", label: "Bottom stroke weight" },
  BORDER_LEFT_WEIGHT: { type: "FLOAT", scope: "STROKE_FLOAT", label: "Left stroke weight" },
  BORDER_RIGHT_WEIGHT: { type: "FLOAT", scope: "STROKE_FLOAT", label: "Right stroke weight" },
  VISIBLE: { type: "BOOLEAN", scope: null, label: "Visibility" },
  TEXT_DATA: { type: "STRING", scope: "TEXT_CONTENT", label: "Text content" },
  FONT_FAMILY: { type: "STRING", scope: "FONT_FAMILY", label: "Font family" },
  FONT_STYLE: { type: "STRING", scope: "FONT_STYLE", label: "Font style" },
  FONT_SIZE: { type: "FLOAT", scope: "FONT_SIZE", label: "Font size" },
  LINE_HEIGHT: { type: "FLOAT", scope: "LINE_HEIGHT", label: "Line height" },
  LETTER_SPACING: { type: "FLOAT", scope: "LETTER_SPACING", label: "Letter spacing" },
  PARAGRAPH_SPACING: { type: "FLOAT", scope: "PARAGRAPH_SPACING", label: "Paragraph spacing" },
  PARAGRAPH_INDENT: { type: "FLOAT", scope: "PARAGRAPH_INDENT", label: "Paragraph indent" },
};

export interface ParameterEntryData {
  variableField: string;
  variableData: VariableData & { value?: VariableAnyValue & { propRefValue?: unknown } };
}

type BindableNode = Partial<NodeChange> & {
  parameterConsumptionMap?: { entries?: ParameterEntryData[] | readonly unknown[] };
  fontName?: { family: string; style: string; postscript?: string };
  textData?: { characters: string; [k: string]: unknown };
  [k: string]: unknown;
};

/** The node's variable bindings: field → variable id (PROP_REF entries are component properties, not listed). */
export function variableBindings(n: BindableNode | null | undefined): Map<string, Guid> {
  const out = new Map<string, Guid>();
  for (const raw of n?.parameterConsumptionMap?.entries ?? []) {
    const e = raw as ParameterEntryData;
    const g = e.variableData?.value?.alias?.guid;
    if (e.variableData?.dataType === "ALIAS" && g) out.set(e.variableField, guidStr(g));
  }
  return out;
}

/** The node's `parameterConsumptionMap` with `field` bound to `variable` (null: unbound), other entries kept. */
export function withVariableBinding(n: BindableNode | null | undefined, field: string, variable: { id: Guid; type: VarType } | null): { entries: ParameterEntryData[] } {
  const entries = ((n?.parameterConsumptionMap?.entries ?? []) as ParameterEntryData[]).filter((e) => e.variableField !== field);
  if (variable) entries.push({ variableField: field, variableData: { dataType: "ALIAS", resolvedDataType: variable.type, value: { alias: { guid: guidVal(variable.id) } } } });
  return { entries };
}

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));

/**
 * The node fields a bound field's value writes (the resolved copy, docs/schema.md §3.5): opacity takes a percent
 * (clamped 0…100, R3-49), line height and letter spacing pixels, sizes keep the other axis.
 */
export function resolvedFields(field: string, value: Literal, n: BindableNode): Record<string, unknown> | null {
  const num = typeof value === "number" ? value : Number.NaN;
  const str = typeof value === "string" ? value : null;
  const size = (n.size as { x: number; y: number } | undefined) ?? { x: 0, y: 0 };
  const limit = (k: "minSize" | "maxSize") => ((n[k] as { value?: { x: number; y: number } } | undefined)?.value ?? { x: 0, y: 0 });
  switch (field) {
    case "CORNER_RADIUS":
      return Number.isFinite(num)
        ? { cornerRadius: Math.max(0, num), rectangleCornerRadiiIndependent: false, rectangleTopLeftCornerRadius: Math.max(0, num), rectangleTopRightCornerRadius: Math.max(0, num), rectangleBottomLeftCornerRadius: Math.max(0, num), rectangleBottomRightCornerRadius: Math.max(0, num) }
        : null;
    case "RECTANGLE_TOP_LEFT_CORNER_RADIUS":
    case "RECTANGLE_TOP_RIGHT_CORNER_RADIUS":
    case "RECTANGLE_BOTTOM_LEFT_CORNER_RADIUS":
    case "RECTANGLE_BOTTOM_RIGHT_CORNER_RADIUS": {
      if (!Number.isFinite(num)) return null;
      const key = `rectangle${field
        .replace("RECTANGLE_", "")
        .replace("_CORNER_RADIUS", "")
        .split("_")
        .map((w) => w[0] + w.slice(1).toLowerCase())
        .join("")}CornerRadius`;
      return { [key]: Math.max(0, num), rectangleCornerRadiiIndependent: true };
    }
    case "OPACITY":
      return Number.isFinite(num) ? { opacity: clamp(num, 0, 100) / 100 } : null;
    case "WIDTH":
      return Number.isFinite(num) ? { size: { x: Math.max(0.01, num), y: size.y } } : null;
    case "HEIGHT":
      return Number.isFinite(num) ? { size: { x: size.x, y: Math.max(0.01, num) } } : null;
    case "MIN_WIDTH":
      return Number.isFinite(num) ? { minSize: { value: { x: Math.max(0, num), y: limit("minSize").y } } } : null;
    case "MIN_HEIGHT":
      return Number.isFinite(num) ? { minSize: { value: { x: limit("minSize").x, y: Math.max(0, num) } } } : null;
    case "MAX_WIDTH":
      return Number.isFinite(num) ? { maxSize: { value: { x: Math.max(0, num), y: limit("maxSize").y } } } : null;
    case "MAX_HEIGHT":
      return Number.isFinite(num) ? { maxSize: { value: { x: limit("maxSize").x, y: Math.max(0, num) } } } : null;
    case "STACK_SPACING":
      return Number.isFinite(num) ? { stackSpacing: num } : null;
    case "STACK_COUNTER_SPACING":
      return Number.isFinite(num) ? { stackCounterSpacing: num } : null;
    case "STACK_PADDING_LEFT":
      return Number.isFinite(num) ? { stackHorizontalPadding: Math.max(0, num) } : null;
    case "STACK_PADDING_TOP":
      return Number.isFinite(num) ? { stackVerticalPadding: Math.max(0, num) } : null;
    case "STACK_PADDING_RIGHT":
      return Number.isFinite(num) ? { stackPaddingRight: Math.max(0, num) } : null;
    case "STACK_PADDING_BOTTOM":
      return Number.isFinite(num) ? { stackPaddingBottom: Math.max(0, num) } : null;
    case "STROKE_WEIGHT":
      return Number.isFinite(num) ? { strokeWeight: Math.max(0, num) } : null;
    case "BORDER_TOP_WEIGHT":
      return Number.isFinite(num) ? { borderTopWeight: Math.max(0, num) } : null;
    case "BORDER_BOTTOM_WEIGHT":
      return Number.isFinite(num) ? { borderBottomWeight: Math.max(0, num) } : null;
    case "BORDER_LEFT_WEIGHT":
      return Number.isFinite(num) ? { borderLeftWeight: Math.max(0, num) } : null;
    case "BORDER_RIGHT_WEIGHT":
      return Number.isFinite(num) ? { borderRightWeight: Math.max(0, num) } : null;
    case "VISIBLE":
      return typeof value === "boolean" ? { visible: value } : null;
    case "TEXT_DATA":
      return str !== null ? { textData: { characters: str } } : null;
    case "FONT_FAMILY":
      return str ? { fontName: { family: str, style: n.fontName?.style ?? "Regular", postscript: "" } } : null;
    case "FONT_STYLE":
      return str ? { fontName: { family: n.fontName?.family ?? "Inter", style: str, postscript: "" } } : null;
    case "FONT_SIZE":
      return Number.isFinite(num) ? { fontSize: Math.max(1, num) } : null;
    case "LINE_HEIGHT":
      return Number.isFinite(num) ? { lineHeight: { value: num, units: "PIXELS" } } : null;
    case "LETTER_SPACING":
      return Number.isFinite(num) ? { letterSpacing: { value: num, units: "PIXELS" } } : null;
    case "PARAGRAPH_SPACING":
      return Number.isFinite(num) ? { paragraphSpacing: num } : null;
    case "PARAGRAPH_INDENT":
      return Number.isFinite(num) ? { paragraphIndent: num } : null;
    default:
      return null;
  }
}

// ---- Binding paints and effects -----------------------------------------------------------------------------

/** The variable a paint's colour is bound to (an alias `colorVar`), or null. */
export function paintVariable(p: Paint | null | undefined): Guid | null {
  const d = (p as { colorVar?: VariableData } | null | undefined)?.colorVar;
  const g = d?.dataType === "ALIAS" ? d.value?.alias?.guid : undefined;
  return g ? guidStr(g) : null;
}

/** A solid paint bound to a colour variable, its colour the resolved one (a colour variable's alpha is the colour's). */
export function boundPaint(p: Paint, variable: Guid, color: Color | null): Paint {
  return {
    ...p,
    type: "SOLID",
    ...(color ? { color: { ...color, a: color.a ?? 1 } } : {}),
    colorVar: { dataType: "ALIAS", resolvedDataType: "COLOR", value: { alias: { guid: guidVal(variable) } } },
  };
}

/** The paint detached from its variable: the colour it shows stays. */
export function detachedPaint(p: Paint): Paint {
  const { colorVar: _colorVar, ...rest } = p as Paint & { colorVar?: unknown };
  void _colorVar;
  return rest as Paint;
}

/** An effect's colour variable (`Effect.colorVar`). */
export const effectVariable = (e: { colorVar?: VariableData } | null | undefined): Guid | null => {
  const g = e?.colorVar?.dataType === "ALIAS" ? e.colorVar.value?.alias?.guid : undefined;
  return g ? guidStr(g) : null;
};

// ---- Display -------------------------------------------------------------------------------------------------------

const hex2 = (n: number) =>
  Math.round(clamp(n, 0, 1) * 255)
    .toString(16)
    .padStart(2, "0")
    .toUpperCase();

/** "0D99FF" (and "0D99FF 50%" with alpha), "16", "Hello", "true". */
export function formatLiteral(type: VarType, value: Literal | null): string {
  if (value === null) return "";
  switch (type) {
    case "COLOR": {
      const c = value as Color;
      const a = Math.round((c.a ?? 1) * 100);
      return `${hex2(c.r)}${hex2(c.g)}${hex2(c.b)}${a < 100 ? ` ${a}%` : ""}`;
    }
    case "FLOAT":
      return String(Math.round(Number(value) * 100) / 100);
    case "STRING":
      return String(value);
    case "BOOLEAN":
      return value === true ? "true" : "false";
  }
}

/** Search by name, group path or value (the Variables view and the pickers). */
export function matchesQuery(v: Variable, query: string, shown?: string): boolean {
  const q = query.trim().toLowerCase();
  if (!q) return true;
  return v.name.toLowerCase().includes(q) || (shown ?? "").toLowerCase().includes(q);
}
