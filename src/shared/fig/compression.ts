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
