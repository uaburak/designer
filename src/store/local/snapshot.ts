/**
 * Snapshots and schemas on disk (docs/data.md §5.1, §5.8).
 *
 * A snapshot file is byte-identical to a `.fig`'s canvas.fig: prelude, DOCUMENT_FORMAT_VERSION, deflate-raw schema,
 * zstd(level 3) Message. Every schema a snapshot or journal was written with is kept as Workspace/schemas/<sha1>.kiwi,
 * so old data always decodes; data from another schema is converted to the current one before anyone sees it.
 */
import { promises as fsp } from "node:fs";
import { join } from "node:path";
import { decodeCanvas, encodeCanvas } from "../../shared/fig/container";
import { codec, DOCUMENT_FORMAT_VERSION, SCHEMA_BINARY, SCHEMA_SHA1, type Message } from "../../shared/schema/document.generated";
import { nodeCodecs, own } from "../kiwi/codecs";
import { decodeWithSchema, isCurrentSchema, sha1Hex } from "../kiwi/schemas";
import { atomicWrite, exists } from "./fsutil";

/** Encodes a snapshot container around a raw Message (current schema). */
export function encodeSnapshot(message: Uint8Array): Uint8Array {
  return encodeCanvas({ schema: SCHEMA_BINARY, message, version: DOCUMENT_FORMAT_VERSION, compression: "zstd", zstdLevel: 3 }, nodeCodecs);
}

export interface ReadSnapshot {
  /** Binary schema the snapshot was written with */
  schema: Uint8Array;
  schemaSha1: string;
  /** Raw Message as stored (in `schema`) */
  message: Uint8Array;
  version: number;
  /** Written with the current schema */
  current: boolean;
}

export function decodeSnapshotBytes(bytes: Uint8Array): ReadSnapshot {
  const c = decodeCanvas(bytes, nodeCodecs);
  const current = isCurrentSchema(c.schema);
  return { schema: c.schema, schemaSha1: current ? SCHEMA_SHA1 : sha1Hex(c.schema), message: c.message, version: c.version, current };
}

export async function readSnapshotFile(path: string): Promise<ReadSnapshot> {
  return decodeSnapshotBytes(new Uint8Array(await fsp.readFile(path)));
}

/** The snapshot Message in the current schema, as raw bytes (converted when it was written with another schema). */
export function currentMessageBytes(s: Pick<ReadSnapshot, "schema" | "message" | "current">): Uint8Array {
  if (s.current) return own(s.message);
  return codec.encodeMessage(decodeWithSchema(s.schema, s.message).message);
}

/** The snapshot Message decoded into the current schema. */
export function currentMessage(s: Pick<ReadSnapshot, "schema" | "message" | "current">): Message {
  if (s.current) return codec.decodeMessage(s.message);
  return decodeWithSchema(s.schema, s.message).message;
}

/** Workspace/schemas/<sha1>.kiwi: every binary schema stored data was written with. */
export class SchemaRegistry {
  private readonly cache = new Map<string, Uint8Array>([[SCHEMA_SHA1, SCHEMA_BINARY]]);

  constructor(
    readonly dir: string,
    private readonly tmpDir: string,
  ) {}

  /** Copies the current schema in (at start). */
  async ensureCurrent(): Promise<void> {
    await this.put(SCHEMA_BINARY, SCHEMA_SHA1);
  }

  async put(bytes: Uint8Array, sha1 = sha1Hex(bytes)): Promise<string> {
    const path = join(this.dir, `${sha1}.kiwi`);
    if (!(await exists(path))) await atomicWrite(this.tmpDir, path, bytes);
    this.cache.set(sha1, bytes);
    return sha1;
  }

  async get(sha1: string): Promise<Uint8Array> {
    let b = this.cache.get(sha1);
    if (!b) {
      b = new Uint8Array(await fsp.readFile(join(this.dir, `${sha1}.kiwi`)));
      if (sha1Hex(b) !== sha1) throw new Error(`schema ${sha1} is damaged`);
      this.cache.set(sha1, b);
    }
    return b;
  }
}
