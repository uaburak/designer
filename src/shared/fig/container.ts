/**
 * The `canvas.fig` container (docs/data.md §5.1, docs/schema.md §11.1), the byte layout of every snapshot, version,
 * library payload, clipboard archive and preview document:
 *
 *   0   8  prelude "fig-kiwi"
 *   8   4  u32 LE version (DOCUMENT_FORMAT_VERSION for ours; Figma's are 15..106)
 *   12  4  u32 LE length L0, then L0 bytes: deflate-raw(binary kiwi schema)
 *   …   4  u32 LE length L1, then L1 bytes: zstd or deflate-raw (kiwi Message)
 *
 * Readers accept chunk 1 as zstd (magic 28 B5 2F FD) or deflate-raw.
 */
import { compressChunk, decompressChunk, type ChunkCompression, type FigCodecs } from "./compression";

export const PRELUDE_DESIGN = "fig-kiwi";
export const PRELUDE_FIGJAM = "fig-jam.";
export const PRELUDE_SLIDES = "fig-deck";

export class FigFormatError extends Error {
  constructor(
    readonly code: "unsupported-format" | "corrupt",
    message: string,
  ) {
    super(message);
    this.name = "FigFormatError";
  }
}

export interface CanvasChunks {
  prelude: string;
  version: number;
  chunks: Uint8Array[];
}

const ascii = (b: Uint8Array) => String.fromCharCode(...b);

export function readCanvasChunks(bytes: Uint8Array): CanvasChunks {
  if (bytes.length < 12) throw new FigFormatError("corrupt", "not a fig container (too short)");
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const prelude = ascii(bytes.subarray(0, 8));
  const version = view.getUint32(8, true);
  const chunks: Uint8Array[] = [];
  let off = 12;
  while (off < bytes.length) {
    if (off + 4 > bytes.length) throw new FigFormatError("corrupt", "truncated chunk header");
    const n = view.getUint32(off, true);
    off += 4;
    if (off + n > bytes.length) throw new FigFormatError("corrupt", "truncated chunk");
    chunks.push(bytes.subarray(off, off + n));
    off += n;
  }
  return { prelude, version, chunks };
}

export function writeCanvasChunks(c: CanvasChunks): Uint8Array {
  if (c.prelude.length !== 8 || /[^\x20-\x7e]/.test(c.prelude)) throw new Error(`a prelude is 8 ASCII characters: ${JSON.stringify(c.prelude)}`);
  const size = 12 + c.chunks.reduce((n, ch) => n + 4 + ch.length, 0);
  const out = new Uint8Array(size);
  const view = new DataView(out.buffer);
  for (let i = 0; i < 8; i++) out[i] = c.prelude.charCodeAt(i);
  view.setUint32(8, c.version >>> 0, true);
  let off = 12;
  for (const ch of c.chunks) {
    view.setUint32(off, ch.length, true);
    out.set(ch, off + 4);
    off += 4 + ch.length;
  }
  return out;
}

/** Rejects FigJam and Slides containers and anything that is not a fig container. */
export function checkPrelude(prelude: string): void {
  if (prelude === PRELUDE_DESIGN) return;
  if (prelude === PRELUDE_FIGJAM || prelude === PRELUDE_SLIDES) throw new FigFormatError("unsupported-format", "FigJam and Slides files aren't supported");
  throw new FigFormatError("unsupported-format", "This isn't a Figma design file");
}

export interface DecodedCanvas {
  prelude: string;
  version: number;
  /** Binary kiwi schema (decompressed chunk 0) */
  schema: Uint8Array;
  /** Raw kiwi Message (decompressed chunk 1) */
  message: Uint8Array;
  /** How chunk 1 was compressed */
  compression: ChunkCompression;
}

export function decodeCanvas(bytes: Uint8Array, codecs: FigCodecs, opts: { allowAnyPrelude?: boolean } = {}): DecodedCanvas {
  const c = readCanvasChunks(bytes);
  if (!opts.allowAnyPrelude) checkPrelude(c.prelude);
  if (c.chunks.length < 2) throw new FigFormatError("corrupt", "a fig container needs a schema chunk and a data chunk");
  let schema: Uint8Array;
  let message: Uint8Array;
  let compression: ChunkCompression;
  try {
    schema = decompressChunk(c.chunks[0], codecs).bytes;
    ({ bytes: message, compression } = decompressChunk(c.chunks[1], codecs));
  } catch (e) {
    throw new FigFormatError("corrupt", `cannot decompress: ${(e as Error).message}`);
  }
  return { prelude: c.prelude, version: c.version, schema, message, compression };
}

export interface EncodeCanvasInput {
  schema: Uint8Array;
  message: Uint8Array;
  version: number;
  prelude?: string;
  /** Data chunk compression: zstd on disk, deflate-raw for clipboard and previews (browsers can inflate it) */
  compression: ChunkCompression;
  zstdLevel?: number;
}

export function encodeCanvas(input: EncodeCanvasInput, codecs: FigCodecs): Uint8Array {
  return writeCanvasChunks({
    prelude: input.prelude ?? PRELUDE_DESIGN,
    version: input.version,
    chunks: [codecs.deflateRaw(input.schema), compressChunk(input.message, input.compression, codecs, input.zstdLevel ?? 3)],
  });
}

/** The clipboard archive of docs/desktop.md §13: schema + Message, both deflate-raw. */
export function figContainer(schema: Uint8Array, message: Uint8Array, version: number, codecs: FigCodecs): Uint8Array {
  return encodeCanvas({ schema, message, version, compression: "deflate-raw" }, codecs);
}
