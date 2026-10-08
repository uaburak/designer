/**
 * Figma's native import and export of variable modes as Design Tokens (DTCG) JSON (help "Modes for variables";
 * docs/research/figma/R3-variables.md "Round 6") — plain data, no engine.
 *
 * Export ("Export mode", "Export modes"): one `<Mode name>.tokens.json` per mode, 2-space JSON. Groups are nested
 * objects split on "/", in the variables' order; each token is `{$type, $value, $description?, $extensions}`; the
 * root's last key is `$extensions: {"com.figma.modeName": <mode>}`. COLOR → "color" with the DTCG 2025 colour object
 * `{colorSpace: "srgb", components: [r, g, b], alpha, hex}`; FLOAT → "number"; STRING → "string" (+ `com.figma.type:
 * "string"`); BOOLEAN → "number" 1 / 0 (+ `com.figma.type: "boolean"`). An alias in the same collection is
 * `"{group.sub.name}"`; one to another collection is the resolved value + `com.figma.aliasData`.
 *
 * Import ("Import mode", files dropped on the view): `color` (sRGB, HSL, a hex string), `dimension` in px, `duration`
 * in s, `fontFamily` (one name), `number` (Boolean with `com.figma.type: "boolean"`), `string`, `boolean`; aliases
 * `"{a.b}"`; `com.figma.aliasData` (by variable id, else by collection and variable names). Nested groups are
 * slash names; two tokens with one name: the first wins.
 */
import type { Color, Guid } from "@/engine/codec";
import { valueIn, type Collection, type Literal, type VarType, type VarValue, type Variable, type VariableLookup } from "./variables";

type Json = null | boolean | number | string | Json[] | { [key: string]: Json };
type JsonObject = { [key: string]: Json };

/** Figma's file name for an exported mode. */
export const modeFileName = (modeName: string): string => `${modeName.replace(/[\\/:*?"<>|]/g, "_")}.tokens.json`;

/** "VariableID:1:2" / "VariableCollectionId:1:2" — Figma's ids as its exports write them. */
export const figmaVariableId = (id: Guid): string => `VariableID:${id}`;
export const figmaCollectionId = (id: Guid): string => `VariableCollectionId:${id}`;

const hex2 = (v: number) =>
  Math.round(Math.max(0, Math.min(1, v)) * 255)
    .toString(16)
    .padStart(2, "0")
    .toUpperCase();

/** A colour as DTCG 2025's sRGB object (Figma writes the hex without alpha, alpha apart). */
export function dtcgColor(c: Color): JsonObject {
  return { colorSpace: "srgb", components: [c.r, c.g, c.b], alpha: c.a ?? 1, hex: `#${hex2(c.r)}${hex2(c.g)}${hex2(c.b)}` };
}

const dtcgType = (t: VarType): string => (t === "COLOR" ? "color" : t === "STRING" ? "string" : "number");

function literalJson(type: VarType, value: Literal): Json {
  if (type === "COLOR") return dtcgColor(value as Color);
  if (type === "BOOLEAN") return value === true ? 1 : 0;
  if (type === "FLOAT") return typeof value === "number" ? value : Number(value) || 0;
  return String(value);
}

/** A slash name as a token reference: "color/accent/light" → "{color.accent.light}". */
export const aliasRef = (name: string): string => `{${name.split("/").join(".")}}`;

/**
 * One mode of a collection as Figma's DTCG file. `resolve(variable, mode)` gives an alias's value (another
 * collection's variable, written with its resolved value and aliasData).
 */
export function exportMode(collection: Collection, variables: readonly Variable[], mode: Guid, lookup: VariableLookup, resolve: (v: Variable, mode: Guid) => Literal | null): string {
  const modeName = collection.modes.find((m) => m.id === mode)?.name ?? "Mode 1";
  const root: JsonObject = {};
  const owner = collection.parentCollection ? rootCollection(collection).id : collection.id;
  for (const v of variables) {
    const value = valueIn(v, mode, collection);
    const ext: JsonObject = { "com.figma.variableId": figmaVariableId(v.id), "com.figma.scopes": v.scopes ?? ["ALL_SCOPES"] };
    if (v.codeSyntax.length) ext["com.figma.codeSyntax"] = Object.fromEntries(v.codeSyntax.map((c) => [c.platform, c.value]));
    let $value: Json;
    if (value.kind === "alias") {
      const target = lookup.variable(value.id);
      const tc = target ? lookup.collection(target.collection) : undefined;
      if (target && target.collection === owner) {
        $value = aliasRef(target.name);
      } else {
        const lit = resolve(v, mode);
        $value = lit === null ? null : literalJson(v.type, lit);
        ext["com.figma.aliasData"] = {
          targetVariableId: figmaVariableId(value.id),
          targetVariableName: target?.name ?? "",
          targetVariableSetId: target ? figmaCollectionId(target.collection) : "",
          targetVariableSetName: tc?.name ?? "",
        };
      }
    } else {
      $value = literalJson(v.type, value.value);
    }
    if (v.type === "STRING") ext["com.figma.type"] = "string";
    if (v.type === "BOOLEAN") ext["com.figma.type"] = "boolean";
    const token: JsonObject = { $type: dtcgType(v.type), $value };
    if (v.description) token.$description = v.description;
    token.$extensions = ext;
    // Nested groups along the slash path (a token and a group can't share a name: the token wins, as it came first).
    const parts = v.name.split("/").map((p) => p.trim()).filter(Boolean);
    let at = root;
    for (const p of parts.slice(0, -1)) {
      const next = at[p];
      if (next && typeof next === "object" && !Array.isArray(next) && !("$value" in next)) at = next as JsonObject;
      else if (!next) at = at[p] = {};
      else break;
    }
    const leaf = parts[parts.length - 1] ?? v.name;
    if (!(leaf in at)) at[leaf] = token;
  }
  root.$extensions = { "com.figma.modeName": modeName };
  return JSON.stringify(root, null, 2) + "\n";
}

