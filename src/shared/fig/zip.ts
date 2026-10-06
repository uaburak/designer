/**
 * A small ZIP reader and writer for `.fig` files (docs/data.md §11): Figma writes stored entries (meta.json is
 * sometimes deflated) with data descriptors, so the reader trusts the central directory, not the local headers.
 * ZIP64 is read; the writer writes classic ZIP (a .fig over 4 GB is refused).
 */
import { FigFormatError } from "./container";
import { crc32 } from "./crc32";

export interface ZipEntry {
  name: string;
  data: Uint8Array;
}

const SIG_LOCAL = 0x04034b50;
const SIG_CENTRAL = 0x02014b50;
const SIG_EOCD = 0x06054b50;
const SIG_EOCD64 = 0x06064b50;
const SIG_EOCD64_LOCATOR = 0x07064b50;

const utf8 = new TextDecoder("utf-8");
const utf8e = new TextEncoder();

export function isZip(bytes: Uint8Array): boolean {
  return bytes.length >= 4 && bytes[0] === 0x50 && bytes[1] === 0x4b && bytes[2] === 0x03 && bytes[3] === 0x04;
}

/** Reads every file entry (directories skipped). `inflateRaw` is needed only for deflated entries. */
export function readZip(bytes: Uint8Array, inflateRaw?: (data: Uint8Array) => Uint8Array): ZipEntry[] {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const u16 = (o: number) => view.getUint16(o, true);
  const u32 = (o: number) => view.getUint32(o, true);
  const u64 = (o: number) => Number(view.getBigUint64(o, true));
  let eocd = -1;
  for (let o = bytes.length - 22; o >= Math.max(0, bytes.length - 22 - 65535); o--) {
    if (u32(o) === SIG_EOCD) {
      eocd = o;
      break;
    }
  }
  if (eocd < 0) throw new FigFormatError("corrupt", "not a ZIP file (no end of central directory)");
  let count = u16(eocd + 10);
  let cdOffset = u32(eocd + 16);
  if ((count === 0xffff || cdOffset === 0xffffffff) && eocd >= 20 && u32(eocd - 20) === SIG_EOCD64_LOCATOR) {
    const rec = u64(eocd - 20 + 8);
    if (u32(rec) !== SIG_EOCD64) throw new FigFormatError("corrupt", "bad ZIP64 end of central directory");
    count = u64(rec + 32);
    cdOffset = u64(rec + 48);
  }
  const out: ZipEntry[] = [];
  let off = cdOffset;
  for (let i = 0; i < count; i++) {
    if (off + 46 > bytes.length || u32(off) !== SIG_CENTRAL) throw new FigFormatError("corrupt", "bad ZIP central directory");
    const method = u16(off + 10);
    const crc = u32(off + 16);
    let csize = u32(off + 20);
    let usize = u32(off + 24);
    const nameLen = u16(off + 28);
    const extraLen = u16(off + 30);
    const commentLen = u16(off + 32);
    let local = u32(off + 42);
    const name = utf8.decode(bytes.subarray(off + 46, off + 46 + nameLen));
    // ZIP64 extended information (0x0001): the fields that are 0xFFFFFFFF, in order usize, csize, offset.
    let e = off + 46 + nameLen;
    const extraEnd = e + extraLen;
    while (e + 4 <= extraEnd) {
      const id = u16(e);
      const size = u16(e + 2);
      if (id === 0x0001) {
        let p = e + 4;
        if (usize === 0xffffffff) {
          usize = u64(p);
          p += 8;
        }
        if (csize === 0xffffffff) {
          csize = u64(p);
          p += 8;
        }
        if (local === 0xffffffff) local = u64(p);
      }
      e += 4 + size;
    }
    off = extraEnd + commentLen;
    if (name.endsWith("/")) continue;
    if (local + 30 > bytes.length || u32(local) !== SIG_LOCAL) throw new FigFormatError("corrupt", `bad ZIP local header for ${name}`);
    const start = local + 30 + u16(local + 26) + u16(local + 28);
    if (start + csize > bytes.length) throw new FigFormatError("corrupt", `truncated ZIP entry ${name}`);
    const raw = bytes.subarray(start, start + csize);
    let data: Uint8Array;
    if (method === 0) data = raw;
    else if (method === 8) {
      if (!inflateRaw) throw new FigFormatError("unsupported-format", `ZIP entry ${name} is deflated and no inflater is available`);
      data = inflateRaw(raw);
    } else throw new FigFormatError("unsupported-format", `ZIP entry ${name} uses compression method ${method}`);
    if (data.length !== usize) throw new FigFormatError("corrupt", `ZIP entry ${name} has the wrong size`);
    if (crc32(data) !== crc) throw new FigFormatError("corrupt", `ZIP entry ${name} fails its CRC check`);
    out.push({ name, data });
  }
  return out;
}

