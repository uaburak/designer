/**
 * dotLottie (docs/motion.md §7.6; round 8e): a ZIP — our minimal writer: JSON deflated (`deflate-raw` through
 * CompressionStream where the browser has it, else stored), images stored, CRC-32 per entry — holding
 * `manifest.json` ({version "1", generator, animations [{id}]}), `animations/<id>.json` per animation and the images
 * under `images/`. Several frames go in one file, one animation each (Figma: "compressed archive with images and
 * fonts, several animations"; text is outlined, so no font files).
 */

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

export function crc32(bytes: Uint8Array): number {
  let c = 0xffffffff;
  for (let i = 0; i < bytes.length; i++) c = CRC_TABLE[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

export interface ZipEntry {
  name: string;
  bytes: Uint8Array;
  /** Deflate it (JSON); images are stored as they are */
  deflate?: boolean;
}

/** `bytes` through `deflate-raw` (null where CompressionStream is missing: the entry is stored). */
async function deflateRaw(bytes: Uint8Array): Promise<Uint8Array | null> {
  if (typeof CompressionStream === "undefined") return null;
  try {
    const stream = new Blob([bytes as BlobPart]).stream().pipeThrough(new CompressionStream("deflate-raw"));
    return new Uint8Array(await new Response(stream).arrayBuffer());
  } catch {
    return null;
  }
}

/** A ZIP of the entries (no extra fields, no zip64; DOS time 1980-01-01). */
export async function zip(entries: readonly ZipEntry[]): Promise<Uint8Array> {
  const enc = new TextEncoder();
  const locals: Uint8Array[] = [];
  const centrals: Uint8Array[] = [];
  let offset = 0;
  for (const e of entries) {
    const name = enc.encode(e.name);
    const packed = e.deflate ? await deflateRaw(e.bytes) : null;
    const data = packed ?? e.bytes;
    const method = packed ? 8 : 0;
    const crc = crc32(e.bytes);
    const local = new Uint8Array(30 + name.length);
    const lv = new DataView(local.buffer);
    lv.setUint32(0, 0x04034b50, true);
    lv.setUint16(4, 20, true);
    lv.setUint16(6, 0x0800, true); // UTF-8 names
    lv.setUint16(8, method, true);
    lv.setUint16(12, 0x21, true); // 1980-01-01
    lv.setUint32(14, crc, true);
    lv.setUint32(18, data.length, true);
    lv.setUint32(22, e.bytes.length, true);
    lv.setUint16(26, name.length, true);
    local.set(name, 30);
    const central = new Uint8Array(46 + name.length);
    const cv = new DataView(central.buffer);
    cv.setUint32(0, 0x02014b50, true);
    cv.setUint16(4, 20, true);
    cv.setUint16(6, 20, true);
    cv.setUint16(8, 0x0800, true);
    cv.setUint16(10, method, true);
    cv.setUint16(14, 0x21, true);
    cv.setUint32(16, crc, true);
    cv.setUint32(20, data.length, true);
    cv.setUint32(24, e.bytes.length, true);
    cv.setUint16(28, name.length, true);
    cv.setUint32(42, offset, true);
    central.set(name, 46);
    locals.push(local, data);
    centrals.push(central);
    offset += local.length + data.length;
  }
  const centralSize = centrals.reduce((n, c) => n + c.length, 0);
  const end = new Uint8Array(22);
  const ev = new DataView(end.buffer);
  ev.setUint32(0, 0x06054b50, true);
  ev.setUint16(8, entries.length, true);
  ev.setUint16(10, entries.length, true);
  ev.setUint32(12, centralSize, true);
  ev.setUint32(16, offset, true);
  const out = new Uint8Array(offset + centralSize + end.length);
  let at = 0;
  for (const part of [...locals, ...centrals, end]) {
    out.set(part, at);
    at += part.length;
  }
  return out;
}

/** An animation's id in the manifest and its file name: letters, digits, - and _ only. */
export const animationId = (name: string, n: number): string => (name.replace(/[^A-Za-z0-9_-]+/g, "_").replace(/^_+|_+$/g, "") || "animation") + (n ? `_${n + 1}` : "");

/** The dotLottie file of the animations (their images under images/, named as their assets' `p`). */
export async function writeDotLottie(animations: readonly { id: string; json: object }[], images: readonly { name: string; bytes: Uint8Array }[]): Promise<Uint8Array> {
  const enc = new TextEncoder();
  const manifest = { version: "1", generator: "DesignerV2", author: "DesignerV2", animations: animations.map((a) => ({ id: a.id, speed: 1, loop: true })) };
  return zip([
    { name: "manifest.json", bytes: enc.encode(JSON.stringify(manifest)), deflate: true },
    ...animations.map((a) => ({ name: `animations/${a.id}.json`, bytes: enc.encode(JSON.stringify(a.json)), deflate: true })),
    ...images.map((i) => ({ name: `images/${i.name}`, bytes: i.bytes })),
  ]);
}
