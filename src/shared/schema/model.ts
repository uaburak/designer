/**
 * A runtime view of a kiwi schema: definitions by name, fields by name and id, and the type-graph facts the generic
 * code needs (which definitions can contain blob-index fields, GUIDs or images). Built without `new Function`, so it
 * works in the renderer (CSP) as well as in the store.
 *
 * `MODEL` is our schema (document.kiwi). `modelFromBinary()` builds one for any binary schema (an older one of ours,
 * or Figma's); binary schemas do not record `[deprecated]`, so foreign models treat every field as live.
 */
import { decodeBinarySchema, type Schema as KiwiSchema } from "kiwi-schema";
import { BLOB_FIELDS, DEPRECATED_FIELDS, SCHEMA_BINARY } from "./document.generated";

export const NATIVE_TYPES: ReadonlySet<string> = new Set(["bool", "byte", "int", "uint", "float", "string", "int64", "uint64"]);

export interface FieldDef {
  name: string;
  /** Native type name, definition name, or null for enum values */
  type: string | null;
  isArray: boolean;
  /** Field id (messages), position from 1 (structs), or the enum value */
  value: number;
  deprecated: boolean;
}

export interface DefDef {
  name: string;
  kind: "ENUM" | "STRUCT" | "MESSAGE";
  /** Live fields, in declaration order */
  fields: FieldDef[];
  byName: Map<string, FieldDef>;
  byId: Map<number, FieldDef>;
  /** ENUM: value → name */
  enumNames: Map<number, string>;
}

export class SchemaModel {
  readonly defs = new Map<string, DefDef>();
  /** "Def.field" keys of blob-index fields */
  readonly blobFields: ReadonlySet<string>;
  private readonly reachCache = new Map<string, Set<string>>();

  constructor(schema: KiwiSchema, deprecated: Readonly<Record<string, readonly number[]>> = {}, blobFields?: Iterable<string>) {
    for (const d of schema.definitions) {
      const dead = new Set(deprecated[d.name] ?? []);
      const fields: FieldDef[] = d.fields.map((f) => ({
        name: f.name,
        type: d.kind === "ENUM" ? null : (f.type as string),
        isArray: f.isArray,
        value: f.value,
        deprecated: f.isDeprecated || (d.kind !== "ENUM" && dead.has(f.value)),
      }));
      const live = fields.filter((f) => !f.deprecated);
      this.defs.set(d.name, {
        name: d.name,
        kind: d.kind,
        fields: live,
        byName: new Map(live.map((f) => [f.name, f])),
        byId: new Map(fields.map((f) => [f.value, f])),
        enumNames: new Map(d.kind === "ENUM" ? fields.map((f) => [f.value, f.name]) : []),
      });
    }
    if (blobFields) this.blobFields = new Set(blobFields);
    else {
      // data.md §5.5: a blob-index field is any uint field, at any depth, whose name ends in "Blob".
      const found = new Set<string>();
      for (const d of this.defs.values()) for (const f of d.fields) if (f.type === "uint" && !f.isArray && f.name.endsWith("Blob")) found.add(`${d.name}.${f.name}`);
      this.blobFields = found;
    }
  }

  def(name: string): DefDef {
    const d = this.defs.get(name);
    if (!d) throw new Error(`schema has no definition ${name}`);
    return d;
  }

  has(name: string): boolean {
    return this.defs.has(name);
  }

  isBlobField(def: string, field: string): boolean {
    return this.blobFields.has(`${def}.${field}`);
  }

  /** Every definition reachable from `name` through field types (including itself). */
  reach(name: string): Set<string> {
    let r = this.reachCache.get(name);
    if (r) return r;
    r = new Set<string>();
    const stack = [name];
    while (stack.length) {
      const n = stack.pop()!;
      if (r.has(n)) continue;
      const d = this.defs.get(n);
      if (!d) continue;
      r.add(n);
      if (d.kind === "ENUM") continue;
      for (const f of d.fields) if (f.type && !NATIVE_TYPES.has(f.type)) stack.push(f.type);
    }
    this.reachCache.set(name, r);
    return r;
  }

  /** True when a value of type `type` can (transitively) contain a value of one of `targets`. */
  canContain(type: string, targets: ReadonlySet<string>): boolean {
    if (NATIVE_TYPES.has(type)) return false;
    for (const t of this.reach(type)) if (targets.has(t)) return true;
    return false;
  }

  /** Definitions that own at least one blob-index field. */
  blobOwners(): Set<string> {
    const owners = new Set<string>();
    for (const key of this.blobFields) owners.add(key.slice(0, key.indexOf(".")));
    return owners;
  }
}

export function modelFromBinary(binarySchema: Uint8Array): SchemaModel {
  return new SchemaModel(decodeBinarySchema(binarySchema));
}

/** Our schema (document.kiwi). */
export const MODEL = new SchemaModel(
  decodeBinarySchema(SCHEMA_BINARY),
  DEPRECATED_FIELDS,
  BLOB_FIELDS.map((b) => `${b.message}.${b.field}`),
);
