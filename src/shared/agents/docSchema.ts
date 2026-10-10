/**
 * The agents' tools on the document's own types (schema/document.kiwi through MODEL): the JSON Schema of a paint,
 * an effect, a layout guide … and the converters between the document's values and the tools' — generated from the
 * schema, so a field the schema gains is readable and writable through the tools without a change here, under the
 * schema's name. One shape for reads and writes: what get_design_context gives, update_nodes takes.
 *
 * The tools' shape is the document's, with these conventions (Plugin API–like, as agents know Figma):
 *   - Color → "#RRGGBB" / "#RRGGBBAA";  GUID → "123:456";  byte[] (an image's or video's hash) → 40 hex digits;
 *   - enums by name, with Figma's UI names where the schema keeps an older one (FOREGROUND_BLUR → LAYER_BLUR,
 *     GRAIN → TEXTURE, image scale STRETCH → CROP) — both are read on writes;
 *   - a few renamed fields (Paint.image → imageRef, imageScaleMode → scaleMode, video → videoRef);
 *   - variable bindings (`…Var` fields) are left out: bind_variable writes them, get_design_context lists them;
 *   - Plugin API aliases are read on writes (an effect's lightAngle → specularAngle …), never written back.
 * Unknown fields, wrong types and unknown enum values are errors naming the field and what it takes.
 */
import { MODEL, NATIVE_TYPES, type FieldDef } from "../schema/model";
import { DEFAULTS } from "../schema/document.generated";

type Obj = Record<string, unknown>;

/** Per-definition conventions. */
interface DefRules {
  /** Fields not in the tools (bindings, thumbnails, blobs …) */
  exclude?: readonly string[];
  /** Read, never written (the engine derives them) */
  readOnly?: readonly string[];
  /** document name → tools' name */
  rename?: Readonly<Record<string, string>>;
  /** Accepted on writes for a field (tools' name) */
  aliases?: Readonly<Record<string, string>>;
  /** What a field means, for the descriptions (the panel's label) */
  doc?: Readonly<Record<string, string>>;
}

