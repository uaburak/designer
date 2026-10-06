/**
 * Journal segments (docs/data.md §5.2): `journal-<baseSeq:012>.log`, append-only, one frame per ChangeBatch.
 *
 *   header (64 bytes)
 *     0  8  magic "DSGNJRNL"
 *     8  4  u32 formatVersion = 1
 *    12  4  u32 DOCUMENT_FORMAT_VERSION
 *    16 20  sha1 of the binary schema (bytes in Workspace/schemas/<hex>.kiwi)
 *    36  8  u64 baseSeq
 *    44  8  f64 createdAt (ms)
 *    52 12  zero
 *   frame
 *     0  4  u32 magic 0x314D5246 ("FRM1")
 *     4  4  u32 payloadLength
 *     8  4  u32 crc32(payload)
 *    12  n  payload: u64 seq · u32 sessionID · u32 batchSeq · f64 wallClock · 16 B HLC · u8 kind · u8 flags
 *                    (bit0 = message is deflate-raw, set when > 64 KB) · u16 labelLength · label · kiwi Message
 */
import { closeSync, fdatasync, fdatasyncSync, fstatSync, ftruncateSync, openSync, writeSync } from "node:fs";
import { crc32 } from "node:zlib";
import type { BatchKind, Hlc } from "../../shared/store/types";

export const JOURNAL_MAGIC = "DSGNJRNL";
export const JOURNAL_FORMAT_VERSION = 1;
export const HEADER_SIZE = 64;
export const FRAME_MAGIC = 0x314d5246;
const FRAME_HEAD = 12;
const PAYLOAD_FIXED = 44;
/** Messages above this are stored deflate-raw (flag bit 0). */
export const DEFLATE_THRESHOLD = 64 * 1024;

const KINDS: BatchKind[] = ["edit", "undo", "redo", "system", "remote", "restore"];
export const kindCode = (k: BatchKind): number => {
  const i = KINDS.indexOf(k);
  if (i < 0) throw new Error(`unknown batch kind ${k}`);
  return i;
};
export const kindName = (code: number): BatchKind => KINDS[code] ?? "system";

export interface SegmentHeader {
  formatVersion: number;
  documentFormatVersion: number;
  schemaSha1: string;
  baseSeq: number;
  createdAt: number;
}

export interface FrameMeta {
  seq: number;
  sessionID: number;
  batchSeq: number;
  wallClock: number;
  hlc: Hlc;
  kind: BatchKind;
  label: string;
}

export interface Frame extends FrameMeta {
  /** Raw kiwi Message (inflated when it was stored deflated) */
  message: Uint8Array;
  /** Byte offset of the frame in its segment, and its total size */
  offset: number;
  size: number;
}

export const segmentName = (baseSeq: number) => `journal-${String(baseSeq).padStart(12, "0")}.log`;
export const snapshotName = (seq: number) => `snapshot-${String(seq).padStart(12, "0")}.kiwi`;

const ascii = new TextEncoder();
const utf8d = new TextDecoder();

export function encodeHeader(h: SegmentHeader): Uint8Array {
  const out = new Uint8Array(HEADER_SIZE);
  const view = new DataView(out.buffer);
  out.set(ascii.encode(JOURNAL_MAGIC), 0);
  view.setUint32(8, h.formatVersion, true);
  view.setUint32(12, h.documentFormatVersion, true);
  if (!/^[0-9a-f]{40}$/.test(h.schemaSha1)) throw new Error(`bad schema sha1 ${h.schemaSha1}`);
  for (let i = 0; i < 20; i++) out[16 + i] = parseInt(h.schemaSha1.slice(i * 2, i * 2 + 2), 16);
  view.setBigUint64(36, BigInt(h.baseSeq), true);
  view.setFloat64(44, h.createdAt, true);
  return out;
}