function rootCollection(c: Collection): Collection {
  let cur = c;
  for (let i = 0; cur.parentCollection && i < 16; i++) cur = cur.parentCollection;
  return cur;
}

// ---- Import ----------------------------------------------------------------------------------------------------------

export interface ImportedToken {
  /** The slash name ("color/accent/light") */
  name: string;
  type: VarType;
  /** A literal, or a reference to another token by its slash name, or aliasData naming a variable elsewhere */
  value: { kind: "literal"; value: Literal } | { kind: "ref"; name: string } | { kind: "aliasData"; id?: string; collectionId?: string; collection?: string; name?: string; fallback: Literal | null };
  description?: string;
}

export interface ImportedFile {
  modeName: string | null;
  tokens: ImportedToken[];
  /** Tokens left out: an unsupported $type or value */
  skipped: string[];
}

const isObj = (v: unknown): v is JsonObject => !!v && typeof v === "object" && !Array.isArray(v);

function clamp01(v: number): number {
  return Math.max(0, Math.min(1, v));
}

/** A DTCG colour value: the 2025 object (sRGB or HSL), or a hex string ("#rgb", "#rrggbb", "#rrggbbaa"). */
export function parseColor(v: Json): Color | null {
  if (typeof v === "string") {
    const m = /^#([0-9a-f]{3,4}|[0-9a-f]{6}|[0-9a-f]{8})$/i.exec(v.trim());
    if (!m) return null;
    let h = m[1];
    if (h.length <= 4) h = [...h].map((c) => c + c).join("");
    const n = (i: number) => parseInt(h.slice(i, i + 2), 16) / 255;
    return { r: n(0), g: n(2), b: n(4), a: h.length === 8 ? n(6) : 1 };
  }
  if (!isObj(v)) return null;
  const alpha = typeof v.alpha === "number" ? clamp01(v.alpha) : 1;
  const comps = Array.isArray(v.components) ? v.components.map((x) => (typeof x === "number" ? x : 0)) : null;
  if (v.colorSpace === "srgb" && comps && comps.length >= 3) return { r: clamp01(comps[0]), g: clamp01(comps[1]), b: clamp01(comps[2]), a: alpha };
  if (v.colorSpace === "hsl" && comps && comps.length >= 3) {
    const [h, s, l] = [comps[0] / 360, comps[1] / 100, comps[2] / 100];
    const f = (n: number) => {
      const k = (n + h * 12) % 12;
      const a = s * Math.min(l, 1 - l);
      return l - a * Math.max(-1, Math.min(k - 3, 9 - k, 1));
    };
    return { r: clamp01(f(0)), g: clamp01(f(8)), b: clamp01(f(4)), a: alpha };
  }
  if (typeof v.hex === "string") {
    const c = parseColor(v.hex);
    return c ? { ...c, a: alpha } : null;
  }
  return null;
}

/** Parses one DTCG file (Figma's own exports and the formats its importer takes). Throws on malformed JSON. */
export function parseTokens(text: string): ImportedFile {
  const root = JSON.parse(text) as Json;
  if (!isObj(root)) throw new Error("The file isn't a design tokens JSON object");
  const rootExt = isObj(root.$extensions) ? root.$extensions : {};
  const modeName = typeof rootExt["com.figma.modeName"] === "string" ? rootExt["com.figma.modeName"] : null;
  const tokens: ImportedToken[] = [];
  const skipped: string[] = [];
  const seen = new Set<string>();
  const walk = (node: JsonObject, path: string[], inheritedType: string | null) => {
    const groupType = typeof node.$type === "string" ? node.$type : inheritedType;
    for (const [key, child] of Object.entries(node)) {
      if (key.startsWith("$") || !isObj(child)) continue;
      const name = [...path, key.trim()].join("/");
      if (!("$value" in child)) {
        walk(child, [...path, key.trim()], groupType);
        continue;
      }
      if (seen.has(name)) continue; // the first one encountered wins
      const t = parseToken(name, child, groupType);
      if (t) {
        seen.add(name);
        tokens.push(t);
      } else skipped.push(name);
    }
  };
  walk(root, [], null);
  return { modeName, tokens, skipped };
}

