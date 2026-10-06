/**
 * The compaction merge (docs/data.md §5.5): decode the head snapshot, then every frame after it, each with the schema
 * it was written with (converted to the current one), merge them with the generic patch model, and encode a new
 * snapshot (DOCUMENT first, parents before children). Pure with respect to the file: it only reads, and the caller
 * writes the result atomically. Runs inline or in the compactor worker (compactor.ts).
 */
import { promises as fsp } from "node:fs";
import { join } from "node:path";
import { codec, SCHEMA_SHA1 } from "../../shared/schema/document.generated";
import { NodeTable } from "../../shared/schema/patch";
import { nodeCodecs } from "../kiwi/codecs";
import { decodeWithSchema, sha1Hex } from "../kiwi/schemas";
import { scanSegment } from "./journal";
import { currentMessage, encodeSnapshot, readSnapshotFile } from "./snapshot";

export interface CompactInput {
  snapshotPath: string;
  snapshotSeq: number;
  /** Closed segments holding the frames after snapshotSeq, in order */
  segmentPaths: string[];
  /** Workspace/schemas */
  schemasDir: string;
  /** Last seq to include */
  upTo: number;
}

export interface CompactOutput {
  /** The new snapshot file's bytes (container) */
  snapshot: Uint8Array;
  /** Image hashes the merged document references: the exact blobRefs (§10.3) */
  blobRefs: string[];
  nodes: number;
  frames: number;
  /** Updates of nodes that did not exist, and other merge anomalies (logged) */
  anomalies: { missing: number; invalidClears: number; badBlobRefs: number };
}

async function schemaBytes(schemasDir: string, sha1: string, cache: Map<string, Uint8Array>): Promise<Uint8Array | null> {
  if (sha1 === SCHEMA_SHA1) return null;
  let b = cache.get(sha1);
  if (!b) {
    b = new Uint8Array(await fsp.readFile(join(schemasDir, `${sha1}.kiwi`)));
    if (sha1Hex(b) !== sha1) throw new Error(`schema ${sha1} is damaged`);
    cache.set(sha1, b);
  }
  return b;
}

export async function compactFiles(input: CompactInput): Promise<CompactOutput> {
  const snap = await readSnapshotFile(input.snapshotPath);
  const table = NodeTable.fromMessage(currentMessage(snap));
  const schemas = new Map<string, Uint8Array>();
  let expect = input.snapshotSeq + 1;
  let frames = 0;
  const anomalies = { missing: 0, invalidClears: 0, badBlobRefs: 0 };
  for (const path of input.segmentPaths) {
    if (expect > input.upTo) break;
    const scan = scanSegment(new Uint8Array(await fsp.readFile(path)), nodeCodecs.inflateRaw, expect);
    const foreign = await schemaBytes(input.schemasDir, scan.header.schemaSha1, schemas);
    for (const f of scan.frames) {
      if (f.seq > input.upTo) break;
      const message = foreign ? decodeWithSchema(foreign, f.message).message : codec.decodeMessage(f.message);
      const r = table.apply(message);
      anomalies.missing += r.missing.length;
      anomalies.invalidClears += r.invalidClears;
      anomalies.badBlobRefs += r.badBlobRefs;
      expect = f.seq + 1;
      frames++;
    }
    if (scan.badBytes && expect <= input.upTo) throw new Error(`segment ${path} is damaged before seq ${input.upTo}`);
  }
  if (expect <= input.upTo) throw new Error(`frames ${expect}..${input.upTo} are missing`);
  const message = codec.encodeMessage(table.toMessage());
  return { snapshot: encodeSnapshot(message), blobRefs: [...table.imageHashes()].sort(), nodes: table.size, frames, anomalies };
}
