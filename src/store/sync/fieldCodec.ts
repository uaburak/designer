/**
 * Node documents (docs/data.md §12.4, docs/schema.md §11.2): `files/{fileKey}/nodes/{s:l}` holds one field per
 * top-level NodeChange property, named as in the schema.
 *
 *   bool → boolean · byte/int/uint/float → number · int64/uint64 → decimal string · string → string
 *   enum → the value's name · struct/message → map of schema field names · T[] → array · GUID → "s:l"
 *   byte[] and blob-index fields (`*Blob`) → {"$b": Bytes} up to 256 KB, else {"$blob": sha1} (bytes in Storage)
 *
 * `@derived` fields never reach Firestore (rejected here as a safety net). A value nested deeper than 20 levels, or
 * the largest fields of a document over 900 KB, spill whole to Storage as {"$kiwi": sha1}: a kiwi Message holding one
 * partial NodeChange with just that field (and its blobs), so the generated codec reads it back.
 */
import { codec, type Message, type NodeChange } from "../../shared/schema/document.generated";
import { guidKey, parseGuid } from "../../shared/schema/guid";
import { MODEL, NATIVE_TYPES, type SchemaModel } from "../../shared/schema/model";
import { DERIVED_FIELDS, rebaseBlobIndices } from "../../shared/schema/patch";

/* eslint-disable @typescript-eslint/no-explicit-any -- Firestore values are dynamically shaped by the schema */

export const INLINE_BYTES_LIMIT = 256 * 1024;
export const DOCUMENT_LIMIT = 900 * 1024;
export const MAX_DEPTH = 20;
/** Fields that are the document's identity or patch-only, never stored as fields */
const NOT_STORED = new Set(["guid", "phase", "clearedFields"]);

/** Firestore's Bytes type, injected (the SDK's `Bytes.fromUint8Array`, or plain arrays in tests). */
export interface BytesCodec {
  wrap(bytes: Uint8Array): unknown;
  unwrap(value: unknown): Uint8Array;
}

export const plainBytes: BytesCodec = {
  wrap: (b) => b.slice(),
  unwrap: (v) => (v instanceof Uint8Array ? v : new Uint8Array(v as ArrayLike<number>)),
};

export interface EncodeContext {
  bytes: BytesCodec;
  /** Bytes of a blob index of the Message the node came from */
  blob(index: number): Uint8Array | undefined;
  /** Stores bytes at Storage blobs/<sha1> (uploaded before the document) and returns the sha1 */
  spill(bytes: Uint8Array): string;
  model?: SchemaModel;
}

export interface DecodeContext {
  bytes: BytesCodec;
  /** Bytes of Storage blobs/<sha1> (fetched beforehand) */
  fetch(sha1: string): Uint8Array;
  model?: SchemaModel;
}

class TooDeep extends Error {}

function encodeValue(m: SchemaModel, type: string, isArray: boolean, v: any, ctx: EncodeContext, depth: number, owner: string, field: string): unknown {
  if (depth > MAX_DEPTH) throw new TooDeep();
  if (isArray) {
    if (type === "byte") return encodeBytes(v as Uint8Array, ctx);
    return (v as any[]).map((e) => encodeValue(m, type, false, e, ctx, depth + 1, owner, field));
  }
  if (m.isBlobField(owner, field)) {
    const b = ctx.blob(v as number);
    if (!b) throw new Error(`${owner}.${field}: blob ${v} is missing`);
    return encodeBytes(b, ctx);
  }
  switch (type) {
    case "bool":
    case "byte":
    case "int":
    case "uint":
    case "float":
    case "string":
      return v;
    case "int64":
    case "uint64":
      return String(v);
  }
  if (type === "GUID") return guidKey(v);
  const d = m.def(type);
  if (d.kind === "ENUM") return v;
  const out: Record<string, unknown> = {};
  for (const key in v) {
    const f = d.byName.get(key);
    if (!f || v[key] === undefined) continue;
    out[key] = encodeValue(m, f.type ?? "", f.isArray, v[key], ctx, depth + 1, type, key);
  }
  return out;
}

function encodeBytes(b: Uint8Array, ctx: EncodeContext): unknown {
  if (b.length <= INLINE_BYTES_LIMIT) return { $b: ctx.bytes.wrap(b) };
  return { $blob: ctx.spill(b) };
}

/** A whole top-level field as a kiwi Message in Storage. */
function spillField(node: NodeChange, field: string, ctx: EncodeContext, m: SchemaModel): unknown {
  const blobs: { bytes: Uint8Array }[] = [];
  const map = new Map<number, number>();
  const partial = rebaseBlobIndices(m, { guid: node.guid, [field]: (node as any)[field] } as NodeChange, (i) => {
    let j = map.get(i);
    if (j === undefined) {
      j = blobs.push({ bytes: ctx.blob(i) ?? new Uint8Array(0) }) - 1;
      map.set(i, j);
    }
    return j;
  });
  const msg: Message = { type: "NODE_CHANGES", sessionID: 0, ackID: 0, nodeChanges: [partial], blobs };
  return { $kiwi: ctx.spill(codec.encodeMessage(msg)) };
}

