/**
 * Import of a `.fig` (docs/data.md §11.1), Figma's or ours, as the content of a new file — the part shared by the
 * store (Node: zlib, node:crypto, kiwi-schema's compiled codecs) and the browser's dev store (DecompressionStream,
 * crypto.subtle, the CSP-safe interpreting codec):
 *
 *   ZIP or bare canvas.fig → prelude check (FigJam/Slides refused) → schema + Message → our schema (by name, with
 *   Figma's mappings) → GUIDs of sessions ≥ 2^20 remapped to the new file's first session → images keyed by the
 *   SHA-1 of their bytes, paints re-pointed when an image's name doesn't match → a normalized snapshot.
 */
import { decodeBinarySchema } from "kiwi-schema";
import { StoreError } from "../store/protocol";
import { codec, SCHEMA_BINARY, type Message, type NodeChange } from "../schema/document.generated";
import { GuidAllocator, guidKey, RESERVED_SESSION_LIMIT, type GUID } from "../schema/guid";
import { MODEL, SchemaModel } from "../schema/model";
import { NodeTable } from "../schema/patch";
import { interpretSchema } from "../schema/dynamic";
import { bytesEqual, fromHex, mapValue } from "../schema/visit";
import type { FigCodecs } from "./compression";
import { decodeCanvas, FigFormatError, type DecodedCanvas } from "./container";
import { convertFigMessage, type ImportReport } from "./convert";
import { readFigFile, type FigFile } from "./figFile";

/** A `.fig` is refused past this size (`too-large`). */
export const MAX_FIG_BYTES = 1024 * 1024 * 1024;

export interface PreparedImport {
  /** Raw snapshot Message, current schema */
  message: Uint8Array;
  name: string;
  thumbnail: Uint8Array | null;
  /** Image bytes by their SHA-1 (to put in the blob store) */
  images: Map<string, Uint8Array>;
  blobRefs: string[];
  /** null when the file was written with our current schema */
  report: ImportReport | null;
  /** Nodes whose GUIDs moved to the import session */
  remapped: number;
  nodes: number;
}

export interface FigImportDeps {
  /** Hex SHA-1 of bytes (synchronous: the browser precomputes, see prepareFigImportAsync) */
  sha1(bytes: Uint8Array): string;
  /** A Message written with `schema` → ours (default: the interpreting codec + convertFigMessage) */
  decode?(schema: Uint8Array, message: Uint8Array): { message: Message; report: ImportReport | null };
}

/** Decodes with any schema without `new Function` (CSP-safe) and converts to ours. */
export function decodeAnySchema(schema: Uint8Array, message: Uint8Array): { message: Message; report: ImportReport | null } {
  if (schema.length === SCHEMA_BINARY.length && bytesEqual(schema, SCHEMA_BINARY)) return { message: codec.decodeMessage(message), report: null };
  const parsed = decodeBinarySchema(schema);
  const theirs = interpretSchema(parsed).decode("Message", message);
  return convertFigMessage(theirs, new SchemaModel(parsed));
}

/** Remaps every GUID value with sessionID ≥ 2^20 (consistently, everywhere it appears) to `sessionID`. */
export function remapSessions(message: Message, sessionID: number): { message: Message; remapped: number } {
  const alloc = new GuidAllocator(sessionID);
  const map = new Map<string, GUID>();
  const targets = new Set(["GUID"]);
  const remap = (g: GUID): GUID => {
    if (g.sessionID < RESERVED_SESSION_LIMIT) return g;
    const k = guidKey(g);
    let to = map.get(k);
    if (!to) map.set(k, (to = alloc.next()));
    return to;
  };
  // Allocate in node order first, so node GUIDs get the low, stable localIDs.
  for (const n of message.nodeChanges ?? []) if (n.guid) remap(n.guid);
  const nodeChanges = (message.nodeChanges ?? []).map((n) => mapValue(MODEL, "NodeChange", n, targets, (_d, g) => remap(g)) as NodeChange);
  return { message: { ...message, nodeChanges }, remapped: map.size };
}

/** Re-points `Image.hash` values from one hash to another (an image whose bytes do not match its name). */
function rehashImages(message: Message, renames: Map<string, string>): Message {
  if (!renames.size) return message;
  const pairs = [...renames].map(([from, to]) => [fromHex(from), fromHex(to)] as const);
  const targets = new Set(["Image"]);
  const nodeChanges = (message.nodeChanges ?? []).map(
    (n) =>
      mapValue(MODEL, "NodeChange", n, targets, (_d, img) => {
        if (!(img.hash instanceof Uint8Array)) return img;
        const hit = pairs.find(([from]) => bytesEqual(from, img.hash));
        return hit ? { ...img, hash: hit[1] } : img;
      }) as NodeChange,
  );
  return { ...message, nodeChanges };
}

/** "My design.fig" → "My design" (a dropped file's name, or a path's last part). */
export function figBaseName(name: string): string {
  const last = name.split(/[\\/]/).pop() ?? "";
  return last.replace(/\.fig$/i, "").trim();
}

function toStoreError(e: unknown): never {
  if (e instanceof StoreError) throw e;
  if (e instanceof FigFormatError) throw new StoreError(e.code, e.message);
  throw new StoreError("unsupported-format", `This file couldn't be imported: ${(e as Error).message}`);
}

/** The container step: ZIP entries and the canvas chunks, decompressed. */
export function readFigContainer(bytes: Uint8Array, codecs: FigCodecs): { file: FigFile; canvas: DecodedCanvas } {
  if (!(bytes instanceof Uint8Array) || !bytes.length) throw new StoreError("unsupported-format", "This isn't a .fig file");
  if (bytes.length > MAX_FIG_BYTES) throw new StoreError("too-large", "This file is too large to import");
  try {
    const file = readFigFile(bytes, codecs);
    return { file, canvas: decodeCanvas(file.canvas, codecs) };
  } catch (e) {
    return toStoreError(e);
  }
}

