/**
 * Import of a `.fig` (docs/data.md §11.1), Figma's or ours, as the content of a new file:
 *   ZIP or bare canvas.fig → prelude check (FigJam/Slides refused) → schema + Message → our schema (by name, with
 *   Figma's mappings) → GUIDs of sessions ≥ 2^20 remapped to the new file's first session → images stored in the blob
 *   store, paints re-pointed when an image's bytes do not hash to its name → a normalized snapshot.
 */
import { basename, extname } from "node:path";
import { decodeCanvas, FigFormatError } from "../../shared/fig/container";
import type { ImportReport } from "../../shared/fig/convert";
import { readFigFile } from "../../shared/fig/figFile";
import { codec, type Message, type NodeChange } from "../../shared/schema/document.generated";
import { GuidAllocator, guidKey, RESERVED_SESSION_LIMIT, type GUID } from "../../shared/schema/guid";
import { MODEL } from "../../shared/schema/model";
import { NodeTable } from "../../shared/schema/patch";
import { bytesEqual, fromHex, mapValue } from "../../shared/schema/visit";
import { StoreError } from "../../shared/store/protocol";
import { nodeCodecs } from "../kiwi/codecs";
import { decodeWithSchema, sha1Hex } from "../kiwi/schemas";

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

export function prepareFigImport(bytes: Uint8Array, opts: { path: string; sessionID: number }): PreparedImport {
  let file;
  let canvas;
  try {
    file = readFigFile(bytes, nodeCodecs);
    canvas = decodeCanvas(file.canvas, nodeCodecs);
  } catch (e) {
    if (e instanceof FigFormatError) throw new StoreError(e.code, e.message);
    throw new StoreError("unsupported-format", `This file couldn't be imported: ${(e as Error).message}`);
  }
  let decoded;
  try {
    decoded = decodeWithSchema(canvas.schema, canvas.message);
  } catch (e) {
    throw new StoreError("corrupt", `This file couldn't be read: ${(e as Error).message}`);
  }
  let message = decoded.message;
  const { message: remapped, remapped: count } = remapSessions(message, opts.sessionID);
  message = remapped;

  // Images: stored by the SHA-1 of their bytes; a name that does not match is rewritten in the paints.
  const images = new Map<string, Uint8Array>();
  const renames = new Map<string, string>();
  for (const [name, data] of file.images) {
    const sha1 = sha1Hex(data);
    images.set(sha1, data);
    if (/^[0-9a-f]{40}$/.test(name) && name !== sha1) renames.set(name, sha1);
  }
  message = rehashImages(message, renames);

  const table = NodeTable.fromMessage(message);
  if (!table.get("0:0")) throw new StoreError("corrupt", "This file has no document");
  const snapshot = table.toMessage();
  const name = (typeof file.meta?.file_name === "string" && file.meta.file_name.trim()) || basename(opts.path, extname(opts.path)) || "Untitled";
  return {
    message: codec.encodeMessage(snapshot),
    name,
    thumbnail: file.thumbnail,
    images,
    blobRefs: [...table.imageHashes()].sort(),
    report: decoded.report,
    remapped: count,
    nodes: table.size,
  };
}
