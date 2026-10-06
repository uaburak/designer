/**
 * Node's compression for the shared fig code: deflate-raw and zstd (Node ≥ 22.15 / 24) through node:zlib.
 * Results are copied into plain Uint8Arrays that own their buffer, so they structured-clone without dragging a pool.
 */
import { constants, deflateRawSync, inflateRawSync, zstdCompressSync, zstdDecompressSync } from "node:zlib";
import type { FigCodecs } from "../../shared/fig/compression";

/** A Uint8Array that owns exactly its bytes (Buffers and subarrays may view a larger ArrayBuffer). */
export function own(bytes: Uint8Array): Uint8Array {
  if (bytes.byteOffset === 0 && bytes.byteLength === bytes.buffer.byteLength && !(bytes instanceof Buffer)) return bytes;
  const out = new Uint8Array(bytes.byteLength);
  out.set(bytes);
  return out;
}

export const nodeCodecs: Required<FigCodecs> = {
  inflateRaw: (d) => own(inflateRawSync(d)),
  deflateRaw: (d) => own(deflateRawSync(d)),
  zstdDecompress: (d) => own(zstdDecompressSync(d)),
  // With the frame checksum, a damaged snapshot fails to decompress instead of decoding garbage (recovery, §5.6).
  zstdCompress: (d, level) => own(zstdCompressSync(d, { params: { [constants.ZSTD_c_compressionLevel]: level, [constants.ZSTD_c_checksumFlag]: 1 } })),
};