function approxSize(v: unknown): number {
  if (v === null || v === undefined) return 1;
  if (typeof v === "string") return v.length + 1;
  if (typeof v === "number" || typeof v === "boolean") return 8;
  if (v instanceof Uint8Array) return v.length;
  if (Array.isArray(v)) return v.reduce((n, e) => n + approxSize(e), 0);
  if (typeof v === "object") {
    let n = 0;
    for (const [k, x] of Object.entries(v as Record<string, unknown>)) n += k.length + 1 + approxSize(x);
    return n;
  }
  return 8;
}

/** NodeChange (a merged node, or the carried fields of a change) → node document fields (no sync metadata). */
export function encodeNodeFields(node: NodeChange, ctx: EncodeContext, only?: Iterable<string>): Record<string, unknown> {
  const m = ctx.model ?? MODEL;
  const nc = m.def("NodeChange");
  const out: Record<string, unknown> = {};
  const fields = only ? [...only] : Object.keys(node);
  for (const key of fields) {
    const v = (node as any)[key];
    if (v === undefined || NOT_STORED.has(key)) continue;
    if (DERIVED_FIELDS.has(key)) throw new Error(`derived field ${key} never reaches Firestore`);
    const f = nc.byName.get(key);
    if (!f) throw new Error(`NodeChange has no field ${key}`);
    try {
      out[key] = encodeValue(m, f.type ?? "", f.isArray, v, ctx, 1, "NodeChange", key);
    } catch (e) {
      if (!(e instanceof TooDeep)) throw e;
      out[key] = spillField(node, key, ctx, m);
    }
  }
  // Over 900 KB: spill the largest fields until the document fits.
  let size = approxSize(out);
  while (size > DOCUMENT_LIMIT) {
    const [biggest] = Object.entries(out)
      .filter(([, v]) => !(v && typeof v === "object" && "$kiwi" in (v as object)))
      .sort((a, b) => approxSize(b[1]) - approxSize(a[1]));
    if (!biggest) break;
    out[biggest[0]] = spillField(node, biggest[0], ctx, m);
    size = approxSize(out);
  }
  return out;
}

function decodeValue(m: SchemaModel, type: string, isArray: boolean, v: any, ctx: DecodeContext, blobs: Uint8Array[], owner: string, field: string): unknown {
  if (isArray) {
    if (type === "byte") return decodeBytes(v, ctx);
    return (v as any[]).map((e) => decodeValue(m, type, false, e, ctx, blobs, owner, field));
  }
  if (m.isBlobField(owner, field)) return blobs.push(decodeBytes(v, ctx)) - 1;
  if (NATIVE_TYPES.has(type)) return type === "int64" || type === "uint64" ? BigInt(v as string) : v;
  if (type === "GUID") return parseGuid(v as string);
  const d = m.def(type);
  if (d.kind === "ENUM") return v;
  const out: Record<string, unknown> = {};
  for (const key in v) {
    const f = d.byName.get(key);
    if (!f) continue;
    out[key] = decodeValue(m, f.type ?? "", f.isArray, v[key], ctx, blobs, type, key);
  }
  return out;
}

function decodeBytes(v: any, ctx: DecodeContext): Uint8Array {
  if (v && typeof v === "object" && "$b" in v) return ctx.bytes.unwrap(v.$b);
  if (v && typeof v === "object" && "$blob" in v) return ctx.fetch(v.$blob as string);
  throw new Error("not a bytes value");
}

/** Node document → a NodeChange (all its stored fields) and the blobs its blob-index fields point at. */
export function decodeNodeFields(guid: string, doc: Record<string, unknown>, ctx: DecodeContext): { node: NodeChange; blobs: Uint8Array[] } {
  const m = ctx.model ?? MODEL;
  const nc = m.def("NodeChange");
  const blobs: Uint8Array[] = [];
  const node: any = { guid: parseGuid(guid) };
  for (const [key, v] of Object.entries(doc)) {
    if (key.startsWith("_") || v === undefined || v === null) continue;
    const f = nc.byName.get(key);
    if (!f) continue;
    if (v && typeof v === "object" && "$kiwi" in (v as object)) {
      const msg = codec.decodeMessage(ctx.fetch((v as { $kiwi: string }).$kiwi));
      const part = msg.nodeChanges?.[0] as any;
      if (!part || part[key] === undefined) continue;
      const base = blobs.length;
      for (const b of msg.blobs ?? []) blobs.push(b.bytes);
      node[key] = (rebaseBlobIndices(m, { [key]: part[key] } as NodeChange, (i) => base + i) as any)[key];
      continue;
    }
    node[key] = decodeValue(m, f.type ?? "", f.isArray, v, ctx, blobs, "NodeChange", key);
  }
  return { node, blobs };
}
