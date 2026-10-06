/**
 * schemagen: the one generator for `schema/document.kiwi` (docs/schema.md §2.2).
 *
 *   node engine/tools/schemagen/schemagen.ts                 write src/shared/schema/document.generated.ts
 *   node engine/tools/schemagen/schemagen.ts --check         regenerate into a temp dir, diff, run the schema checks
 *   node engine/tools/schemagen/schemagen.ts --cpp <build>   write <build>/generated/schema/{document.kiwi.h,document.stream.h,node_fields.h}
 *
 * Node 24 TypeScript with erasable syntax only (no enums, namespaces or parameter properties), so Node runs it as is.
 * It uses the kiwi-schema 0.5.0 library API, not the CLI. Everything it knows about field tags comes from the trailing
 * comments of `document.kiwi` (grammar in docs/schema.md §1.3); `fieldmeta.ts` (engine-only metadata) reads the same
 * tag model through `loadSchema()` instead of restating it.
 */
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { inflateRawSync, zstdDecompressSync } from "node:zlib";
import {
  compileSchemaCallbackCPP,
  compileSchemaCPP,
  compileSchemaJS,
  compileSchemaTypeScript,
  decodeBinarySchema,
  encodeBinarySchema,
  parseSchema,
  type Definition,
  type Field,
  type Schema,
} from "kiwi-schema";

// ---------------------------------------------------------------------------------------------------------------------
// Paths
// ---------------------------------------------------------------------------------------------------------------------

const HERE = dirname(fileURLToPath(import.meta.url));
export const REPO_ROOT = resolve(HERE, "../../..");
export const SCHEMA_PATH = join(REPO_ROOT, "schema/document.kiwi");
export const TS_OUTPUT = join(REPO_ROOT, "src/shared/schema/document.generated.ts");
export const FIGMA_SCHEMA_TEXT = join(REPO_ROOT, "docs/research/figma/figma-schema.kiwi");
export const FIGMA_SAMPLE_FIG = join(REPO_ROOT, "docs/research/figma/samples/sections.fig");

// ---------------------------------------------------------------------------------------------------------------------
// Tags
// ---------------------------------------------------------------------------------------------------------------------

export const KNOWN_TAGS = ["derived", "blob", "nooverride", "default", "bind", "own", "patch", "later", "ours"] as const;
export type TagName = (typeof KNOWN_TAGS)[number];
/** Tags only allowed on NodeChange fields (docs/schema.md §2.2 check 4). */
const NODECHANGE_ONLY: readonly string[] = ["derived", "own", "patch"];

export interface Tag {
  name: string;
  /** Text between the parentheses, or null when the tag has none */
  args: string | null;
}

/** The tags and free text of one trailing comment. */
export interface Annotation {
  tags: Tag[];
  text: string;
  line: number;
}

export interface TagModel {
  /** Tags of a definition (the comment after its `{`), by definition name */
  definitions: Map<string, Annotation>;
  /** Tags of a field or enum value, keyed `Definition.field` */
  fields: Map<string, Annotation>;
  documentFormatVersion: number;
  /** Malformed comments found while scanning (reported by --check) */
  problems: string[];
}

/** Parses `@a @b(x, y) free text` into tags and text. Returns a problem string when the comment is malformed. */
export function parseAnnotation(comment: string, line: number): { annotation: Annotation; problem: string | null } {
  const tags: Tag[] = [];
  let i = 0;
  const s = comment;
  let problem: string | null = null;
  for (;;) {
    while (i < s.length && s[i] === " ") i++;
    if (s[i] !== "@") break;
    i++;
    const start = i;
    while (i < s.length && /[a-z]/.test(s[i])) i++;
    const name = s.slice(start, i);
    let args: string | null = null;
    if (s[i] === "(") {
      let depth = 0;
      const open = i;
      for (; i < s.length; i++) {
        if (s[i] === "(" || s[i] === "{") depth++;
        else if (s[i] === ")" || s[i] === "}") depth--;
        if (depth === 0) break;
      }
      if (depth !== 0) {
        problem = `line ${line}: unbalanced parentheses in tag @${name}`;
        args = s.slice(open + 1);
        i = s.length;
      } else {
        args = s.slice(open + 1, i);
        i++;
      }
    }
    if (!name) problem = `line ${line}: '@' without a tag name`;
    tags.push({ name, args });
  }
  const text = s.slice(i).trim();
  if (text.includes("@")) problem = `line ${line}: '@' in free text (tags must come first): ${JSON.stringify(text)}`;
  return { annotation: { tags, text, line }, problem };
}