export function decodeHeader(bytes: Uint8Array): SegmentHeader {
  if (bytes.length < HEADER_SIZE || utf8d.decode(bytes.subarray(0, 8)) !== JOURNAL_MAGIC) throw new Error("not a journal segment");
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let sha = "";
  for (let i = 0; i < 20; i++) sha += bytes[16 + i].toString(16).padStart(2, "0");
  return {
    formatVersion: view.getUint32(8, true),
    documentFormatVersion: view.getUint32(12, true),
    schemaSha1: sha,
    baseSeq: Number(view.getBigUint64(36, true)),
    createdAt: view.getFloat64(44, true),
  };
}

/** Encodes one frame. `deflateRaw` compresses messages over 64 KB. */
export function encodeFrame(meta: FrameMeta, message: Uint8Array, deflateRaw: (d: Uint8Array) => Uint8Array): Uint8Array {
  const label = ascii.encode(meta.label);
  if (label.length > 0xffff) throw new Error("label too long");
  const hlc = ascii.encode(meta.hlc);
  if (hlc.length !== 16) throw new Error(`an HLC is 16 ASCII bytes: ${meta.hlc}`);
  const deflate = message.length > DEFLATE_THRESHOLD;
  const body = deflate ? deflateRaw(message) : message;
  const payloadLength = PAYLOAD_FIXED + label.length + body.length;
  const out = new Uint8Array(FRAME_HEAD + payloadLength);
  const view = new DataView(out.buffer);
  view.setUint32(0, FRAME_MAGIC, true);
  view.setUint32(4, payloadLength, true);
  const p = FRAME_HEAD;
  view.setBigUint64(p, BigInt(meta.seq), true);
  view.setUint32(p + 8, meta.sessionID >>> 0, true);
  view.setUint32(p + 12, meta.batchSeq >>> 0, true);
  view.setFloat64(p + 16, meta.wallClock, true);
  out.set(hlc, p + 24);
  out[p + 40] = kindCode(meta.kind);
  out[p + 41] = deflate ? 1 : 0;
  view.setUint16(p + 42, label.length, true);
  out.set(label, p + PAYLOAD_FIXED);
  out.set(body, p + PAYLOAD_FIXED + label.length);
  view.setUint32(8, crc32(out.subarray(FRAME_HEAD)), true);
  return out;
}

export interface SegmentScan {
  header: SegmentHeader;
  frames: Frame[];
  /** Length of the readable prefix (header + good frames) */
  goodLength: number;
  /** Bytes after the readable prefix (a torn tail, or everything after a bad frame) */
  badBytes: number;
  /** Well-formed frames found after the first bad one (lost, because order cannot be trusted past a hole) */
  droppedFrames: number;
}

function readFrameAt(bytes: Uint8Array, view: DataView, off: number, inflateRaw: (d: Uint8Array) => Uint8Array): Frame | null {
  if (off + FRAME_HEAD > bytes.length) return null;
  if (view.getUint32(off, true) !== FRAME_MAGIC) return null;
  const len = view.getUint32(off + 4, true);
  if (len < PAYLOAD_FIXED || off + FRAME_HEAD + len > bytes.length) return null;
  const payload = bytes.subarray(off + FRAME_HEAD, off + FRAME_HEAD + len);
  if (crc32(payload) !== view.getUint32(off + 8, true)) return null;
  const p = off + FRAME_HEAD;
  const labelLength = view.getUint16(p + 42, true);
  if (PAYLOAD_FIXED + labelLength > len) return null;
  const flags = bytes[p + 41];
  const body = payload.subarray(PAYLOAD_FIXED + labelLength);
  let message: Uint8Array;
  try {
    message = flags & 1 ? inflateRaw(body) : body;
  } catch {
    return null;
  }
  return {
    seq: Number(view.getBigUint64(p, true)),
    sessionID: view.getUint32(p + 8, true),
    batchSeq: view.getUint32(p + 12, true),
    wallClock: view.getFloat64(p + 16, true),
    hlc: utf8d.decode(bytes.subarray(p + 24, p + 40)),
    kind: kindName(bytes[p + 40]),
    label: utf8d.decode(payload.subarray(PAYLOAD_FIXED, PAYLOAD_FIXED + labelLength)),
    message,
    offset: off,
    size: FRAME_HEAD + len,
  };
}