const RULES: Record<string, DefRules> = {
  Paint: {
    exclude: ["imageThumbnail", "thumbHash"],
    readOnly: ["originalImageWidth", "originalImageHeight"],
    rename: { image: "imageRef", imageScaleMode: "scaleMode", video: "videoRef" },
    aliases: { imageHash: "imageRef", scalingFactor: "scale", filters: "paintFilter", gradientStops: "stops", gradientTransform: "transform", tileType: "patternTileType" },
    doc: {
      type: "SOLID | GRADIENT_LINEAR | GRADIENT_RADIAL | GRADIENT_ANGULAR | GRADIENT_DIAMOND | IMAGE | VIDEO | PATTERN | NOISE | CUSTOM (shader)",
      color: "SOLID / NOISE: the colour",
      opacity: "0–1",
      stops: 'Gradients: [{color: "#RRGGBBAA", position: 0–1}]',
      transform: "Gradient / image transform in the layer's unit box ({m00,m01,m02,m10,m11,m12}); default: left-to-right for a linear gradient",
      imageRef: "IMAGE / VIDEO: the image's hash (40 hex digits) read from get_design_context",
      scaleMode: "IMAGE: FILL | FIT | CROP | TILE",
      rotation: "IMAGE: degrees (multiples of 90)",
      scale: "IMAGE (TILE) / PATTERN: scale",
      paintFilter: "IMAGE: adjustments {exposure, contrast, vibrance (Saturation), temperature, tint, highlights, shadows} each −1–1",
      videoRef: "VIDEO: the video's hash",
      sourceNodeId: 'PATTERN: the layer tiled ("123:456")',
      patternTileType: "PATTERN: RECTANGULAR | HORIZONTAL_HEXAGONAL | VERTICAL_HEXAGONAL",
      patternSpacing: "PATTERN: {x, y} as a share of the tile (0.2 = 20 %)",
      horizontalAlignment: "PATTERN: START | CENTER | END",
      verticalAlignment: "PATTERN: START | CENTER | END",
      noiseType: "NOISE: MONOTONE | DUOTONE | MULTITONE",
      density: "NOISE: 0–1",
      noiseSize: "NOISE: {x, y}",
    },
  },
  Effect: {
    aliases: {
      lightAngle: "specularAngle",
      lightIntensity: "specularIntensity",
      refraction: "refractionIntensity",
      depth: "bevelSize",
      dispersion: "chromaticAberration",
      splay: "refractionRadius",
      frost: "radius",
      blurType: "blurOpType",
    },
    doc: {
      type: "DROP_SHADOW | INNER_SHADOW | LAYER_BLUR | BACKGROUND_BLUR | NOISE | TEXTURE | GLASS | CUSTOM (shader)",
      color: "Shadows / NOISE: the colour (#RRGGBBAA)",
      offset: "Shadows: {x, y}",
      radius: "Shadows: blur; blurs: the radius (Progressive: the End); TEXTURE: radius; GLASS: Frost",
      spread: "Shadows: spread",
      showShadowBehindNode: "DROP_SHADOW: Show behind transparent areas",
      blendMode: "Shadows / NOISE",
      blurOpType: "Blurs: NORMAL (Uniform) | PROGRESSIVE",
      startRadius: "Progressive blur: Start",
      startOffset: "Progressive blur: where it starts, in the layer's box {x, y} 0–1 (default {x:0.5, y:0})",
      endOffset: "Progressive blur: where it ends (default {x:0.5, y:1})",
      noiseType: "NOISE: MONOTONE (Mono) | DUOTONE (Duo) | MULTITONE (Multi)",
      noiseSize: "NOISE: Noise size / TEXTURE: Size {x, y}",
      density: "NOISE: Density 0–1",
      secondaryColor: "NOISE (Duo): the second colour",
      opacity: "NOISE (Multi): Opacity 0–1",
      clipToShape: "TEXTURE: Clip to shape",
      seed: "NOISE / TEXTURE: the random pattern",
      specularAngle: "GLASS: Light angle, degrees −180–180 (default −45)",
      specularIntensity: "GLASS: Light intensity 0–1 (default 0.8)",
      refractionIntensity: "GLASS: Refraction 0–1 (default 0.8)",
      bevelSize: "GLASS: Depth 0–100 (default 20)",
      chromaticAberration: "GLASS: Dispersion 0–1 (default 0.5)",
      refractionRadius: "GLASS: Splay 0–100 (default 0)",
      reflectionDistance: "GLASS: reflection distance (not in the panel)",
    },
  },
  LayoutGrid: {
    doc: {
      pattern: "STRIPES (columns / rows) | GRID",
      axis: "STRIPES: X = columns, Y = rows",
      type: "STRIPES: MIN | CENTER | STRETCH | MAX",
      numSections: "Count",
      sectionSize: "Width / height of a column, row or grid cell",
      gutterSize: "Gutter",
      offset: "Margin / offset",
    },
  },
  Image: { exclude: ["dataBlob"] },
};

/** Enum values as the tools name them (document → tools); writes take both. */
const ENUM_NAMES: Record<string, Record<string, string>> = {
  EffectType: { FOREGROUND_BLUR: "LAYER_BLUR", GRAIN: "TEXTURE" },
  ImageScaleMode: { STRETCH: "CROP" },
};

const isBinding = (f: FieldDef) => f.name.endsWith("Var") || f.type === "VariableData" || f.type === "ColorStopVar";
/** Where a VariableData is a value, not a binding: prototype actions (Set variable, Conditional) and expressions. */
const VALUE_DATA_DEFS: ReadonlySet<string> = new Set(["PrototypeAction", "ConditionalActions", "Expression", "VariableMapValue", "VariableFontStyle"]);

/** The definition's fields as the tools have them. */
export function toolFields(def: string): { name: string; field: FieldDef; readOnly: boolean }[] {
  const d = MODEL.def(def);
  const r = RULES[def] ?? {};
  return d.fields
    .filter((f) => (!isBinding(f) || (f.type === "VariableData" && VALUE_DATA_DEFS.has(def))) && !(r.exclude ?? []).includes(f.name) && !MODEL.isBlobField(def, f.name))
    .map((f) => ({ name: r.rename?.[f.name] ?? f.name, field: f, readOnly: (r.readOnly ?? []).includes(f.name) }));
}

