// Reads a Figma .fig file (a zip holding canvas.fig — fig-kiwi: its schema and
// one Message — plus images/<sha1>) into the engine's interim JSON Message:
// GUIDs as "s:l", the Message's blobs as base64, byte arrays as numbers, every
// field kept (the engine keeps those it doesn't model). Used by fixtures.mjs
// (the native tests' Figma documents) and scripts/engine-shot.mjs (the
// playground's screenshots of the samples).
//
//   import { readFig } from "./fig.mjs";
//   const { message, images } = readFig("docs/research/figma/samples/structure.fig");
import { Buffer } from "node:buffer";
import { readFileSync } from "node:fs";
import zlib from "node:zlib";

function readZip(buf) {
  const files = {};
  let eocd = buf.length - 22;
  while (buf.readUInt32LE(eocd) !== 0x06054b50) eocd--;
  const n = buf.readUInt16LE(eocd + 10);
  let off = buf.readUInt32LE(eocd + 16);
  for (let i = 0; i < n; i++) {
    const method = buf.readUInt16LE(off + 10);
    const csize = buf.readUInt32LE(off + 20);
    const nameLen = buf.readUInt16LE(off + 28);
    const extraLen = buf.readUInt16LE(off + 30);
    const commLen = buf.readUInt16LE(off + 32);
    const lho = buf.readUInt32LE(off + 42);
    const name = buf.toString("utf8", off + 46, off + 46 + nameLen);
    const lnl = buf.readUInt16LE(lho + 26);
    const lel = buf.readUInt16LE(lho + 28);
    const data = buf.subarray(lho + 30 + lnl + lel, lho + 30 + lnl + lel + csize);
    files[name] = method === 0 ? data : zlib.inflateRawSync(data);
    off += 46 + nameLen + extraLen + commLen;
  }
  return files;
}

class Reader {
  constructor(b) {
    this.b = b;
    this.i = 0;
  }
  byte() {
    return this.b[this.i++];
  }
  bool() {
    return this.byte() !== 0;
  }
  vu() {
    let r = 0;
    let s = 0;
    let c;
    do {
      c = this.byte();
      r |= (c & 127) << s;
      s += 7;
    } while (c & 128 && s < 35);
    return r >>> 0;
  }
  vi() {
    const v = this.vu();
    return v & 1 ? ~(v >>> 1) : v >>> 1;
  }
  vu64() {
    let r = 0n;
    let s = 0n;
    let c;
    do {
      c = this.byte();
      r |= BigInt(c & 127) << s;
      s += 7n;
    } while (c & 128 && s < 70n);
    return r;
  }
  vi64() {
    const v = this.vu64();
    return v & 1n ? ~(v >> 1n) : v >> 1n;
  }
  f() {
    const first = this.byte();
    if (first === 0) return 0;
    let bits = first | (this.byte() << 8) | (this.byte() << 16) | (this.byte() << 24);
    bits = (bits << 23) | (bits >>> 9);
    const dv = new DataView(new ArrayBuffer(4));
    dv.setUint32(0, bits >>> 0, true);
    return dv.getFloat32(0, true);
  }
  str() {
    const s = this.i;
    while (this.b[this.i] !== 0) this.i++;
    const r = Buffer.from(this.b.subarray(s, this.i)).toString("utf8");
    this.i++;
    return r;
  }
  bytes() {
    const n = this.vu();
    const r = this.b.subarray(this.i, this.i + n);
    this.i += n;
    return r;
  }
}

const BUILTIN = ["bool", "byte", "int", "uint", "float", "string", "int64", "uint64"];