/**
 * Reads a segment: verifies each frame's magic, length and CRC (and that seqs follow `expectSeq` without gaps),
 * stopping at the first bad or short frame.
 */
export function scanSegment(bytes: Uint8Array, inflateRaw: (d: Uint8Array) => Uint8Array, expectSeq?: number): SegmentScan {
  const header = decodeHeader(bytes);
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const frames: Frame[] = [];
  let off = HEADER_SIZE;
  let next = expectSeq ?? header.baseSeq;
  while (off < bytes.length) {
    const f = readFrameAt(bytes, view, off, inflateRaw);
    if (!f || f.seq !== next) break;
    frames.push(f);
    off += f.size;
    next++;
  }
  const goodLength = off;
  // Count the well-formed frames past the hole (resync on the frame magic), for the recovery report.
  let droppedFrames = 0;
  if (goodLength < bytes.length) {
    for (let o = goodLength + 1; o + FRAME_HEAD <= bytes.length; o++) {
      if (view.getUint32(o, true) !== FRAME_MAGIC) continue;
      const f = readFrameAt(bytes, view, o, inflateRaw);
      if (f) {
        droppedFrames++;
        o += f.size - 1;
      }
    }
  }
  return { header, frames, goodLength, badBytes: bytes.length - goodLength, droppedFrames };
}

/**
 * The open segment of a file: an O_APPEND fd, one `write` per frame (synchronous: the bytes are in the page cache
 * before the ack), `fdatasync` on demand (async, off the event loop).
 */
export class SegmentWriter {
  private fd: number;
  private syncing: Promise<void> | null = null;
  private dirtyBytes = 0;
  size: number;
  frames: number;

  private constructor(
    readonly path: string,
    readonly header: SegmentHeader,
    fd: number,
    size: number,
    frames: number,
  ) {
    this.fd = fd;
    this.size = size;
    this.frames = frames;
  }

  /** Creates a new segment (fails if it exists) and fsyncs its header. */
  static create(path: string, header: SegmentHeader): SegmentWriter {
    const fd = openSync(path, "ax", 0o644);
    try {
      writeSync(fd, encodeHeader(header));
      fdatasyncSync(fd);
    } catch (e) {
      closeSync(fd);
      throw e;
    }
    return new SegmentWriter(path, header, fd, HEADER_SIZE, 0);
  }

  /** Reopens an existing segment for appending, after truncating anything past `goodLength`. */
  static reopen(path: string, header: SegmentHeader, goodLength: number, frames: number): SegmentWriter {
    const fd = openSync(path, "r+");
    try {
      if (fstatSync(fd).size !== goodLength) {
        ftruncateSync(fd, goodLength);
        fdatasyncSync(fd);
      }
    } catch (e) {
      closeSync(fd);
      throw e;
    }
    closeSync(fd);
    const afd = openSync(path, "a");
    return new SegmentWriter(path, header, afd, goodLength, frames);
  }

  append(frame: Uint8Array): void {
    let written = 0;
    while (written < frame.length) written += writeSync(this.fd, frame, written, frame.length - written);
    this.size += frame.length;
    this.frames++;
    this.dirtyBytes += frame.length;
  }

  get unsynced(): boolean {
    return this.dirtyBytes > 0;
  }

  /** fdatasync; concurrent callers share one sync, and a sync started before an append covers only what it saw. */
  async sync(): Promise<void> {
    while (this.syncing) await this.syncing;
    if (!this.dirtyBytes) return;
    const covered = this.dirtyBytes;
    this.syncing = new Promise<void>((resolve, reject) => fdatasync(this.fd, (err) => (err ? reject(err) : resolve())));
    try {
      await this.syncing;
      this.dirtyBytes -= covered;
    } finally {
      this.syncing = null;
    }
  }

  async close(): Promise<void> {
    await this.sync();
    if (this.fd >= 0) closeSync(this.fd);
    this.fd = -1;
  }
}