function parseToken(name: string, node: JsonObject, groupType: string | null): ImportedToken | null {
  const $type = typeof node.$type === "string" ? node.$type : groupType;
  const ext = isObj(node.$extensions) ? node.$extensions : {};
  const figmaType = typeof ext["com.figma.type"] === "string" ? ext["com.figma.type"] : null;
  const raw = node.$value as Json;
  const description = typeof node.$description === "string" ? node.$description : undefined;
  let type: VarType;
  switch ($type) {
    case "color":
      type = "COLOR";
      break;
    case "number":
    case "dimension":
    case "duration":
      type = figmaType === "boolean" ? "BOOLEAN" : "FLOAT";
      break;
    case "boolean":
      type = "BOOLEAN";
      break;
    case "string":
    case "fontFamily":
      type = "STRING";
      break;
    default:
      return null;
  }
  const literal = (v: Json): Literal | null => {
    if (type === "COLOR") return parseColor(v);
    if (type === "BOOLEAN") return typeof v === "boolean" ? v : typeof v === "number" ? v !== 0 : v === "true" ? true : v === "false" ? false : null;
    if (type === "STRING") return typeof v === "string" ? v : Array.isArray(v) ? null : typeof v === "number" ? String(v) : null;
    // Numbers: plain, or a dimension in px / a duration in s ({value, unit}, or "16px" / "0.2s").
    if (typeof v === "number") return v;
    if (isObj(v) && typeof v.value === "number") {
      if ($type === "dimension" && v.unit !== "px") return null;
      if ($type === "duration" && v.unit !== "s") return null;
      return v.value;
    }
    if (typeof v === "string") {
      const m = /^(-?\d*\.?\d+)(px|s)?$/.exec(v.trim());
      if (!m) return null;
      if ($type === "dimension" && m[2] !== "px") return null;
      if ($type === "duration" && m[2] !== "s") return null;
      return Number(m[1]);
    }
    return null;
  };
  if (typeof raw === "string" && /^\{[^{}]+\}$/.test(raw.trim())) {
    return { name, type, value: { kind: "ref", name: raw.trim().slice(1, -1).split(".").join("/") }, description };
  }
  const alias = isObj(ext["com.figma.aliasData"]) ? (ext["com.figma.aliasData"] as JsonObject) : null;
  if (alias) {
    const str = (k: string) => (typeof alias[k] === "string" ? (alias[k] as string) : undefined);
    return {
      name,
      type,
      value: { kind: "aliasData", id: str("targetVariableId"), collectionId: str("targetVariableSetId"), collection: str("targetVariableSetName"), name: str("targetVariableName"), fallback: literal(raw) },
      description,
    };
  }
  const value = literal(raw);
  if (value === null) return null;
  return { name, type, value: { kind: "literal", value }, description };
}

/** A Figma id from an export ("VariableID:1:2", "VariableID:abc/-1:-1") as ours ("1:2"), when it is one of ours. */
export function localIdOf(figmaId: string | undefined): Guid | null {
  if (!figmaId) return null;
  const m = /^(?:VariableID|VariableCollectionId):(\d+:\d+)$/.exec(figmaId);
  return m ? m[1] : null;
}

/**
 * Where an aliasData token points, among the variables we have: by id (ours), else by collection id, else by
 * collection and variable names. Null: not found (the token then takes its value).
 */
export function findAliasTarget(value: Extract<ImportedToken["value"], { kind: "aliasData" }>, variables: readonly Variable[], lookup: VariableLookup): Guid | null {
  const id = localIdOf(value.id);
  if (id && lookup.variable(id)) return id;
  const cid = localIdOf(value.collectionId);
  if (cid && value.name) {
    const hit = variables.find((v) => v.collection === cid && v.name === value.name);
    if (hit) return hit.id;
  }
  if (value.collection && value.name) {
    const hit = variables.find((v) => v.name === value.name && lookup.collection(v.collection)?.name === value.collection);
    if (hit) return hit.id;
  }
  return null;
}

/** What importing a file's tokens into a mode means for each variable: a value of the right type (null: skip). */
export function tokenValue(t: ImportedToken, byName: ReadonlyMap<string, Variable>, variables: readonly Variable[], lookup: VariableLookup): VarValue | null {
  if (t.value.kind === "literal") return { kind: "literal", value: t.value.value };
  if (t.value.kind === "ref") {
    const target = byName.get(t.value.name);
    return target ? { kind: "alias", id: target.id } : null;
  }
  const target = findAliasTarget(t.value, variables, lookup);
  if (target) return { kind: "alias", id: target };
  return t.value.fallback === null ? null : { kind: "literal", value: t.value.fallback };
}