function decodeSchema(buf) {
  const r = new Reader(buf);
  const defs = [];
  const n = r.vu();
  for (let i = 0; i < n; i++) {
    const name = r.str();
    const kind = r.byte();
    const fc = r.vu();
    const fields = [];
    for (let j = 0; j < fc; j++) {
      const fname = r.str();
      const type = r.vi();
      const isArray = !!(r.byte() & 1);
      const value = r.vu();
      fields.push({ name: fname, type, isArray, value });
    }
    defs.push({ name, kind: ["ENUM", "STRUCT", "MESSAGE"][kind], fields });
  }
  for (const d of defs) for (const f of d.fields) f.typeName = f.type < 0 ? BUILTIN[~f.type] : defs[f.type].name;
  return defs;
}

function makeDecoder(defs) {
  const byName = Object.fromEntries(defs.map((d) => [d.name, d]));
  function value(r, typeName) {
    switch (typeName) {
      case "bool":
        return r.bool();
      case "byte":
        return r.byte();
      case "int":
        return r.vi();
      case "uint":
        return r.vu();
      case "float":
        return r.f();
      case "string":
        return r.str();
      case "int64":
        return Number(r.vi64());
      case "uint64":
        return Number(r.vu64());
    }
    const d = byName[typeName];
    if (d.kind === "ENUM") {
      const v = r.vu();
      const f = d.fields.find((x) => x.value === v);
      return f ? f.name : v;
    }
    if (d.kind === "STRUCT") {
      const o = {};
      for (const f of d.fields) o[f.name] = field(r, f);
      return o;
    }
    const o = {};
    for (;;) {
      const id = r.vu();
      if (id === 0) return o;
      const f = d.fields.find((x) => x.value === id);
      if (!f) throw new Error(`bad field ${id} in ${typeName}`);
      o[f.name] = field(r, f);
    }
  }
  function field(r, f) {
    if (f.isArray) {
      if (f.typeName === "byte") return Array.from(r.bytes());
      const n = r.vu();
      const a = [];
      for (let i = 0; i < n; i++) a.push(value(r, f.typeName));
      return a;
    }
    return value(r, f.typeName);
  }
  return (buf, root) => value(new Reader(buf), root);
}

function unpack(c) {
  if (c[0] === 0x28 && c[1] === 0xb5 && c[2] === 0x2f && c[3] === 0xfd) return zlib.zstdDecompressSync(c);
  return zlib.inflateRawSync(c);
}

const isGuid = (v) => v && typeof v === "object" && !Array.isArray(v) && Object.keys(v).length === 2 && "sessionID" in v && "localID" in v;

// GUID objects → "s:l", recursively.
function engineValue(v) {
  if (Array.isArray(v)) return v.map(engineValue);
  if (isGuid(v)) return `${v.sessionID}:${v.localID}`;
  if (v && typeof v === "object") {
    const o = {};
    for (const [k, x] of Object.entries(v)) o[k] = engineValue(x);
    return o;
  }
  return v;
}

/** The .fig at `path` as { message (the engine's JSON Message), images: { sha1: Buffer }, thumbnail: Buffer }. */
export function readFig(path) {
  const zip = readZip(readFileSync(path));
  const c = zip["canvas.fig"];
  let off = 12;
  const chunks = [];
  while (off < c.length) {
    const n = c.readUInt32LE(off);
    off += 4;
    chunks.push(c.subarray(off, off + n));
    off += n;
  }
  const decode = makeDecoder(decodeSchema(unpack(chunks[0])));
  const raw = decode(unpack(chunks[1]), "Message");
  const message = {
    type: "NODE_CHANGES",
    sessionID: 0,
    nodeChanges: raw.nodeChanges.map((n) => {
      const out = engineValue(n);
      if (out.type === "GROUP") {
        out.type = "FRAME";
        out.resizeToFit = true;
      }
      if (out.type === "RECTANGLE") out.type = "ROUNDED_RECTANGLE";
      return out;
    }),
    blobs: (raw.blobs ?? []).map((b) => Buffer.from(b.bytes).toString("base64")),
  };
  const images = {};
  for (const [name, data] of Object.entries(zip))
    if (name.startsWith("images/") && name.length > 7) images[name.slice(7)] = data;
  return { message, images, thumbnail: zip["thumbnail.png"] };
}
