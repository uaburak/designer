/**
 * Straight RGBA → PNG with the platform's zlib (CompressionStream "deflate"): get_screenshot's encoder, the same in
 * the editor view and in Node (the tests) — no canvas needed.
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

function crc32(bytes: Uint8Array, start: number, end: number): number {
  let c = 0xffffffff;
  for (let i = start; i < end; i++) c = CRC_TABLE[(c ^ bytes[i]) & 255] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

async function deflate(data: Uint8Array): Promise<Uint8Array> {
  const stream = new Blob([data as BlobPart]).stream().pipeThrough(new CompressionStream("deflate"));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

export async function encodePng(width: number, height: number, rgba: Uint8Array): Promise<Uint8Array> {
  const row = width * 4 + 1;
  const raw = new Uint8Array(row * height);
  for (let y = 0; y < height; y++) {
    raw[y * row] = 0;
    raw.set(rgba.subarray(y * width * 4, (y + 1) * width * 4), y * row + 1);
  }
  const idat = await deflate(raw);
  const chunks: [string, Uint8Array][] = [
    ["IHDR", (() => {
      const h = new Uint8Array(13);
      const v = new DataView(h.buffer);
      v.setUint32(0, width);
      v.setUint32(4, height);
      h.set([8, 6, 0, 0, 0], 8);
      return h;
    })()],
    ["IDAT", idat],
    ["IEND", new Uint8Array(0)],
  ];
  const size = 8 + chunks.reduce((s, [, d]) => s + 12 + d.length, 0);
  const out = new Uint8Array(size);
  out.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const view = new DataView(out.buffer);
  let at = 8;
  for (const [type, data] of chunks) {
    view.setUint32(at, data.length);
    for (let i = 0; i < 4; i++) out[at + 4 + i] = type.charCodeAt(i);
    out.set(data, at + 8);
    view.setUint32(at + 8 + data.length, crc32(out, at + 4, at + 8 + data.length));
    at += 12 + data.length;
  }
  return out;
}

export function base64(bytes: Uint8Array): string {
  let s = "";
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(s);
}