export const enumValues = (def: string): string[] => [...MODEL.def(def).enumNames.values()].map((v) => ENUM_NAMES[def]?.[v] ?? v);

// ---- JSON Schema ------------------------------------------------------------------------------------------------------

/** A value of `type` as JSON Schema; `depth` > 0 inlines message fields (one level below the top by default). */
export function typeSchema(type: string, isArray: boolean, depth = 1): Obj {
  const one = ((): Obj => {
    if (type === "bool") return { type: "boolean" };
    if (type === "string") return { type: "string" };
    if (type === "byte") return { type: "string", description: "hex" };
    if (NATIVE_TYPES.has(type)) return { type: "number" };
    if (type === "Color") return { type: "string", description: '"#RRGGBB" or "#RRGGBBAA"' };
    if (type === "GUID") return { type: "string", description: 'An id "123:456"' };
    const d = MODEL.def(type);
    if (d.kind === "ENUM") return { enum: enumValues(type) };
    if (depth <= 0) return { type: "object", description: `schema/document.kiwi ${type}: ${toolFields(type).map((f) => f.name).join(", ")}` };
    return structSchema(type, depth - 1);
  })();
  if (type === "byte" && isArray) return one;
  return isArray ? { type: "array", items: one } : one;
}

/** A definition as a JSON Schema object (strict: no other fields). */
export function structSchema(def: string, depth = 1): Obj {
  const r = RULES[def] ?? {};
  const properties: Obj = {};
  for (const f of toolFields(def)) {
    const s = typeSchema(f.field.type!, f.field.isArray, depth);
    const doc = r.doc?.[f.name] ?? r.doc?.[f.field.name];
    properties[f.name] = { ...s, ...(doc || f.readOnly ? { description: [doc, f.readOnly ? "read-only" : ""].filter(Boolean).join("; ") } : {}) };
  }
  const aliases = Object.entries(r.aliases ?? {});
  return {
    type: "object",
    properties,
    additionalProperties: false,
    ...(aliases.length ? { description: `Also read on writes: ${aliases.map(([a, t]) => `${a} (= ${t})`).join(", ")}.` } : {}),
  };
}

// ---- Values -----------------------------------------------------------------------------------------------------------

const hex2 = (x: number) => Math.round(Math.max(0, Math.min(1, x)) * 255).toString(16).padStart(2, "0");

export function colorToHex(c: { r: number; g: number; b: number; a?: number } | undefined): string {
  if (!c) return "#000000";
  const a = c.a ?? 1;
  return `#${hex2(c.r)}${hex2(c.g)}${hex2(c.b)}${a < 0.999 ? hex2(a) : ""}`.toUpperCase();
}

