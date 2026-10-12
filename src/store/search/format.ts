/**
 * One file's visual search index on disk (docs/ai.md §6): `Workspace/spaces/search/<fileKey>.idx`.
 *
 *   "DVSI"  u32 format (1)  u32 header length  header (UTF-8 JSON)  [pad to 4]  vectors (Float16)  thumbnails (PNG)
 *
 * The header: `{v, fileKey, dims: {clip, text}, docs: [{doc, thumb: [offset, length]}]}` — offsets into the
 * thumbnails' block. The vectors: each doc's CLIP image vector then its text vector, unit length, as IEEE half
 * floats (little-endian), in the docs' order. Half floats keep 0.1 % of a cosine, well under ranking noise, at half
 * the size. No Node or DOM imports: both stores use it.
 */
import type { SearchDoc } from "../../shared/ai/types";

export const INDEX_MAGIC = "DVSI";
export const INDEX_FORMAT = 1;
/** CLIP ViT-B/32's projection and all-MiniLM-L6-v2's pooled output */
export const CLIP_DIM = 512;
export const TEXT_DIM = 384;

/** One indexed node as the store keeps it in memory: unit vectors (an all-zero vector when it had none). */
export interface IndexEntry {
  doc: SearchDoc;
  clip: Float32Array;
  text: Float32Array;
  thumb: Uint8Array;
}

export interface FileIndex {
  fileKey: string;
  dims: { clip: number; text: number };
  entries: Map<string, IndexEntry>;
}

// ---- half floats ----

const f32 = new Float32Array(1);
const u32 = new Uint32Array(f32.buffer);

/** A float to IEEE 754 binary16 bits (round to nearest even; overflow → ±Infinity, NaN kept). */
export function toHalf(value: number): number {
  f32[0] = value;
  const x = u32[0];
  const sign = (x >>> 16) & 0x8000;
  const exp = (x >>> 23) & 0xff;
  let mant = x & 0x7fffff;
  if (exp === 0xff) return sign | 0x7c00 | (mant ? 0x200 : 0);
  let e = exp - 127 + 15;
  if (e >= 0x1f) return sign | 0x7c00;
  if (e <= 0) {
    if (e < -10) return sign;
    mant |= 0x800000;
    const shift = 14 - e;
    let half = mant >>> shift;
    const rem = mant & ((1 << shift) - 1);
    const mid = 1 << (shift - 1);
    if (rem > mid || (rem === mid && half & 1)) half++;
    return sign | half;
  }
  let half = (e << 10) | (mant >>> 13);
  const rem = mant & 0x1fff;
  if (rem > 0x1000 || (rem === 0x1000 && half & 1)) half++;
  e = half >>> 10;
  return sign | (e >= 0x1f ? 0x7c00 : half);
}

/** IEEE 754 binary16 bits to a float. */
export function fromHalf(h: number): number {
  const sign = h & 0x8000 ? -1 : 1;
  const exp = (h >>> 10) & 0x1f;
  const mant = h & 0x3ff;
  if (exp === 0) return sign * mant * 2 ** -24;
  if (exp === 0x1f) return mant ? NaN : sign * Infinity;
  return sign * (1 + mant / 1024) * 2 ** (exp - 15);
}

// ---- vectors ----

/** `v` scaled to unit length (a copy); all zeros when it has no length or isn't finite. */
export function normalize(v: ArrayLike<number>, dim = v.length): Float32Array {
  const out = new Float32Array(dim);
  let sum = 0;
  for (let i = 0; i < Math.min(dim, v.length); i++) {
    const x = Number(v[i]);
    out[i] = Number.isFinite(x) ? x : 0;
    sum += out[i] * out[i];
  }
  const len = Math.sqrt(sum);
  if (!(len > 0)) return new Float32Array(dim);
  for (let i = 0; i < dim; i++) out[i] /= len;
  return out;
}

/** The dot product (the cosine of two unit vectors); 0 when the sizes differ. */
export function dot(a: Float32Array, b: Float32Array): number {
  if (a.length !== b.length) return 0;
  let s = 0;
  for (let i = 0; i < a.length; i++) s += a[i] * b[i];
  return s;
}

// ---- the file ----

interface Header {
  v: number;
  fileKey: string;
  dims: { clip: number; text: number };
  docs: { doc: SearchDoc; thumb: [number, number] }[];
}

const utf8 = new TextEncoder();
const fromUtf8 = new TextDecoder();

export function encodeIndex(index: FileIndex): Uint8Array {
  const entries = [...index.entries.values()];
  const { clip, text } = index.dims;
  let at = 0;
  const docs = entries.map((e) => {
    const thumb: [number, number] = [at, e.thumb.length];
    at += e.thumb.length;
    return { doc: e.doc, thumb };
  });
  const header = utf8.encode(JSON.stringify({ v: INDEX_FORMAT, fileKey: index.fileKey, dims: index.dims, docs } satisfies Header));
  const vecStart = align4(12 + header.length);
  const vecBytes = entries.length * (clip + text) * 2;
  const out = new Uint8Array(vecStart + vecBytes + at);
  const view = new DataView(out.buffer);
  out.set(utf8.encode(INDEX_MAGIC), 0);
  view.setUint32(4, INDEX_FORMAT, true);
  view.setUint32(8, header.length, true);
  out.set(header, 12);
  let p = vecStart;
  for (const e of entries) {
    for (let i = 0; i < clip; i++, p += 2) view.setUint16(p, toHalf(e.clip[i] ?? 0), true);
    for (let i = 0; i < text; i++, p += 2) view.setUint16(p, toHalf(e.text[i] ?? 0), true);
  }
  for (const e of entries) {
    out.set(e.thumb, p);
    p += e.thumb.length;
  }
  return out;
}

/** The index in `bytes`, or null when they aren't one (another format, cut short): the caller starts it again. */
export function decodeIndex(bytes: Uint8Array): FileIndex | null {
  if (bytes.length < 12 || fromUtf8.decode(bytes.subarray(0, 4)) !== INDEX_MAGIC) return null;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (view.getUint32(4, true) !== INDEX_FORMAT) return null;
  const headerLen = view.getUint32(8, true);
  if (12 + headerLen > bytes.length) return null;
  let header: Header;
  try {
    header = JSON.parse(fromUtf8.decode(bytes.subarray(12, 12 + headerLen))) as Header;
  } catch {
    return null;
  }
  if (header.v !== INDEX_FORMAT || !Array.isArray(header.docs) || !header.dims) return null;
  const { clip, text } = header.dims;
  const vecStart = align4(12 + headerLen);
  const thumbStart = vecStart + header.docs.length * (clip + text) * 2;
  if (thumbStart > bytes.length) return null;
  const entries = new Map<string, IndexEntry>();
  let p = vecStart;
  for (const { doc, thumb } of header.docs) {
    const c = new Float32Array(clip);
    const t = new Float32Array(text);
    for (let i = 0; i < clip; i++, p += 2) c[i] = fromHalf(view.getUint16(p, true));
    for (let i = 0; i < text; i++, p += 2) t[i] = fromHalf(view.getUint16(p, true));
    const [off, len] = thumb;
    if (thumbStart + off + len > bytes.length) return null;
    entries.set(doc.nodeId, { doc, clip: c, text: t, thumb: bytes.slice(thumbStart + off, thumbStart + off + len) });
  }
  return { fileKey: header.fileKey, dims: { clip, text }, entries };
}

const align4 = (n: number) => (n + 3) & ~3;
