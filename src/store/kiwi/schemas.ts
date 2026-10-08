/**
 * Schemas in the store (docs/data.md §5.8): the current schema goes through the generated codec; any other schema
 * (an older one of ours, Figma's) is compiled at runtime with kiwi-schema's `compileSchema` (store process only,
 * docs/schema.md §2.3) and its Message is projected onto ours by name (src/shared/fig/convert.ts).
 */
import { createHash } from "node:crypto";
import { compileSchema, decodeBinarySchema } from "kiwi-schema";
import { convertFigMessage, type ConvertOptions, type ImportReport } from "../../shared/fig/convert";
import { codec, SCHEMA_BINARY, SCHEMA_SHA1, type Message } from "../../shared/schema/document.generated";
import { SchemaModel } from "../../shared/schema/model";
import { bytesEqual } from "../../shared/schema/visit";

export const sha1Hex = (bytes: Uint8Array): string => createHash("sha1").update(bytes).digest("hex");

export interface CompiledSchema {
  sha1: string;
  bytes: Uint8Array;
  model: SchemaModel;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- kiwi-schema's compiled codec is untyped
  codec: any;
}

const cache = new Map<string, CompiledSchema>();

export function isCurrentSchema(bytes: Uint8Array): boolean {
  return bytes.length === SCHEMA_BINARY.length && bytesEqual(bytes, SCHEMA_BINARY);
}

/** Compiles (and caches by SHA-1) a binary schema. */
export function compiledSchema(bytes: Uint8Array, sha1 = sha1Hex(bytes)): CompiledSchema {
  let c = cache.get(sha1);
  if (!c) {
    const schema = decodeBinarySchema(bytes);
    c = { sha1, bytes, model: new SchemaModel(schema), codec: compileSchema(schema) };
    cache.set(sha1, c);
  }
  return c;
}

export interface DecodedAny {
  message: Message;
  /** False when the data was written with the current schema */
  converted: boolean;
  report: ImportReport | null;
}

/** Decodes a Message written with `schemaBytes` into the current schema (`opts.keepDerived`: a .fig import). */
export function decodeWithSchema(schemaBytes: Uint8Array, messageBytes: Uint8Array, opts: ConvertOptions = {}): DecodedAny {
  if (isCurrentSchema(schemaBytes)) return { message: codec.decodeMessage(messageBytes), converted: false, report: null };
  const c = compiledSchema(schemaBytes);
  const theirs = c.codec.decodeMessage(messageBytes);
  const { message, report } = convertFigMessage(theirs, c.model, undefined, opts);
  return { message, converted: true, report };
}

export { SCHEMA_BINARY, SCHEMA_SHA1 };