export function parseColorValue(v: unknown): { r: number; g: number; b: number; a: number } | null {
  if (v && typeof v === "object" && "r" in v && "g" in v && "b" in v) {
    const o = v as { r: unknown; g: unknown; b: unknown; a?: unknown };
    if ([o.r, o.g, o.b].every((x) => typeof x === "number")) return { r: o.r as number, g: o.g as number, b: o.b as number, a: typeof o.a === "number" ? o.a : 1 };
    return null;
  }
  if (typeof v !== "string") return null;
  let h = v.trim().replace(/^#/, "");
  if (/^[0-9a-f]{3,4}$/i.test(h)) h = [...h].map((c) => c + c).join("");
  if (!/^[0-9a-f]{6}([0-9a-f]{2})?$/i.test(h)) {
    const m = /^rgba?\(\s*([\d.]+)\s*,\s*([\d.]+)\s*,\s*([\d.]+)\s*(?:,\s*([\d.]+)\s*)?\)$/i.exec(v.trim());
    if (!m) return null;
    return { r: +m[1] / 255, g: +m[2] / 255, b: +m[3] / 255, a: m[4] === undefined ? 1 : +m[4] };
  }
  const n = (i: number) => parseInt(h.slice(i, i + 2), 16) / 255;
  return { r: n(0), g: n(2), b: n(4), a: h.length === 8 ? n(6) : 1 };
}

const guidText = (v: unknown): string | null => {
  if (typeof v === "string") return v;
  if (v && typeof v === "object" && "sessionID" in v && "localID" in v) return `${(v as { sessionID: number }).sessionID}:${(v as { localID: number }).localID}`;
  return null;
};

const hashHex = (v: unknown): string | null => {
  if (typeof v === "string") return v.toLowerCase();
  if (Array.isArray(v) || v instanceof Uint8Array) return Array.from(v as ArrayLike<number>).map((x) => (x & 255).toString(16).padStart(2, "0")).join("");
  return null;
};

const round = (v: number) => (Number.isInteger(v) ? v : Math.round(v * 10000) / 10000);

/** A document value of `type` in the tools' shape (undefined: nothing to show). */
export function toTool(type: string, isArray: boolean, v: unknown, def?: string, field?: string): unknown {
  if (v === undefined || v === null) return undefined;
  if (type === "byte" && isArray) return hashHex(v) ?? undefined;
  if (isArray) return Array.isArray(v) ? v.map((x) => toTool(type, false, x)).filter((x) => x !== undefined) : undefined;
  if (type === "bool") return typeof v === "boolean" ? v : undefined;
  if (type === "string") return typeof v === "string" ? v : undefined;
  if (NATIVE_TYPES.has(type)) return typeof v === "number" ? round(v) : undefined;
  if (type === "Color") return colorToHex(v as never);
  if (type === "GUID") return guidText(v) ?? undefined;
  const d = MODEL.defs.get(type);
  if (!d) return v;
  if (d.kind === "ENUM") return typeof v === "string" ? (ENUM_NAMES[type]?.[v] ?? v) : typeof v === "number" ? (d.enumNames.get(v) ?? v) : undefined;
  if (typeof v !== "object") return undefined;
  // Paint.image / video: the hash alone.
  if ((type === "Image" || type === "Video") && def === "Paint" && (field === "image" || field === "video")) return hashHex((v as Obj).hash) ?? undefined;
  const o = v as Obj;
  const out: Obj = {};
  const defaults = (DEFAULTS as Record<string, Obj>)[type] ?? {};
  for (const f of toolFields(type)) {
    const value = toTool(f.field.type!, f.field.isArray, o[f.field.name], type, f.field.name);
    if (value === undefined) continue;
    // Absent = the default (the schema's @default): left out, as the document leaves it out.
    if (f.name !== "type" && f.field.name in defaults && sameValue(value, toTool(f.field.type!, f.field.isArray, defaults[f.field.name]))) continue;
    out[f.name] = value;
  }
  return out;
}

/** Errors are "path: reason" strings. */
export type Errors = string[];

/**
 * The tools' value of `type` as the document's (undefined, with an error, when it can't be read). `path` names it in
 * errors ("fills[0].stops[1].color").
 */
export function fromTool(type: string, isArray: boolean, v: unknown, path: string, errors: Errors, def?: string, field?: string): unknown {
  if (type === "byte" && isArray) {
    const h = typeof v === "string" ? v.trim().toLowerCase() : null;
    if (!h || !/^[0-9a-f]+$/.test(h)) return void errors.push(`${path}: a hash as hex digits`);
    return h;
  }
  if (isArray) {
    if (!Array.isArray(v)) return void errors.push(`${path}: a list`);
    const out: unknown[] = [];
    v.forEach((x, i) => {
      const r = fromTool(type, false, x, `${path}[${i}]`, errors, def, field);
      if (r !== undefined) out.push(r);
    });
    return out;
  }
  if (type === "bool") return typeof v === "boolean" ? v : void errors.push(`${path}: true or false`);
  if (type === "string") return typeof v === "string" ? v : void errors.push(`${path}: a string`);
  if (NATIVE_TYPES.has(type)) {
    if (typeof v !== "number" || !Number.isFinite(v)) return void errors.push(`${path}: a number`);
    if ((type === "uint" || type === "int") && !Number.isInteger(v)) return void errors.push(`${path}: a whole number`);
    if (type === "uint" && v < 0) return void errors.push(`${path}: 0 or more`);
    return v;
  }
  if (type === "Color") return parseColorValue(v) ?? void errors.push(`${path}: a colour "#RRGGBB" / "#RRGGBBAA" (got ${JSON.stringify(v)})`);
  if (type === "GUID") {
    const s = guidText(v);
    const m = s ? /^(\d+)[:-](\d+)$/.exec(s.trim()) : null;
    return m ? { sessionID: +m[1], localID: +m[2] } : void errors.push(`${path}: an id "123:456"`);
  }
  const d = MODEL.defs.get(type);
  if (!d) return v;
  if (d.kind === "ENUM") {
    const s = typeof v === "string" ? v.trim().toUpperCase() : "";
    const back = Object.entries(ENUM_NAMES[type] ?? {}).find(([, tool]) => tool === s)?.[0];
    const name = back ?? s;
    if ([...d.enumNames.values()].includes(name)) return name;
    return void errors.push(`${path}: ${JSON.stringify(v)} is not one of ${enumValues(type).join(", ")}`);
  }
  if ((type === "Image" || type === "Video") && def === "Paint" && (field === "image" || field === "video")) {
    const h = typeof v === "string" ? v : v && typeof v === "object" ? hashHex((v as Obj).hash) : null;
    if (!h || !/^[0-9a-f]{40}$/i.test(h)) return void errors.push(`${path}: a 40-digit hex hash (read one from get_design_context)`);
    return { hash: h.toLowerCase() };
  }
  if (!v || typeof v !== "object" || Array.isArray(v)) return void errors.push(`${path}: an object (${type})`);
  const r = RULES[type] ?? {};
  const fields = toolFields(type);
  const byTool = new Map(fields.map((f) => [f.name, f]));
  const out: Obj = {};
  for (const [k0, value] of Object.entries(v as Obj)) {
    const k = byTool.has(k0) ? k0 : (r.aliases?.[k0] ?? (fields.find((f) => f.field.name === k0)?.name ?? k0));
    const f = byTool.get(k);
    if (!f) {
      errors.push(`${path}.${k0}: unknown field (${type} takes ${fields.filter((x) => !x.readOnly).map((x) => x.name).join(", ")})`);
      continue;
    }
    if (f.readOnly) continue; // read back as it was read: ignored, as the engine derives it
    const r1 = fromTool(f.field.type!, f.field.isArray, value, `${path}.${k}`, errors, type, f.field.name);
    if (r1 !== undefined) out[f.field.name] = r1;
  }
  return out;
}

/** Values equal as the tools read them: numbers to 0.01 (0.001 under 1), colours by hex, absent = 0 / false / "". */
export function sameValue(a: unknown, b: unknown, subset = false): boolean {
  const empty = (x: unknown) => x === undefined || x === null || x === 0 || x === false || x === "" || (Array.isArray(x) && x.length === 0);
  if (empty(a) && empty(b)) return true;
  if (typeof a === "number" && typeof b === "number") return Math.abs(a - b) <= (Math.abs(a) < 1 && Math.abs(b) < 1 ? 0.002 : 0.01);
  if (typeof a === "string" && typeof b === "string") return a.toUpperCase() === b.toUpperCase();
  if (Array.isArray(a) && Array.isArray(b)) return a.length === b.length && a.every((x, i) => sameValue(x, b[i], subset));
  if (a && b && typeof a === "object" && typeof b === "object" && !Array.isArray(a) && !Array.isArray(b)) {
    // subset: `a` is what was asked — fields it leaves out may be anything.
    const keys = new Set([...Object.keys(a), ...(subset ? [] : Object.keys(b))]);
    for (const k of keys) if (!sameValue((a as Obj)[k], (b as Obj)[k], subset)) return false;
    return true;
  }
  return a === b;
}

/** The kiwi type of a NodeChange field (null: not in the schema). */
export function nodeFieldType(name: string): FieldDef | null {
  return MODEL.def("NodeChange").byName.get(name) ?? null;
}