/**
 * The rest, given the container: decode, convert, remap, images, snapshot. `name` is used when the file's meta.json
 * has no `file_name` (a bare canvas.fig): a file name or path, ".fig" dropped.
 */
export function prepareFromContainer(c: { file: FigFile; canvas: DecodedCanvas }, opts: { name: string; sessionID: number }, deps: FigImportDeps): PreparedImport {
  let decoded;
  try {
    decoded = (deps.decode ?? decodeAnySchema)(c.canvas.schema, c.canvas.message);
  } catch (e) {
    throw new StoreError("corrupt", `This file couldn't be read: ${(e as Error).message}`);
  }
  const { message: remapped, remapped: count } = remapSessions(decoded.message, opts.sessionID);
  const images = new Map<string, Uint8Array>();
  const renames = new Map<string, string>();
  for (const [name, data] of c.file.images) {
    const sha1 = deps.sha1(data);
    images.set(sha1, data);
    if (/^[0-9a-f]{40}$/.test(name) && name !== sha1) renames.set(name, sha1);
  }
  const message = rehashImages(remapped, renames);
  const table = NodeTable.fromMessage(message);
  if (!table.get("0:0")) throw new StoreError("corrupt", "This file has no document");
  const fileName = c.file.meta?.file_name;
  const name = (typeof fileName === "string" && fileName.trim()) || figBaseName(opts.name) || "Untitled";
  return {
    message: codec.encodeMessage(table.toMessage()),
    name,
    thumbnail: c.file.thumbnail,
    images,
    blobRefs: [...table.imageHashes()].sort(),
    report: decoded.report,
    remapped: count,
    nodes: table.size,
  };
}

/** Everything at once, with synchronous codecs (the store). */
export function prepareFigImport(bytes: Uint8Array, opts: { name: string; sessionID: number }, codecs: FigCodecs, deps: FigImportDeps): PreparedImport {
  return prepareFromContainer(readFigContainer(bytes, codecs), opts, deps);
}

export interface AsyncFigCodecs {
  inflateRaw(data: Uint8Array): Promise<Uint8Array> | Uint8Array;
  /** Without it, files whose data chunk is zstd (most of Figma's newer files) are refused as `unsupported-format` */
  zstdDecompress?(data: Uint8Array): Promise<Uint8Array> | Uint8Array;
  sha1(bytes: Uint8Array): Promise<string> | string;
}

class Need {
  constructor(
    readonly kind: "inflate" | "zstd",
    readonly data: Uint8Array,
  ) {}
}

/** A cheap content key for the decompression cache (collisions are confirmed byte by byte). */
function keyOf(b: Uint8Array): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < b.length; i += Math.max(1, b.length >> 12)) h = Math.imul(h ^ b[i], 0x01000193);
  return `${b.length}:${h >>> 0}`;
}

/**
 * The same import with asynchronous codecs (the browser has only DecompressionStream and crypto.subtle): the
 * container step runs again for every chunk it needs decompressed (a handful), then image hashes are computed up
 * front and the rest runs synchronously.
 */
export async function prepareFigImportAsync(bytes: Uint8Array, opts: { name: string; sessionID: number }, codecs: AsyncFigCodecs, decode?: FigImportDeps["decode"]): Promise<PreparedImport> {
  const cache = new Map<string, { data: Uint8Array; out: Uint8Array }[]>();
  // decodeCanvas wraps codec errors in a FigFormatError, so the missing piece is also recorded here.
  let pending: Need | null = null;
  const lookup = (kind: Need["kind"], data: Uint8Array): Uint8Array => {
    const hit = cache.get(`${kind}:${keyOf(data)}`)?.find((e) => bytesEqual(e.data, data));
    if (hit) return hit.out;
    throw (pending = new Need(kind, data));
  };
  const sync: FigCodecs = {
    inflateRaw: (d) => lookup("inflate", d),
    deflateRaw: () => {
      throw new Error("not needed to import");
    },
    zstdDecompress: (d) => lookup("zstd", d),
  };
  let container: { file: FigFile; canvas: DecodedCanvas } | null = null;
  for (let round = 0; !container; round++) {
    if (round > 64) throw new StoreError("corrupt", "This file has too many compressed parts");
    try {
      const file = readFigFile(bytes, sync);
      container = { file, canvas: decodeCanvas(file.canvas, sync) };
    } catch (e) {
      const need: Need | null = e instanceof Need ? e : pending;
      pending = null;
      if (!need) {
        if (bytes.length > MAX_FIG_BYTES) throw new StoreError("too-large", "This file is too large to import");
        toStoreError(e);
      }
      if (need.kind === "zstd" && !codecs.zstdDecompress) throw new StoreError("unsupported-format", "This file is compressed with zstd, which this build can't read here; import it in the desktop app");
      let out: Uint8Array;
      try {
        out = await (need.kind === "inflate" ? codecs.inflateRaw(need.data) : codecs.zstdDecompress!(need.data));
      } catch (err) {
        throw new StoreError("corrupt", `This file couldn't be read: ${(err as Error).message}`);
      }
      const k = `${need.kind}:${keyOf(need.data)}`;
      cache.set(k, [...(cache.get(k) ?? []), { data: need.data, out }]);
    }
  }
  const hashes = new Map<Uint8Array, string>();
  for (const data of container.file.images.values()) hashes.set(data, await codecs.sha1(data));
  return prepareFromContainer(container, opts, {
    sha1: (b) => {
      const h = hashes.get(b);
      if (!h) throw new Error("an image hash wasn't precomputed");
      return h;
    },
    decode,
  });
}