/** Scans the schema text for definition and field comments. Kiwi's own parser drops comments, so this is a second pass. */
export function scanTags(text: string): TagModel {
  const definitions = new Map<string, Annotation>();
  const fields = new Map<string, Annotation>();
  const problems: string[] = [];
  const version = /^\/\/\s*DOCUMENT_FORMAT_VERSION\s*=\s*(\d+)/m.exec(text);
  if (!version) problems.push("missing `// DOCUMENT_FORMAT_VERSION = N` header line");
  const lines = text.split("\n");
  let current: { name: string; kind: string } | null = null;
  for (let n = 0; n < lines.length; n++) {
    const lineNo = n + 1;
    const raw = lines[n];
    const cut = raw.indexOf("//");
    const code = (cut >= 0 ? raw.slice(0, cut) : raw).trim();
    const comment = cut >= 0 ? raw.slice(cut + 2).trim() : "";
    const header = /^(enum|struct|message)\s+([A-Za-z_][A-Za-z0-9_]*)\s*\{$/.exec(code);
    if (header) {
      current = { kind: header[1], name: header[2] };
      if (comment) {
        const { annotation, problem } = parseAnnotation(comment, lineNo);
        if (problem) problems.push(problem);
        if (annotation.tags.length) definitions.set(current.name, annotation);
      }
      continue;
    }
    if (code === "}") {
      current = null;
      continue;
    }
    if (!current || !code) continue;
    const decls = code
      .split(";")
      .map((d) => d.trim())
      .filter(Boolean);
    const names: string[] = [];
    for (const d of decls) {
      let m: RegExpExecArray | null;
      if (current.kind === "enum") m = /^([A-Za-z_][A-Za-z0-9_]*)\s*=\s*\d+$/.exec(d);
      else if (current.kind === "struct") m = /^[A-Za-z_][A-Za-z0-9_]*(?:\[\])?\s+([A-Za-z_][A-Za-z0-9_]*)$/.exec(d);
      else m = /^[A-Za-z_][A-Za-z0-9_]*(?:\[\])?\s+([A-Za-z_][A-Za-z0-9_]*)\s*=\s*\d+(?:\s*\[deprecated\])?$/.exec(d);
      if (m) names.push(m[1]);
      else problems.push(`line ${lineNo}: cannot read declaration ${JSON.stringify(d)} in ${current.kind} ${current.name}`);
    }
    if (!comment) continue;
    const { annotation, problem } = parseAnnotation(comment, lineNo);
    if (problem) problems.push(problem);
    if (names.length === 1) fields.set(`${current.name}.${names[0]}`, annotation);
    else if (annotation.tags.length) problems.push(`line ${lineNo}: tags on a line with ${names.length} declarations`);
  }
  return { definitions, fields, documentFormatVersion: version ? Number(version[1]) : 0, problems };
}

// ---------------------------------------------------------------------------------------------------------------------
// The loaded schema
// ---------------------------------------------------------------------------------------------------------------------

export interface LoadedSchema {
  text: string;
  schema: Schema;
  tags: TagModel;
  binary: Uint8Array;
  sha1: string;
  byName: Map<string, Definition>;
}

export function loadSchema(path: string = SCHEMA_PATH): LoadedSchema {
  const text = readFileSync(path, "utf8");
  const schema = parseSchema(text);
  const binary = encodeBinarySchema(schema);
  return {
    text,
    schema,
    tags: scanTags(text),
    binary,
    sha1: createHash("sha1").update(binary).digest("hex"),
    byName: new Map(schema.definitions.map((d) => [d.name, d])),
  };
}

const tagsOf = (s: LoadedSchema, def: string, field: string): Tag[] => s.tags.fields.get(`${def}.${field}`)?.tags ?? [];
const hasTag = (s: LoadedSchema, def: string, field: string, tag: TagName) => tagsOf(s, def, field).some((t) => t.name === tag);
const defHasTag = (s: LoadedSchema, def: string, tag: TagName) => (s.tags.definitions.get(def)?.tags ?? []).some((t) => t.name === tag);

/** Field flags shared by the TS and C++ registries (bit values are part of the generated contract). */
export const FLAG_BITS: Record<string, number> = {
  DERIVED: 1 << 0,
  BLOB: 1 << 1,
  NOOVERRIDE: 1 << 2,
  OWN: 1 << 3,
  PATCH: 1 << 4,
  LATER: 1 << 5,
  OURS: 1 << 6,
};

function fieldFlags(s: LoadedSchema, def: string, field: string): number {
  let flags = 0;
  for (const t of tagsOf(s, def, field)) {
    const bit = FLAG_BITS[t.name.toUpperCase()];
    if (bit !== undefined) flags |= bit;
  }
  return flags;
}

const NATIVE = new Set(["bool", "byte", "int", "uint", "float", "string", "int64", "uint64"]);

// ---------------------------------------------------------------------------------------------------------------------
// Defaults and bindings (typed values parsed from the tags)
// ---------------------------------------------------------------------------------------------------------------------

export type DefaultValue = boolean | number | string | { [field: string]: DefaultValue };

function splitTopLevel(s: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let cur = "";
  for (const ch of s) {
    if (ch === "{" || ch === "(") depth++;
    if (ch === "}" || ch === ")") depth--;
    if (ch === "," && depth === 0) {
      out.push(cur.trim());
      cur = "";
    } else cur += ch;
  }
  if (cur.trim()) out.push(cur.trim());
  return out;
}

/** Parses a `@default(v)` argument for a field of type `type`. Throws with a message when it does not fit the type. */
export function parseDefault(s: LoadedSchema, type: string, raw: string): DefaultValue {
  const v = raw.trim();
  switch (type) {
    case "bool":
      if (v === "true" || v === "false") return v === "true";
      throw new Error(`expected true or false, got ${v}`);
    case "byte":
    case "int":
    case "uint":
    case "float": {
      const num = Number(v);
      if (v === "" || !Number.isFinite(num)) throw new Error(`expected a number, got ${v}`);
      if (type !== "float" && !Number.isInteger(num)) throw new Error(`expected an integer, got ${v}`);
      if ((type === "uint" || type === "byte") && num < 0) throw new Error(`expected a non-negative integer, got ${v}`);
      return num;
    }
    case "string":
      return v;
  }
  const def = s.byName.get(type);
  if (!def) throw new Error(`unknown type ${type}`);
  if (def.kind === "ENUM") {
    if (!def.fields.some((f) => f.name === v)) throw new Error(`${v} is not a value of enum ${type}`);
    return v;
  }
  if (type === "Matrix" && v === "identity") return { m00: 1, m01: 0, m02: 0, m10: 0, m11: 1, m12: 0 };
  if (def.kind === "STRUCT" && v.startsWith("{") && v.endsWith("}")) {
    const parts = splitTopLevel(v.slice(1, -1));
    if (parts.length !== def.fields.length) throw new Error(`struct ${type} has ${def.fields.length} fields, default lists ${parts.length}`);
    const out: { [field: string]: DefaultValue } = {};
    def.fields.forEach((f, i) => {
      if (f.isArray) throw new Error(`array field ${type}.${f.name} in a struct default`);
      out[f.name] = parseDefault(s, f.type ?? "", parts[i]);
    });
    return out;
  }
  throw new Error(`cannot express a default for ${def.kind.toLowerCase()} ${type}: ${v}`);
}

export interface DefaultEntry {
  message: string;
  field: string;
  type: string;
  value: DefaultValue;
}

export interface BindingEntry {
  variableField: string;
  field: string;
  fieldId: number;
  component: string | null;
}

/** Finds component `c` of a field type: a direct field, or one inside a single-field wrapper (OptionalVector.value). */
function componentOf(s: LoadedSchema, type: string, c: string): boolean {
  const def = s.byName.get(type);
  if (!def || def.kind === "ENUM") return false;
  if (def.fields.some((f) => f.name === c && !f.isDeprecated)) return true;
  const live = def.fields.filter((f) => !f.isDeprecated);
  if (live.length === 1 && live[0].type && !NATIVE.has(live[0].type)) return componentOf(s, live[0].type, c);
  return false;
}

export function collectDefaults(s: LoadedSchema, problems?: string[]): DefaultEntry[] {
  const out: DefaultEntry[] = [];
  for (const def of s.schema.definitions) {
    if (def.kind === "ENUM") continue;
    for (const f of def.fields) {
      for (const t of tagsOf(s, def.name, f.name)) {
        if (t.name !== "default") continue;
        try {
          if (t.args === null) throw new Error("@default needs a value");
          if (f.isArray) throw new Error("@default on an array field");
          out.push({ message: def.name, field: f.name, type: f.type ?? "", value: parseDefault(s, f.type ?? "", t.args) });
        } catch (e) {
          problems?.push(`${def.name}.${f.name}: @default: ${(e as Error).message}`);
        }
      }
    }
  }
  return out;
}

export function collectBindings(s: LoadedSchema, problems?: string[]): BindingEntry[] {
  const out: BindingEntry[] = [];
  const variableField = s.byName.get("VariableField");
  for (const def of s.schema.definitions) {
    if (def.kind === "ENUM") continue;
    for (const f of def.fields) {
      for (const t of tagsOf(s, def.name, f.name)) {
        if (t.name !== "bind") continue;
        if (def.name !== "NodeChange") problems?.push(`${def.name}.${f.name}: @bind outside NodeChange`);
        for (const part of splitTopLevel(t.args ?? "")) {
          const [vf, comp] = part.split(":").map((x) => x.trim());
          if (!variableField?.fields.some((v) => v.name === vf)) problems?.push(`${def.name}.${f.name}: @bind(${vf}) is not a VariableField`);
          if (comp && !componentOf(s, f.type ?? "", comp)) problems?.push(`${def.name}.${f.name}: @bind(${vf}:${comp}): ${f.type} has no component ${comp}`);
          out.push({ variableField: vf, field: f.name, fieldId: f.value, component: comp ?? null });
        }
        if (!t.args) problems?.push(`${def.name}.${f.name}: @bind needs at least one VariableField`);
      }
    }
  }
  return out;
}

export interface BlobFieldEntry {
  message: string;
  field: string;
  id: number;
}

export function collectBlobFields(s: LoadedSchema): BlobFieldEntry[] {
  const out: BlobFieldEntry[] = [];
  for (const def of s.schema.definitions) {
    if (def.kind === "ENUM") continue;
    for (const f of def.fields) if (hasTag(s, def.name, f.name, "blob")) out.push({ message: def.name, field: f.name, id: f.value });
  }
  return out;
}

export interface NodeFieldEntry {
  id: number;
  name: string;
  kiwiType: string;
  isArray: boolean;
  flags: number;
}

export function collectNodeFields(s: LoadedSchema): NodeFieldEntry[] {
  const nc = s.byName.get("NodeChange");
  if (!nc) throw new Error("schema has no NodeChange");
  return nc.fields
    .filter((f) => !f.isDeprecated)
    .map((f) => ({ id: f.value, name: f.name, kiwiType: f.type ?? "", isArray: f.isArray, flags: fieldFlags(s, "NodeChange", f.name) }))
    .sort((a, b) => a.id - b.id);
}

export function collectDeprecated(s: LoadedSchema): Record<string, number[]> {
  const out: Record<string, number[]> = {};
  for (const def of s.schema.definitions) {
    const ids = def.fields.filter((f) => f.isDeprecated).map((f) => f.value);
    if (ids.length) out[def.name] = ids.sort((a, b) => a - b);
  }
  return out;
}

// ---------------------------------------------------------------------------------------------------------------------
// Checks (--check), docs/schema.md §2.2
// ---------------------------------------------------------------------------------------------------------------------

export interface CheckReport {
  problems: string[];
  /** Figma parity: definitions, fields and enum values compared */
  parityChecks: number;
  definitions: number;
  nodeChangeFields: number;
  liveNodeChangeFields: number;
  deprecatedFields: number;
}

/** Figma's schema embedded in a `.fig` (ZIP or bare canvas.fig): chunk 0, raw deflate or zstd. */
export function figmaSchemaFromFig(path: string): Schema {
  const file = readFileSync(path);
  let canvas: Uint8Array = file;
  if (file[0] === 0x50 && file[1] === 0x4b) {
    // ZIP: find canvas.fig through the central directory (local headers may carry zero sizes).
    let eocd = file.length - 22;
    while (eocd >= 0 && file.readUInt32LE(eocd) !== 0x06054b50) eocd--;
    const count = file.readUInt16LE(eocd + 10);
    let off = file.readUInt32LE(eocd + 16);
    let found: Uint8Array | null = null;
    for (let i = 0; i < count; i++) {
      const method = file.readUInt16LE(off + 10);
      const size = file.readUInt32LE(off + 20);
      const nameLen = file.readUInt16LE(off + 28);
      const extraLen = file.readUInt16LE(off + 30);
      const commentLen = file.readUInt16LE(off + 32);
      const local = file.readUInt32LE(off + 42);
      const name = file.toString("utf8", off + 46, off + 46 + nameLen);
      if (name === "canvas.fig") {
        const dataStart = local + 30 + file.readUInt16LE(local + 26) + file.readUInt16LE(local + 28);
        const data = file.subarray(dataStart, dataStart + size);
        found = method === 0 ? data : inflateRawSync(data);
      }
      off += 46 + nameLen + extraLen + commentLen;
    }
    if (!found) throw new Error(`${path}: no canvas.fig`);
    canvas = found;
  }
  const view = new DataView(canvas.buffer, canvas.byteOffset, canvas.byteLength);
  const len = view.getUint32(12, true);
  const chunk = canvas.subarray(16, 16 + len);
  const zstd = chunk[0] === 0x28 && chunk[1] === 0xb5 && chunk[2] === 0x2f && chunk[3] === 0xfd;
  return decodeBinarySchema(zstd ? zstdDecompressSync(chunk) : inflateRawSync(chunk));
}

function figmaDefs(figma: Schema[]): Map<string, Definition>[] {
  return figma.map((f) => new Map(f.definitions.map((d) => [d.name, d])));
}

/** Runs the four checks of docs/schema.md §2.2. `figma` = Figma's schemas to compare against (text + sample). */
export function checkSchema(s: LoadedSchema, figma: Schema[]): CheckReport {
  const problems: string[] = [...s.tags.problems];
  const figmaMaps = figmaDefs(figma);
  let parityChecks = 0;

  // 2. Figma parity + 3. own numbering.
  for (const def of s.schema.definitions) {
    const ownDef = defHasTag(s, def.name, "ours");
    const theirs = figmaMaps.map((m) => m.get(def.name)).filter((d): d is Definition => !!d);
    if (ownDef) {
      if (theirs.length) problems.push(`${def.name} is tagged @ours but Figma has a definition of that name`);
    } else {
      parityChecks++;
      if (!theirs.some((d) => d.kind === def.kind)) {
        problems.push(`${def.kind.toLowerCase()} ${def.name} is not in Figma's schemas (tag it @ours if it is ours)`);
        continue;
      }
    }
    const minOwn = def.name === "NodeChange" ? 1000 : 100;
    def.fields.forEach((f, index) => {
      if (f.isDeprecated) return;
      const ownField = ownDef || hasTag(s, def.name, f.name, "ours");
      if (ownField) {
        if (!ownDef) {
          // An own field (or enum value) inside a Figma-derived definition.
          if (f.value < minOwn && def.kind !== "STRUCT") problems.push(`${def.name}.${f.name} = ${f.value}: own numbers start at ${minOwn}`);
          if (def.kind === "STRUCT") problems.push(`${def.name}.${f.name}: structs never change (own field in a Figma struct)`);
          for (const t of theirs) {
            const clash = t.fields.find((g) => g.value === f.value && def.kind !== "STRUCT");
            if (clash) problems.push(`${def.name}.${f.name} = ${f.value}: Figma uses ${f.value} for ${clash.name}`);
            if (t.fields.some((g) => g.name === f.name)) problems.push(`${def.name}.${f.name} is tagged @ours but Figma has a field of that name`);
          }
        }
        return;
      }
      parityChecks++;
      const ok = theirs.some((t) => {
        if (t.kind !== def.kind) return false;
        if (def.kind === "ENUM") return t.fields.some((g) => g.name === f.name && g.value === f.value);
        if (def.kind === "STRUCT") {
          const g = t.fields[index];
          return !!g && g.name === f.name && g.type === f.type && g.isArray === f.isArray;
        }
        return t.fields.some((g) => g.name === f.name && g.value === f.value && g.type === f.type && g.isArray === f.isArray);
      });
      if (!ok) {
        const near = theirs.flatMap((t) => t.fields.filter((g) => g.name === f.name)).map((g) => `${g.type ?? "enum"}${g.isArray ? "[]" : ""} = ${g.value}`);
        problems.push(
          `${def.name}.${f.name} (${f.type ?? "enum"}${f.isArray ? "[]" : ""} = ${f.value}) does not match Figma${near.length ? ` (Figma: ${near.join(" / ")})` : " (not in Figma's schemas; tag it @ours if it is ours)"}`,
        );
      }
    });
    if (def.kind === "STRUCT" && !ownDef && theirs.length && !theirs.some((t) => t.fields.length === def.fields.length)) {
      problems.push(`struct ${def.name} has ${def.fields.length} fields; Figma's has ${theirs.map((t) => t.fields.length).join("/")} (structs never change)`);
    }
  }

  // 4. Tags.
  for (const [key, ann] of s.tags.fields) {
    const [defName, fieldName] = key.split(".");
    const def = s.byName.get(defName);
    const field = def?.fields.find((f) => f.name === fieldName);
    for (const t of ann.tags) {
      if (!(KNOWN_TAGS as readonly string[]).includes(t.name)) problems.push(`line ${ann.line}: unknown tag @${t.name} on ${key}`);
      if (NODECHANGE_ONLY.includes(t.name) && defName !== "NodeChange") problems.push(`line ${ann.line}: @${t.name} is only allowed on NodeChange fields (${key})`);
      if (t.name === "blob" && (field?.type !== "uint" || field.isArray || !fieldName.endsWith("Blob"))) problems.push(`${key}: @blob must be on a uint field named *Blob`);
      if (["derived", "nooverride", "own", "patch", "later", "ours", "blob"].includes(t.name) && t.args !== null) problems.push(`${key}: @${t.name} takes no arguments`);
      if (def?.kind === "ENUM" && !["later", "ours"].includes(t.name)) problems.push(`${key}: enum values may only carry @later or @ours`);
    }
  }
  for (const [name, ann] of s.tags.definitions) {
    for (const t of ann.tags) {
      if (!["later", "ours"].includes(t.name)) problems.push(`line ${ann.line}: definition ${name} may only carry @later or @ours (got @${t.name})`);
    }
  }
  // The `*Blob` naming rule and @blob agree (data.md §5.5 uses the name, the schema uses the tag).
  for (const def of s.schema.definitions) {
    if (def.kind === "ENUM") continue;
    for (const f of def.fields) {
      if (f.isDeprecated) continue;
      const tagged = hasTag(s, def.name, f.name, "blob");
      if (f.type === "uint" && !f.isArray && f.name.endsWith("Blob") && !tagged) problems.push(`${def.name}.${f.name}: a uint field named *Blob must carry @blob`);
    }
  }
  collectDefaults(s, problems);
  collectBindings(s, problems);

  if (s.tags.documentFormatVersion < 1) problems.push("DOCUMENT_FORMAT_VERSION must be >= 1");
  const nc = s.byName.get("NodeChange");
  return {
    problems,
    parityChecks,
    definitions: s.schema.definitions.length,
    nodeChangeFields: nc?.fields.length ?? 0,
    liveNodeChangeFields: nc?.fields.filter((f) => !f.isDeprecated).length ?? 0,
    deprecatedFields: s.schema.definitions.reduce((n, d) => n + d.fields.filter((f) => f.isDeprecated).length, 0),
  };
}

// ---------------------------------------------------------------------------------------------------------------------
// TypeScript output
// ---------------------------------------------------------------------------------------------------------------------

const BANNER = [
  "// GENERATED by engine/tools/schemagen from schema/document.kiwi. Do not edit: run `npm run engine:gen`.",
  "// kiwi-schema 0.5.0 compileSchemaTypeScript + compileSchemaJS, plus the field registry read from the schema's tags",
  "// (docs/schema.md §2.2). The codec is the one TS codec for renderer, main and store.",
];

function jsLiteral(v: unknown): string {
  return JSON.stringify(v);
}

function base64(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString("base64");
}

/** The JS codec as module code: kiwi's CommonJS-style `exports[...] = ...` assignments onto a local object. */
function codecModuleCode(schema: Schema): string {
  const js = compileSchemaJS(schema).split("\n");
  // compileSchemaJS (package null) starts with: `var exports = exports || {};` and the ByteBuffer require line.
  if (!js[0].startsWith("var exports") || !js[1].includes("ByteBuffer")) throw new Error("unexpected compileSchemaJS prologue");
  const body = js
    .slice(2)
    .map((line) => line.replace(/^exports\[/, "codec_["))
    .join("\n");
  if (/\bexports\b/.test(body.replace(/codec_\[/g, ""))) throw new Error("compileSchemaJS output still refers to `exports`");
  return ["const codec_: any = { ByteBuffer };", body].join("\n");
}

export function emitTypeScript(s: LoadedSchema): string {
  const nodeFields = collectNodeFields(s);
  const bindings = collectBindings(s);
  const defaults = collectDefaults(s);
  const blobFields = collectBlobFields(s);
  const deprecated = collectDeprecated(s);

  const defaultsByMessage: Record<string, Record<string, DefaultValue>> = {};
  for (const d of defaults) (defaultsByMessage[d.message] ??= {})[d.field] = d.value;

  const out: string[] = [];
  out.push("// @ts-nocheck", ...BANNER, "/* eslint-disable */", "");
  out.push('import { ByteBuffer } from "kiwi-schema";', "");
  out.push(`/** \`DOCUMENT_FORMAT_VERSION\` from the schema header: the u32 after "fig-kiwi" in every snapshot. */`);
  out.push(`export const DOCUMENT_FORMAT_VERSION = ${s.tags.documentFormatVersion};`, "");
  out.push(`/** SHA-1 (hex) of SCHEMA_BINARY: the store keeps every schema it wrote as Workspace/schemas/<sha1>.kiwi. */`);
  out.push(`export const SCHEMA_SHA1 = ${jsLiteral(s.sha1)};`, "");
  out.push("// ----- types (compileSchemaTypeScript) -----", "");
  out.push(compileSchemaTypeScript(s.schema).trimEnd(), "");
  out.push("// ----- codec (compileSchemaJS). Call as methods (codec.decodeMessage(bytes)): they use `this`. -----", "");
  out.push(codecModuleCode(s.schema));
  out.push("", "export const codec: Schema = codec_;", "");
  out.push("// ----- field registry (from the tags; same content as node_fields.h) -----", "");
  out.push(`export const FIELD_FLAGS = ${jsLiteral(FLAG_BITS)} as const;`, "");
  out.push("export interface NodeFieldInfo {", "  id: number;", "  name: keyof NodeChange & string;", "  kiwiType: string;", "  isArray: boolean;", "  flags: number;", "}", "");
  out.push("/** NodeChange's live fields by id: `flags` is a mask of FIELD_FLAGS. */");
  out.push("export const NODE_FIELDS: readonly NodeFieldInfo[] = [");
  for (const f of nodeFields) out.push(`  { id: ${f.id}, name: ${jsLiteral(f.name)}, kiwiType: ${jsLiteral(f.kiwiType)}, isArray: ${f.isArray}, flags: ${f.flags} },`);
  out.push("];", "");
  out.push("export interface BindingInfo {", "  variableField: VariableField;", "  field: keyof NodeChange & string;", "  fieldId: number;", "  component: string | null;", "}", "");
  out.push("/** `@bind` tags: which VariableField binds which NodeChange field (and struct component) through parameterConsumptionMap. */");
  out.push("export const BINDINGS: readonly BindingInfo[] = [");
  for (const b of bindings) out.push(`  { variableField: ${jsLiteral(b.variableField)}, field: ${jsLiteral(b.field)}, fieldId: ${b.fieldId}, component: ${jsLiteral(b.component)} },`);
  out.push("];", "");
  out.push("/** `@default` tags: what absence means when it is not the kiwi zero value (docs/schema.md §3.4). */");
  out.push(`export const DEFAULTS = ${JSON.stringify(defaultsByMessage, null, 2)} as const;`, "");
  out.push("/** `@blob` fields: uint indices into the enclosing Message's `blobs`. */");
  out.push(`export const BLOB_FIELDS: readonly { message: string; field: string; id: number }[] = ${jsLiteral(blobFields)};`, "");
  out.push("/** Field ids declared `[deprecated]` (reserved Figma numbers): decoded and dropped, never written. */");
  out.push(`export const DEPRECATED_FIELDS: Readonly<Record<string, readonly number[]>> = ${jsLiteral(deprecated)};`, "");
  out.push("function fromBase64(text: string): Uint8Array {");
  out.push("  const raw = atob(text);");
  out.push("  const bytes = new Uint8Array(raw.length);");
  out.push("  for (let i = 0; i < raw.length; i++) bytes[i] = raw.charCodeAt(i);");
  out.push("  return bytes;");
  out.push("}", "");
  out.push(`/** encodeBinarySchema(document.kiwi): ${s.binary.length} bytes. Chunk 0 of every snapshot (deflate-raw). */`);
  out.push(`export const SCHEMA_BINARY: Uint8Array = fromBase64(${jsLiteral(base64(s.binary))});`, "");
  return out.join("\n");
}

// ---------------------------------------------------------------------------------------------------------------------
// C++ output
// ---------------------------------------------------------------------------------------------------------------------

const CPP_KEYWORDS = new Set(
  "alignas alignof and and_eq asm auto bitand bitor bool break case catch char char8_t char16_t char32_t class compl concept const consteval constexpr constinit const_cast continue co_await co_return co_yield decltype default delete do double dynamic_cast else enum explicit export extern false float for friend goto if inline int long mutable namespace new noexcept not not_eq nullptr operator or or_eq private protected public register reinterpret_cast requires return short signed sizeof static static_assert static_cast struct switch template this thread_local throw true try typedef typeid typename union unsigned using virtual void volatile wchar_t while xor xor_eq".split(
    " ",
  ),
);
const cppName = (name: string) => (CPP_KEYWORDS.has(name) ? `${name}_` : name);

const CPP_SCALAR: Record<string, string> = { bool: "bool", byte: "uint8_t", int: "int32_t", uint: "uint32_t", float: "float", string: "const char*", int64: "int64_t", uint64: "uint64_t" };

function cppFloat(n: number): string {
  const t = Number.isInteger(n) ? `${n}.0` : String(n);
  return `${t}f`;
}

function cppValue(s: LoadedSchema, type: string, v: DefaultValue): string {
  if (type === "bool") return v ? "true" : "false";
  if (type === "float") return cppFloat(v as number);
  if (type === "string") return JSON.stringify(v);
  if (CPP_SCALAR[type]) return String(v);
  const def = s.byName.get(type);
  if (def?.kind === "ENUM") return `${type}::${v as string}`;
  if (def?.kind === "STRUCT") {
    const obj = v as { [k: string]: DefaultValue };
    return `{${def.fields.map((f) => cppValue(s, f.type ?? "", obj[f.name])).join(", ")}}`;
  }
  throw new Error(`no C++ value for ${type}`);
}

export function emitNodeFieldsHeader(s: LoadedSchema): string {
  const nodeFields = collectNodeFields(s);
  const bindings = collectBindings(s);
  const defaults = collectDefaults(s);
  const blobFields = collectBlobFields(s);
  const L: string[] = [];
  L.push(...BANNER, "// The NodeChange field registry, typed defaults and blob fields for the engine.", "");
  L.push("#pragma once", "", "#include <cstddef>", "#include <cstdint>", "", '#include "document.kiwi.h"', "", "namespace schema {", "");
  L.push(`inline constexpr uint32_t kDocumentFormatVersion = ${s.tags.documentFormatVersion};`, "");
  L.push("// Field id = kiwi field number of NodeChange.");
  L.push("enum class NodeField : uint16_t {");
  for (const f of nodeFields) L.push(`  ${cppName(f.name)} = ${f.id},`);
  L.push("};", "");
  L.push("namespace NodeFieldFlag {");
  for (const [name, bit] of Object.entries(FLAG_BITS)) L.push(`inline constexpr uint32_t ${name} = ${bit}u;`);
  L.push("}  // namespace NodeFieldFlag", "");
  L.push("struct NodeFieldInfo {", "  uint16_t id;", "  const char* name;", "  const char* kiwiType;", "  bool isArray;", "  uint32_t flags;", "};", "");
  const flagExpr = (flags: number) => {
    const names = Object.entries(FLAG_BITS)
      .filter(([, bit]) => flags & bit)
      .map(([n]) => `NodeFieldFlag::${n}`);
    return names.length ? names.join(" | ") : "0u";
  };
  L.push("inline constexpr NodeFieldInfo kNodeFields[] = {");
  for (const f of nodeFields) L.push(`    {${f.id}, ${JSON.stringify(f.name)}, ${JSON.stringify(f.kiwiType)}, ${f.isArray}, ${flagExpr(f.flags)}},`);
  L.push("};", `inline constexpr size_t kNodeFieldCount = ${nodeFields.length};`, "");
  L.push("struct BindingInfo {", "  VariableField variableField;", "  NodeField field;", "  const char* component;  // struct component bound (\"x\", \"family\"), or nullptr", "};", "");
  L.push("inline constexpr BindingInfo kBindings[] = {");
  for (const b of bindings) L.push(`    {VariableField::${b.variableField}, NodeField::${cppName(b.field)}, ${b.component ? JSON.stringify(b.component) : "nullptr"}},`);
  L.push("};", `inline constexpr size_t kBindingCount = ${bindings.length};`, "");
  // Typed constexpr defaults. Kiwi's struct classes are not literal types, so struct defaults use plain mirrors.
  const mirrors = new Set<string>();
  for (const d of defaults) if (s.byName.get(d.type)?.kind === "STRUCT") mirrors.add(d.type);
  for (const name of mirrors) {
    const def = s.byName.get(name)!;
    L.push(`struct Default${name} {`);
    for (const f of def.fields) {
      const t = CPP_SCALAR[f.type ?? ""] ?? f.type;
      L.push(`  ${t} ${cppName(f.name)};`);
    }
    L.push("};", "");
  }
  for (const d of defaults) {
    const def = s.byName.get(d.type);
    const t = CPP_SCALAR[d.type] ?? (def?.kind === "STRUCT" ? `Default${d.type}` : d.type);
    L.push(`inline constexpr ${t} kDefault_${d.message}_${d.field} = ${cppValue(s, d.type, d.value)};`);
  }
  L.push("");
  L.push("struct BlobFieldInfo {", "  const char* message;", "  const char* field;", "  uint32_t id;", "};", "");
  L.push("inline constexpr BlobFieldInfo kBlobFields[] = {");
  for (const b of blobFields) L.push(`    {${JSON.stringify(b.message)}, ${JSON.stringify(b.field)}, ${b.id}},`);
  L.push("};", `inline constexpr size_t kBlobFieldCount = ${blobFields.length};`, "");
  L.push("}  // namespace schema", "");
  return L.join("\n");
}

export function emitCpp(s: LoadedSchema): Record<string, string> {
  return {
    "document.kiwi.h": compileSchemaCPP({ ...s.schema, package: "schema" }),
    "document.stream.h": compileSchemaCallbackCPP({ ...s.schema, package: "schema_stream" }),
    "node_fields.h": emitNodeFieldsHeader(s),
  };
}

// ---------------------------------------------------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------------------------------------------------

function writeIfChanged(path: string, content: string): boolean {
  if (existsSync(path) && readFileSync(path, "utf8") === content) return false;
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, content);
  return true;
}

export function loadFigmaSchemas(): Schema[] {
  return [parseSchema(readFileSync(FIGMA_SCHEMA_TEXT, "utf8")), figmaSchemaFromFig(FIGMA_SAMPLE_FIG)];
}

function main(argv: string[]): number {
  const s = loadSchema();
  const check = argv.includes("--check");
  const cppAt = argv.indexOf("--cpp");
  if (cppAt >= 0) {
    const build = argv[cppAt + 1];
    if (!build) {
      console.error("schemagen: --cpp needs the build directory");
      return 2;
    }
    const dir = join(resolve(build), "generated/schema");
    for (const [name, content] of Object.entries(emitCpp(s))) if (writeIfChanged(join(dir, name), content)) console.log(`schemagen: wrote ${join(dir, name)}`);
  }
  const ts = emitTypeScript(s);
  if (check) {
    const report = checkSchema(s, loadFigmaSchemas());
    const tmp = mkdtempSync(join(tmpdir(), "schemagen-"));
    try {
      const fresh = join(tmp, "document.generated.ts");
      writeFileSync(fresh, ts);
      const committed = existsSync(TS_OUTPUT) ? readFileSync(TS_OUTPUT, "utf8") : null;
      if (committed !== readFileSync(fresh, "utf8")) report.problems.push(`${TS_OUTPUT} is stale: run \`npm run engine:gen\``);
      // The C++ outputs must at least generate (they are compiled by CMake, not committed).
      emitCpp(s);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
    console.log(
      `schemagen --check: ${report.definitions} definitions, NodeChange ${report.liveNodeChangeFields} live of ${report.nodeChangeFields} fields, ${report.deprecatedFields} reserved numbers, ${report.parityChecks} Figma parity checks, ${report.problems.length} problems`,
    );
    for (const p of report.problems) console.error(`  ✗ ${p}`);
    return report.problems.length ? 1 : 0;
  }
  if (cppAt < 0 || argv.includes("--ts")) {
    if (writeIfChanged(TS_OUTPUT, ts)) console.log(`schemagen: wrote ${TS_OUTPUT}`);
    else console.log("schemagen: TS output up to date");
  }
  return 0;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exitCode = main(process.argv.slice(2));
}

export type { Definition, Field, Schema };