function dosDateTime(d: Date): { time: number; date: number } {
  const year = Math.max(1980, d.getFullYear());
  return {
    time: (d.getHours() << 11) | (d.getMinutes() << 5) | (d.getSeconds() >> 1),
    date: ((year - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate(),
  };
}

/** Writes a ZIP with stored (uncompressed) entries, as Figma does. Names ending in "/" are directory entries. */
export function writeZip(entries: ZipEntry[], opts: { date?: Date } = {}): Uint8Array {
  const { time, date } = dosDateTime(opts.date ?? new Date());
  const names = entries.map((e) => utf8e.encode(e.name));
  const crcs = entries.map((e) => crc32(e.data));
  const localSize = entries.reduce((n, e, i) => n + 30 + names[i].length + e.data.length, 0);
  const centralSize = entries.reduce((n, _e, i) => n + 46 + names[i].length, 0);
  const total = localSize + centralSize + 22;
  if (total > 0xffffffff || entries.length > 0xffff) throw new Error("a .fig this large needs ZIP64, which is not written");
  const out = new Uint8Array(total);
  const view = new DataView(out.buffer);
  const offsets: number[] = [];
  let off = 0;
  entries.forEach((e, i) => {
    offsets.push(off);
    view.setUint32(off, SIG_LOCAL, true);
    view.setUint16(off + 4, 20, true); // version needed
    view.setUint16(off + 6, 0x0800, true); // UTF-8 names
    view.setUint16(off + 8, 0, true); // stored
    view.setUint16(off + 10, time, true);
    view.setUint16(off + 12, date, true);
    view.setUint32(off + 14, crcs[i], true);
    view.setUint32(off + 18, e.data.length, true);
    view.setUint32(off + 22, e.data.length, true);
    view.setUint16(off + 26, names[i].length, true);
    view.setUint16(off + 28, 0, true);
    out.set(names[i], off + 30);
    out.set(e.data, off + 30 + names[i].length);
    off += 30 + names[i].length + e.data.length;
  });
  const cdStart = off;
  entries.forEach((e, i) => {
    const isDir = e.name.endsWith("/");
    view.setUint32(off, SIG_CENTRAL, true);
    view.setUint16(off + 4, (3 << 8) | 20, true); // made by: Unix, 2.0
    view.setUint16(off + 6, 20, true);
    view.setUint16(off + 8, 0x0800, true);
    view.setUint16(off + 10, 0, true);
    view.setUint16(off + 12, time, true);
    view.setUint16(off + 14, date, true);
    view.setUint32(off + 16, crcs[i], true);
    view.setUint32(off + 20, e.data.length, true);
    view.setUint32(off + 24, e.data.length, true);
    view.setUint16(off + 28, names[i].length, true);
    view.setUint16(off + 30, 0, true);
    view.setUint16(off + 32, 0, true);
    view.setUint16(off + 34, 0, true);
    view.setUint16(off + 36, 0, true);
    view.setUint32(off + 38, ((isDir ? 0o40755 : 0o100644) << 16) >>> 0, true);
    view.setUint32(off + 42, offsets[i], true);
    out.set(names[i], off + 46);
    off += 46 + names[i].length;
  });
  view.setUint32(off, SIG_EOCD, true);
  view.setUint16(off + 8, entries.length, true);
  view.setUint16(off + 10, entries.length, true);
  view.setUint32(off + 12, off - cdStart, true);
  view.setUint32(off + 16, cdStart, true);
  return out;
}
