/**
 * Compression is injected: the store passes Node's zlib (deflate-raw and zstd), a renderer passes a synchronous
 * deflate (e.g. fflate's deflateSync/inflateSync) for clipboard archives. Shared code never imports either.
 */
export interface FigCodecs {
  inflateRaw(data: Uint8Array): Uint8Array;
  deflateRaw(data: Uint8Array): Uint8Array;
  /** Needed to read data chunks written with zstd (disk snapshots, newer Figma files) */
  zstdDecompress?(data: Uint8Array): Uint8Array;
  /** Needed to write zstd chunks (disk snapshots) */
  zstdCompress?(data: Uint8Array, level: number): Uint8Array;
}

export type ChunkCompression = "zstd" | "deflate-raw";

/** zstd frames start with 28 B5 2F FD; everything else in a fig container is raw deflate. */
export function isZstd(data: Uint8Array): boolean {
  return data.length >= 4 && data[0] === 0x28 && data[1] === 0xb5 && data[2] === 0x2f && data[3] === 0xfd;
}

export function decompressChunk(data: Uint8Array, codecs: FigCodecs): { bytes: Uint8Array; compression: ChunkCompression } {
  if (isZstd(data)) {
    if (!codecs.zstdDecompress) throw new Error("this chunk is zstd-compressed and no zstd decoder is available");
    return { bytes: codecs.zstdDecompress(data), compression: "zstd" };
  }
  return { bytes: codecs.inflateRaw(data), compression: "deflate-raw" };
}

export function compressChunk(data: Uint8Array, compression: ChunkCompression, codecs: FigCodecs, zstdLevel = 3): Uint8Array {
  if (compression === "zstd") {
    if (!codecs.zstdCompress) throw new Error("no zstd encoder is available");
    return codecs.zstdCompress(data, zstdLevel);
  }
  return codecs.deflateRaw(data);
}

/**
 * Deflate-raw with stored (uncompressed) blocks only — valid deflate any inflater reads (a browser's
 * `DecompressionStream("deflate-raw")`, zlib, Figma) — for writers that must be synchronous and carry no codec: the
 * clipboard archive of docs/desktop.md §13 is written inside the DOM `copy` event, which can't await.
 */
export function deflateRawStored(data: Uint8Array): Uint8Array {
  const blocks = Math.max(1, Math.ceil(data.length / 0xffff));
  const out = new Uint8Array(data.length + blocks * 5);
  let at = 0;
  for (let b = 0; b < blocks; b++) {
    const from = b * 0xffff;
    const len = Math.min(0xffff, data.length - from);
    out[at++] = b === blocks - 1 ? 1 : 0; // BFINAL, BTYPE 00 (stored)
    out[at++] = len & 0xff;
    out[at++] = len >>> 8;
    out[at++] = ~len & 0xff;
    out[at++] = (~len >>> 8) & 0xff;
    out.set(data.subarray(from, from + len), at);
    at += len;
  }
  return out;
}

/** The inverse of `deflateRawStored`, synchronously; throws on a compressed block (inflate those with a real codec). */
export function inflateRawStored(data: Uint8Array): Uint8Array {
  const parts: Uint8Array[] = [];
  let at = 0;
  let total = 0;
  for (;;) {
    if (at + 5 > data.length) throw new Error("truncated stored block");
    const header = data[at];
    if ((header >>> 1) & 3) throw new Error("a compressed deflate block");
    const len = data[at + 1] | (data[at + 2] << 8);
    const nlen = data[at + 3] | (data[at + 4] << 8);
    if ((len ^ 0xffff) !== nlen) throw new Error("a damaged stored block");
    at += 5;
    if (at + len > data.length) throw new Error("truncated stored block");
    parts.push(data.subarray(at, at + len));
    total += len;
    at += len;
    if (header & 1) break;
  }
  const out = new Uint8Array(total);
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.length;
  }
  return out;
}
