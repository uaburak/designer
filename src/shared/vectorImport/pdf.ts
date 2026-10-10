/**
 * PDF vector artwork → SVG (docs/desktop.md §13 "Vector paste"): what Illustrator puts on the macOS clipboard as
 * `com.adobe.pdf` when its SVG flavour is off. The first page's content stream is interpreted for the vector subset
 * Illustrator writes — paths (m l c v y h re), painting (f F f* S s B B* b b* n), clipping (W W*), colour (g G rg RG k K
 * cs CS sc SC scn SCN in DeviceGray / RGB / CMYK, ICCBased by its component count, CalRGB / CalGray, Lab, Indexed,
 * Separation / DeviceN through their tint transforms), line width, cap, join, miter limit and dash (w J j M d, and the
 * same in ExtGState with its fill / stroke alpha), q / Q, cm, Form XObjects, axial and radial shadings (`sh` inside a
 * clip, and shading patterns as fills) — and written out as SVG for the SVG import (one path per painting operator,
 * clip groups as `clip-path`). Text is counted and skipped (Illustrator embeds fonts, not outlines); images too.
 *
 * The file is read without its cross-reference table: objects are found by scanning `n g obj … endobj` in order (a
 * stream skipped by its /Length), then any object streams. Filters: Flate (the caller's `inflate`, zlib in main),
 * ASCIIHex, ASCII85. Pure: main runs it on the pasteboard's bytes.
 */
import { invert, meanScale, mul, toPathData, type Mat, type Pt, type Subpath } from "./geometry";

export interface PdfToSvgResult {
  svg: string;
  /** Painted paths written. */
  paths: number;
  skipped: { text: number; images: number };
}

// ---- Objects --------------------------------------------------------------------------------------------------------

interface Name {
  name: string;
}
interface Str {
  str: string;
}
interface Ref {
  ref: number;
}
interface Dict {
  dict: Record<string, Obj>;
}
interface Stream {
  dict: Record<string, Obj>;
  data: Uint8Array;
  stream: true;
}
interface Op {
  op: string;
}
type Obj = number | boolean | null | Name | Str | Ref | Dict | Stream | Obj[] | Op;

const isName = (o: Obj | undefined): o is Name => typeof o === "object" && o !== null && "name" in o;
const isRef = (o: Obj | undefined): o is Ref => typeof o === "object" && o !== null && "ref" in o;
const isDict = (o: Obj | undefined): o is Dict | Stream => typeof o === "object" && o !== null && "dict" in o;
const isStream = (o: Obj | undefined): o is Stream => isDict(o) && "stream" in o;
const isOp = (o: Obj | undefined): o is Op => typeof o === "object" && o !== null && "op" in o;

const WS = new Set([0, 9, 10, 12, 13, 32]);
const DELIM = new Set([40, 41, 60, 62, 91, 93, 123, 125, 47, 37]);

class Lexer {
  constructor(
    readonly b: Uint8Array,
    public pos = 0,
    readonly end = b.length,
  ) {}

  skipWs(): void {
    const b = this.b;
    while (this.pos < this.end) {
      const c = b[this.pos];
      if (WS.has(c)) this.pos++;
      else if (c === 37) {
        while (this.pos < this.end && b[this.pos] !== 10 && b[this.pos] !== 13) this.pos++;
      } else break;
    }
  }

  /** The next object or operator; undefined at the end. `refs`: read `n g R` as a reference. */
  next(refs = true): Obj | undefined {
    this.skipWs();
    if (this.pos >= this.end) return undefined;
    const b = this.b;
    const c = b[this.pos];
    if (c === 47) {
      // A name.
      let s = "";
      this.pos++;
      while (this.pos < this.end && !WS.has(b[this.pos]) && !DELIM.has(b[this.pos])) {
        if (b[this.pos] === 35 && this.pos + 2 < this.end) {
          const h = parseInt(String.fromCharCode(b[this.pos + 1], b[this.pos + 2]), 16);
          if (Number.isFinite(h)) {
            s += String.fromCharCode(h);
            this.pos += 3;
            continue;
          }
        }
        s += String.fromCharCode(b[this.pos++]);
      }
      return { name: s };
    }
    if (c === 40) return { str: this.literal() };
    if (c === 60) {
      if (b[this.pos + 1] === 60) {
        this.pos += 2;
        const dict: Record<string, Obj> = {};
        for (;;) {
          this.skipWs();
          if (this.pos >= this.end) break;
          if (b[this.pos] === 62 && b[this.pos + 1] === 62) {
            this.pos += 2;
            break;
          }
          const k = this.next(refs);
          if (k === undefined) break;
          if (!isName(k)) continue;
          const v = this.next(refs);
          if (v === undefined) break;
          dict[k.name] = v;
        }
        return { dict };
      }
      // A hex string.
      this.pos++;
      let hex = "";
      while (this.pos < this.end && b[this.pos] !== 62) {
        const ch = b[this.pos++];
        if (!WS.has(ch)) hex += String.fromCharCode(ch);
      }
      this.pos++;
      if (hex.length % 2) hex += "0";
      let s = "";
      for (let i = 0; i < hex.length; i += 2) s += String.fromCharCode(parseInt(hex.slice(i, i + 2), 16) || 0);
      return { str: s };
    }
    if (c === 91) {
      this.pos++;
      const arr: Obj[] = [];
      for (;;) {
        this.skipWs();
        if (this.pos >= this.end) break;
        if (b[this.pos] === 93) {
          this.pos++;
          break;
        }
        const v = this.next(refs);
        if (v === undefined) break;
        arr.push(v);
      }
      return arr;
    }
    if (c === 93 || c === 62 || c === 41 || c === 123 || c === 125) {
      this.pos++;
      return { op: String.fromCharCode(c) };
    }
    // A number or a keyword.
    const start = this.pos;
    while (this.pos < this.end && !WS.has(b[this.pos]) && !DELIM.has(b[this.pos])) this.pos++;
    const word = latin1(b, start, this.pos);
    if (/^[+-]?(\d+\.?\d*|\.\d+)$/.test(word)) {
      const n = Number(word);
      if (refs && /^\d+$/.test(word)) {
        const save = this.pos;
        this.skipWs();
        const s2 = this.pos;
        while (this.pos < this.end && b[this.pos] >= 48 && b[this.pos] <= 57) this.pos++;
        if (this.pos > s2) {
          this.skipWs();
          if (b[this.pos] === 82 && (this.pos + 1 >= this.end || WS.has(b[this.pos + 1]) || DELIM.has(b[this.pos + 1]))) {
            this.pos++;
            return { ref: n };
          }
        }
        this.pos = save;
      }
      return n;
    }
    if (word === "true") return true;
    if (word === "false") return false;
    if (word === "null") return null;
    if (!word) {
      this.pos++;
      return { op: "" };
    }
    return { op: word };
  }

  private literal(): string {
    const b = this.b;
    this.pos++;
    let depth = 1;
    let s = "";
    while (this.pos < this.end) {
      const c = b[this.pos++];
      if (c === 92) {
        const e = b[this.pos++];
        if (e === 110) s += "\n";
        else if (e === 114) s += "\r";
        else if (e === 116) s += "\t";
        else if (e === 98) s += "\b";
        else if (e === 102) s += "\f";
        else if (e >= 48 && e <= 55) {
          let o = e - 48;
          for (let k = 0; k < 2 && b[this.pos] >= 48 && b[this.pos] <= 55; k++) o = o * 8 + (b[this.pos++] - 48);
          s += String.fromCharCode(o & 255);
        } else if (e === 13) {
          if (b[this.pos] === 10) this.pos++;
        } else if (e !== 10) s += String.fromCharCode(e);
        continue;
      }
      if (c === 40) depth++;
      else if (c === 41 && --depth === 0) break;
      s += String.fromCharCode(c);
    }
    return s;
  }
}

function latin1(b: Uint8Array, from: number, to: number): string {
  let s = "";
  for (let i = from; i < to; i++) s += String.fromCharCode(b[i]);
  return s;
}

function indexOfBytes(b: Uint8Array, needle: string, from: number): number {
  const first = needle.charCodeAt(0);
  outer: for (let i = from; i <= b.length - needle.length; i++) {
    if (b[i] !== first) continue;
    for (let k = 1; k < needle.length; k++) if (b[i + k] !== needle.charCodeAt(k)) continue outer;
    return i;
  }
  return -1;
}

// ---- The file -------------------------------------------------------------------------------------------------------

type Inflate = (bytes: Uint8Array) => Uint8Array;

class PdfFile {
  private objects = new Map<number, Obj>();

  constructor(
    private bytes: Uint8Array,
    private inflate: Inflate,
  ) {
    this.scan();
  }

  private scan(): void {
    const b = this.bytes;
    let pos = 0;
    while (pos < b.length) {
      const at = indexOfBytes(b, "obj", pos);
      if (at < 0) break;
      // "n g obj": the two numbers just before, at the start of the file or after white space.
      const from = Math.max(0, at - 40);
      const m = /(?:^|[\0\t\n\f\r ])(\d+)\s+(\d+)\s+$/.exec(latin1(b, from, at));
      const nextCh = b[at + 3];
      if (!m || (m.index === 0 && from > 0 && !WS.has(b[from - 1]) && !/^[\0\t\n\f\r ]/.test(m[0])) || (nextCh !== undefined && !WS.has(nextCh) && !DELIM.has(nextCh))) {
        pos = at + 3;
        continue;
      }
      const num = Number(m[1]);
      const lx = new Lexer(b, at + 3);
      const value = lx.next();
      if (value === undefined) break;
      lx.skipWs();
      if (isDict(value) && latin1(b, lx.pos, lx.pos + 6) === "stream") {
        let p = lx.pos + 6;
        if (b[p] === 13) p++;
        if (b[p] === 10) p++;
        const len = value.dict.Length;
        let end = typeof len === "number" && p + len <= b.length && latin1(b, p + len, p + len + 12).includes("endstream") ? p + len : -1;
        if (end < 0) {
          end = indexOfBytes(b, "endstream", p);
          if (end < 0) end = b.length;
          // Trim the end-of-line before "endstream".
          let e = end;
          if (b[e - 1] === 10) e--;
          if (b[e - 1] === 13) e--;
          end = e;
        }
        this.objects.set(num, { dict: value.dict, data: b.subarray(p, end), stream: true });
        const after = indexOfBytes(b, "endstream", end);
        pos = after < 0 ? b.length : after + 9;
      } else {
        this.objects.set(num, value);
        pos = lx.pos;
      }
    }
    // Object streams: their objects, unless already found directly.
    for (const o of [...this.objects.values()]) {
      if (!isStream(o) || nameOf(o.dict.Type) !== "ObjStm") continue;
      const data = this.decode(o);
      if (!data) continue;
      const n = numOf(o.dict.N), first = numOf(o.dict.First);
      const lx = new Lexer(data);
      const pairs: [number, number][] = [];
      for (let i = 0; i < n; i++) {
        const id = lx.next(false), off = lx.next(false);
        if (typeof id !== "number" || typeof off !== "number") break;
        pairs.push([id, off]);
      }
      for (const [id, off] of pairs) {
        if (this.objects.has(id)) continue;
        const v = new Lexer(data, first + off).next();
        if (v !== undefined) this.objects.set(id, v);
      }
    }
  }

  get(o: Obj | undefined, depth = 0): Obj | undefined {
    if (isRef(o) && depth < 32) return this.get(this.objects.get(o.ref), depth + 1);
    return o;
  }
  dict(o: Obj | undefined): Record<string, Obj> | null {
    const v = this.get(o);
    return isDict(v) ? v.dict : null;
  }
  array(o: Obj | undefined): Obj[] {
    const v = this.get(o);
    return Array.isArray(v) ? v : [];
  }
  num(o: Obj | undefined, fallback = 0): number {
    const v = this.get(o);
    return typeof v === "number" ? v : fallback;
  }

  /** A stream's data with its filters undone; null for a filter not supported. */
  decode(s: Stream): Uint8Array | null {
    let data = s.data;
    const f = this.get(s.dict.Filter);
    const filters = Array.isArray(f) ? f.map((x) => nameOf(this.get(x))) : f ? [nameOf(f)] : [];
    for (const name of filters) {
      try {
        if (name === "FlateDecode" || name === "Fl") data = this.inflate(data);
        else if (name === "ASCIIHexDecode" || name === "AHx") data = asciiHex(data);
        else if (name === "ASCII85Decode" || name === "A85") data = ascii85(data);
        else return null;
      } catch {
        return null;
      }
    }
    return data;
  }

  firstPage(): Record<string, Obj> | null {
    let catalog: Record<string, Obj> | null = null;
    for (const o of this.objects.values()) if (isDict(o) && nameOf(o.dict.Type) === "Catalog") catalog = o.dict;
    let node = catalog ? this.dict(catalog.Pages) : null;
    if (!node) {
      for (const o of this.objects.values()) if (isDict(o) && nameOf(o.dict.Type) === "Page") return this.inherit(o.dict);
      return null;
    }
    const chain: Record<string, Obj>[] = [];
    for (let depth = 0; node && depth < 64; depth++) {
      if (nameOf(node.Type) === "Page" || !node.Kids) {
        return { ...Object.assign({}, ...chain.map((c) => pick(c, ["MediaBox", "CropBox", "Resources"]))), ...node };
      }
      chain.push(node);
      node = this.dict(this.array(node.Kids)[0]);
    }
    return null;
  }

  private inherit(page: Record<string, Obj>): Record<string, Obj> {
    const chain: Record<string, Obj>[] = [];
    for (let p = this.dict(page.Parent), d = 0; p && d < 64; p = this.dict(p.Parent), d++) chain.unshift(p);
    return { ...Object.assign({}, ...chain.map((c) => pick(c, ["MediaBox", "CropBox", "Resources"]))), ...page };
  }
}

const pick = (o: Record<string, Obj>, keys: string[]) => Object.fromEntries(keys.filter((k) => k in o).map((k) => [k, o[k]]));
const nameOf = (o: Obj | undefined): string => (isName(o) ? o.name : "");
const numOf = (o: Obj | undefined): number => (typeof o === "number" ? o : 0);

function asciiHex(b: Uint8Array): Uint8Array {
  const out: number[] = [];
  let hi = -1;
  for (const c of b) {
    if (c === 62) break;
    const v = c >= 48 && c <= 57 ? c - 48 : c >= 65 && c <= 70 ? c - 55 : c >= 97 && c <= 102 ? c - 87 : -1;
    if (v < 0) continue;
    if (hi < 0) hi = v;
    else {
      out.push(hi * 16 + v);
      hi = -1;
    }
  }
  if (hi >= 0) out.push(hi * 16);
  return new Uint8Array(out);
}

function ascii85(b: Uint8Array): Uint8Array {
  const out: number[] = [];
  let group: number[] = [];
  let i = 0;
  if (b[0] === 60 && b[1] === 126) i = 2;
  for (; i < b.length; i++) {
    const c = b[i];
    if (c === 126) break;
    if (WS.has(c)) continue;
    if (c === 122 && group.length === 0) {
      out.push(0, 0, 0, 0);
      continue;
    }
    group.push(c - 33);
    if (group.length === 5) {
      let v = 0;
      for (const g of group) v = v * 85 + g;
      out.push((v >>> 24) & 255, (v >>> 16) & 255, (v >>> 8) & 255, v & 255);
      group = [];
    }
  }
  if (group.length > 1) {
    const n = group.length;
    while (group.length < 5) group.push(84);
    let v = 0;
    for (const g of group) v = v * 85 + g;
    const bytes = [(v >>> 24) & 255, (v >>> 16) & 255, (v >>> 8) & 255, v & 255];
    out.push(...bytes.slice(0, n - 1));
  }
  return new Uint8Array(out);
}

// ---- Functions (shadings, tint transforms) --------------------------------------------------------------------------

type Fn = (input: number[]) => number[];

function makeFunction(file: PdfFile, o: Obj | undefined, depth = 0): Fn | null {
  if (depth > 8) return null;
  const v = file.get(o);
  if (Array.isArray(v)) {
    // An array of 1-output functions, one per component.
    const fns = v.map((x) => makeFunction(file, x, depth + 1));
    if (fns.some((f) => !f)) return null;
    return (inp) => fns.map((f) => f!(inp)[0] ?? 0);
  }
  if (!isDict(v)) return null;
  const d = v.dict;
  const type = file.num(d.FunctionType, -1);
  const domain = file.array(d.Domain).map((x) => file.num(x));
  const range = file.array(d.Range).map((x) => file.num(x));
  const clipIn = (x: number, i = 0) => (domain.length >= 2 * (i + 1) ? Math.min(domain[2 * i + 1], Math.max(domain[2 * i], x)) : x);
  const clipOut = (out: number[]) => (range.length ? out.map((y, i) => (range.length >= 2 * (i + 1) ? Math.min(range[2 * i + 1], Math.max(range[2 * i], y)) : y)) : out);
  if (type === 2) {
    const c0 = d.C0 ? file.array(d.C0).map((x) => file.num(x)) : [0];
    const c1 = d.C1 ? file.array(d.C1).map((x) => file.num(x)) : [1];
    const n = file.num(d.N, 1);
    return (inp) => {
      const x = clipIn(inp[0] ?? 0);
      const t = Math.pow(x, n);
      return clipOut(c0.map((a, i) => a + t * ((c1[i] ?? 0) - a)));
    };
  }
  if (type === 3) {
    const fns = file.array(d.Functions).map((x) => makeFunction(file, x, depth + 1));
    if (fns.some((f) => !f) || !fns.length) return null;
    const bounds = file.array(d.Bounds).map((x) => file.num(x));
    const encode = file.array(d.Encode).map((x) => file.num(x));
    const d0 = domain[0] ?? 0, d1 = domain[1] ?? 1;
    return (inp) => {
      const x = clipIn(inp[0] ?? 0);
      let k = 0;
      while (k < bounds.length && x >= bounds[k]) k++;
      const lo = k === 0 ? d0 : bounds[k - 1], hi = k === bounds.length ? d1 : bounds[k];
      const e0 = encode[2 * k] ?? 0, e1 = encode[2 * k + 1] ?? 1;
      const t = hi === lo ? e0 : e0 + ((x - lo) / (hi - lo)) * (e1 - e0);
      return clipOut(fns[k]!([t]));
    };
  }
  if (type === 0 && isStream(v)) {
    const data = file.decode(v);
    const size = file.array(d.Size).map((x) => file.num(x));
    if (!data || size.length !== 1) return null;
    const bps = file.num(d.BitsPerSample, 8);
    const nOut = range.length / 2;
    const encode = d.Encode ? file.array(d.Encode).map((x) => file.num(x)) : [0, size[0] - 1];
    const decode = d.Decode ? file.array(d.Decode).map((x) => file.num(x)) : range;
    const max = Math.pow(2, bps) - 1;
    const sample = (i: number, j: number) => {
      const bit = (i * nOut + j) * bps;
      let v2 = 0;
      for (let k = 0; k < bps; k++) {
        const bb = bit + k;
        v2 = v2 * 2 + ((data[bb >> 3] >> (7 - (bb & 7))) & 1);
      }
      return v2;
    };
    return (inp) => {
      const x = clipIn(inp[0] ?? 0);
      const d0 = domain[0] ?? 0, d1 = domain[1] ?? 1;
      let e = encode[0] + ((x - d0) / (d1 - d0 || 1)) * (encode[1] - encode[0]);
      e = Math.min(size[0] - 1, Math.max(0, e));
      const i0 = Math.floor(e), i1 = Math.min(size[0] - 1, i0 + 1), f = e - i0;
      const out: number[] = [];
      for (let j = 0; j < nOut; j++) {
        const s = sample(i0, j) * (1 - f) + sample(i1, j) * f;
        out.push(decode[2 * j] + (s / max) * (decode[2 * j + 1] - decode[2 * j]));
      }
      return clipOut(out);
    };
  }
  if (type === 4 && isStream(v)) {
    const data = file.decode(v);
    if (!data) return null;
    const prog = parsePostScript(latin1(data, 0, data.length));
    if (!prog) return null;
    return (inp) => {
      const stack = inp.map((x, i) => clipIn(x, i));
      runPostScript(prog, stack);
      return clipOut(stack.slice(-(range.length / 2)));
    };
  }
  return null;
}

type PsProc = (number | string | PsProc)[];

function parsePostScript(text: string): PsProc | null {
  const tokens = text.match(/[{}]|[^\s{}]+/g) ?? [];
  let i = 0;
  const proc = (): PsProc => {
    const out: PsProc = [];
    while (i < tokens.length) {
      const t = tokens[i++];
      if (t === "{") out.push(proc());
      else if (t === "}") return out;
      else out.push(/^[+-]?(\d+\.?\d*|\.\d+)([eE][+-]?\d+)?$/.test(t) ? Number(t) : t);
    }
    return out;
  };
  if (tokens[i] === "{") i++;
  return proc();
}

function runPostScript(prog: PsProc, s: number[], depth = 0): void {
  if (depth > 32) return;
  const pop = () => s.pop() ?? 0;
  for (let i = 0; i < prog.length; i++) {
    const t = prog[i];
    if (typeof t === "number") {
      s.push(t);
      continue;
    }
    if (Array.isArray(t)) {
      // A procedure: an operand of if / ifelse.
      const nextOp = prog[i + 1];
      if (nextOp === "if") {
        if (pop()) runPostScript(t, s, depth + 1);
        i++;
      } else if (Array.isArray(nextOp) && prog[i + 2] === "ifelse") {
        runPostScript(pop() ? t : nextOp, s, depth + 1);
        i += 2;
      }
      continue;
    }
    let a: number, b: number;
    switch (t) {
      case "add": b = pop(); a = pop(); s.push(a + b); break;
      case "sub": b = pop(); a = pop(); s.push(a - b); break;
      case "mul": b = pop(); a = pop(); s.push(a * b); break;
      case "div": b = pop(); a = pop(); s.push(b ? a / b : 0); break;
      case "idiv": b = pop(); a = pop(); s.push(b ? Math.trunc(a / b) : 0); break;
      case "mod": b = pop(); a = pop(); s.push(b ? a % b : 0); break;
      case "neg": s.push(-pop()); break;
      case "abs": s.push(Math.abs(pop())); break;
      case "ceiling": s.push(Math.ceil(pop())); break;
      case "floor": s.push(Math.floor(pop())); break;
      case "round": s.push(Math.round(pop())); break;
      case "truncate": s.push(Math.trunc(pop())); break;
      case "sqrt": s.push(Math.sqrt(Math.max(0, pop()))); break;
      case "sin": s.push(Math.sin((pop() * Math.PI) / 180)); break;
      case "cos": s.push(Math.cos((pop() * Math.PI) / 180)); break;
      case "exp": b = pop(); a = pop(); s.push(Math.pow(a, b)); break;
      case "ln": s.push(Math.log(pop())); break;
      case "log": s.push(Math.log10(pop())); break;
      case "cvi": s.push(Math.trunc(pop())); break;
      case "cvr": break;
      case "dup": a = pop(); s.push(a, a); break;
      case "pop": pop(); break;
      case "exch": b = pop(); a = pop(); s.push(b, a); break;
      case "copy": { const n = pop(); s.push(...s.slice(s.length - n)); break; }
      case "index": { const n = pop(); s.push(s[s.length - 1 - n] ?? 0); break; }
      case "roll": {
        const j = pop(), n = pop();
        if (n > 0 && n <= s.length) {
          const part = s.splice(s.length - n, n);
          const k = ((j % n) + n) % n;
          s.push(...part.slice(n - k), ...part.slice(0, n - k));
        }
        break;
      }
      case "eq": b = pop(); a = pop(); s.push(a === b ? 1 : 0); break;
      case "ne": b = pop(); a = pop(); s.push(a !== b ? 1 : 0); break;
      case "gt": b = pop(); a = pop(); s.push(a > b ? 1 : 0); break;
      case "ge": b = pop(); a = pop(); s.push(a >= b ? 1 : 0); break;
      case "lt": b = pop(); a = pop(); s.push(a < b ? 1 : 0); break;
      case "le": b = pop(); a = pop(); s.push(a <= b ? 1 : 0); break;
      case "and": b = pop(); a = pop(); s.push(a && b ? 1 : 0); break;
      case "or": b = pop(); a = pop(); s.push(a || b ? 1 : 0); break;
      case "not": s.push(pop() ? 0 : 1); break;
      case "true": s.push(1); break;
      case "false": s.push(0); break;
      default: break;
    }
  }
}

// ---- Colour ---------------------------------------------------------------------------------------------------------

type Rgb = [number, number, number];

interface ColorSpace {
  /** Components a colour operator takes. */
  n: number;
  toRgb(c: number[]): Rgb;
  pattern?: boolean;
  initial: number[];
}

const clamp01 = (v: number) => (v < 0 ? 0 : v > 1 ? 1 : Number.isFinite(v) ? v : 0);
const GRAY: ColorSpace = { n: 1, toRgb: (c) => [clamp01(c[0] ?? 0), clamp01(c[0] ?? 0), clamp01(c[0] ?? 0)], initial: [0] };
const RGB: ColorSpace = { n: 3, toRgb: (c) => [clamp01(c[0] ?? 0), clamp01(c[1] ?? 0), clamp01(c[2] ?? 0)], initial: [0, 0, 0] };
/** Naive CMYK → RGB (no profile), as browsers show untagged CMYK. */
const CMYK: ColorSpace = {
  n: 4,
  toRgb: (c) => {
    const k = clamp01(c[3] ?? 0);
    return [(1 - clamp01(c[0] ?? 0)) * (1 - k), (1 - clamp01(c[1] ?? 0)) * (1 - k), (1 - clamp01(c[2] ?? 0)) * (1 - k)];
  },
  initial: [0, 0, 0, 1],
};

function labSpace(white: number[]): ColorSpace {
  const [xw, yw, zw] = [white[0] ?? 0.9642, white[1] ?? 1, white[2] ?? 0.8249];
  return {
    n: 3,
    initial: [0, 0, 0],
    toRgb: ([L = 0, a = 0, b = 0]) => {
      const fy = (L + 16) / 116, fx = fy + a / 500, fz = fy - b / 200;
      const g = (t: number) => (t > 6 / 29 ? t * t * t : 3 * (6 / 29) * (6 / 29) * (t - 4 / 29));
      const X = xw * g(fx), Y = yw * g(fy), Z = zw * g(fz);
      // XYZ (D50) → linear sRGB (Bradford-adapted), then the sRGB curve.
      const r = 3.1338561 * X - 1.6168667 * Y - 0.4906146 * Z;
      const gg = -0.9787684 * X + 1.9161415 * Y + 0.033454 * Z;
      const bb = 0.0719453 * X - 0.2289914 * Y + 1.4052427 * Z;
      const enc = (v: number) => clamp01(v <= 0.0031308 ? 12.92 * v : 1.055 * Math.pow(v, 1 / 2.4) - 0.055);
      return [enc(r), enc(gg), enc(bb)];
    },
  };
}

function deviceByName(name: string): ColorSpace | null {
  if (name === "DeviceGray" || name === "G" || name === "CalGray") return GRAY;
  if (name === "DeviceRGB" || name === "RGB" || name === "CalRGB") return RGB;
  if (name === "DeviceCMYK" || name === "CMYK") return CMYK;
  if (name === "Pattern") return { n: 0, toRgb: () => [0.5, 0.5, 0.5], pattern: true, initial: [] };
  return null;
}

function resolveColorSpace(file: PdfFile, o: Obj | undefined, resources: Record<string, Obj> | null, depth = 0): ColorSpace {
  if (depth > 8) return RGB;
  const v = file.get(o);
  if (isName(v)) {
    const dev = deviceByName(v.name);
    if (dev) return dev;
    const named = file.dict(resources?.ColorSpace)?.[v.name];
    return named !== undefined ? resolveColorSpace(file, named, null, depth + 1) : RGB;
  }
  const arr = Array.isArray(v) ? v : [];
  const family = nameOf(file.get(arr[0]));
  switch (family) {
    case "DeviceGray":
    case "CalGray":
      return GRAY;
    case "DeviceRGB":
    case "CalRGB":
      return RGB;
    case "DeviceCMYK":
      return CMYK;
    case "Lab": {
      const d = file.dict(arr[1]);
      return labSpace(file.array(d?.WhitePoint).map((x) => file.num(x)));
    }
    case "ICCBased": {
      const s = file.get(arr[1]);
      const d = isDict(s) ? s.dict : null;
      if (d?.Alternate) return resolveColorSpace(file, d.Alternate, null, depth + 1);
      const n = file.num(d?.N, 3);
      return n === 1 ? GRAY : n === 4 ? CMYK : RGB;
    }
    case "Indexed":
    case "I": {
      const base = resolveColorSpace(file, arr[1], resources, depth + 1);
      const hival = file.num(arr[2]);
      const lk = file.get(arr[3]);
      let table = "";
      if (isStream(lk)) {
        const data = file.decode(lk);
        table = data ? latin1(data, 0, data.length) : "";
      } else if (typeof lk === "object" && lk !== null && "str" in lk) table = lk.str;
      return {
        n: 1,
        initial: [0],
        toRgb: ([i = 0]) => {
          const k = Math.max(0, Math.min(hival, Math.round(i)));
          const c = Array.from({ length: base.n }, (_, j) => table.charCodeAt(k * base.n + j) / 255);
          return base.toRgb(c);
        },
      };
    }
    case "Separation":
    case "DeviceN": {
      const names = family === "Separation" ? [file.get(arr[1])] : file.array(arr[1]);
      const alt = resolveColorSpace(file, arr[2], resources, depth + 1);
      const fn = makeFunction(file, arr[3]);
      const n = names.length;
      const none = names.every((x) => nameOf(x) === "None");
      return {
        n,
        initial: Array.from({ length: n }, () => 1),
        toRgb: (c) => {
          if (none) return [1, 1, 1];
          if (n === 1 && nameOf(names[0]) === "All") return [1 - clamp01(c[0] ?? 0), 1 - clamp01(c[0] ?? 0), 1 - clamp01(c[0] ?? 0)];
          if (fn) return alt.toRgb(fn(c));
          const t = clamp01(c[0] ?? 0);
          return [1 - t, 1 - t, 1 - t];
        },
      };
    }
    case "Pattern":
      return { n: arr[1] ? resolveColorSpace(file, arr[1], resources, depth + 1).n : 0, toRgb: () => [0.5, 0.5, 0.5], pattern: true, initial: [] };
    default:
      return RGB;
  }
}

// ---- The interpreter ------------------------------------------------------------------------------------------------

interface Clip {
  id: number;
  paths: Subpath[];
  evenOdd: boolean;
}

type PaintVal = { rgb: Rgb } | { gradient: string } | null;

interface GState {
  ctm: Mat;
  /** The pattern space of this content stream (patterns are placed in it, not in the CTM). */
  base: Mat;
  fillCs: ColorSpace;
  strokeCs: ColorSpace;
  fill: PaintVal;
  stroke: PaintVal;
  lw: number;
  cap: number;
  join: number;
  miter: number;
  dash: number[];
  fillAlpha: number;
  strokeAlpha: number;
  clips: Clip[];
}

interface Painted {
  clips: Clip[];
  el: string;
}

const hex2 = (v: number) => Math.round(clamp01(v) * 255).toString(16).padStart(2, "0");
const rgbHex = (c: Rgb) => `#${hex2(c[0])}${hex2(c[1])}${hex2(c[2])}`;
const fmt = (n: number) => String(Math.round(n * 1000) / 1000);
const matText = (m: Mat) => `matrix(${m.map(fmt).join(" ")})`;

class Interpreter {
  painted: Painted[] = [];
  defs: string[] = [];
  skipped = { text: 0, images: 0 };
  paths = 0;
  private nextId = 1;
  private depth = 0;

  constructor(
    private file: PdfFile,
    private page: { w: number; h: number },
  ) {}

  run(content: Uint8Array, resources: Record<string, Obj> | null, gs: GState): void {
    if (this.depth > 12) return;
    this.depth++;
    const file = this.file;
    const lx = new Lexer(content);
    const stack: Obj[] = [];
    const saved: GState[] = [];
    let path: Subpath[] = [];
    let cur: Subpath | null = null;
    let user: Pt = { x: 0, y: 0 }; // the current point, user space
    let pendingClip: boolean | null = null; // W (false) / W* (true) waiting for the painting operator
    let textShown = false;
    const P = (x: number, y: number): Pt => ({ x: gs.ctm[0] * x + gs.ctm[2] * y + gs.ctm[4], y: gs.ctm[1] * x + gs.ctm[3] * y + gs.ctm[5] });
    const nums = (n: number) => stack.slice(-n).map((x) => (typeof x === "number" ? x : 0));
    const moveTo = (x: number, y: number) => {
      cur = { start: P(x, y), segs: [], closed: false };
      path.push(cur);
      user = { x, y };
    };
    const segTo = (seg: { c1?: Pt; c2?: Pt; p: Pt }, u: Pt) => {
      if (!cur) moveTo(u.x, u.y);
      else cur.segs.push(seg);
      user = u;
    };
    const finish = (fill: boolean, stroke: boolean, evenOdd: boolean, close: boolean) => {
      if (close && cur) cur.closed = true;
      const paths = path.filter((sp) => sp.segs.length > 0);
      if (paths.length && (fill || stroke)) this.emit(paths, gs, fill, stroke, evenOdd);
      if (pendingClip !== null && path.length) {
        const clip = this.clip(path, pendingClip);
        if (clip) gs.clips = [...gs.clips, clip];
      }
      pendingClip = null;
      path = [];
      cur = null;
    };
    for (;;) {
      const t = lx.next(false);
      if (t === undefined) break;
      if (!isOp(t)) {
        stack.push(t);
        if (stack.length > 64) stack.shift();
        continue;
      }
      switch (t.op) {
        case "q":
          saved.push({ ...gs });
          break;
        case "Q":
          if (saved.length) gs = saved.pop()!;
          break;
        case "cm": {
          const [a, b, c, d, e, f] = nums(6);
          gs.ctm = mul(gs.ctm, [a, b, c, d, e, f]);
          break;
        }
        case "w":
          gs.lw = nums(1)[0];
          break;
        case "J":
          gs.cap = nums(1)[0];
          break;
        case "j":
          gs.join = nums(1)[0];
          break;
        case "M":
          gs.miter = nums(1)[0];
          break;
        case "d": {
          const arr = stack[stack.length - 2];
          gs.dash = Array.isArray(arr) ? arr.map((x) => (typeof x === "number" ? x : 0)) : [];
          break;
        }
        case "gs": {
          const name = stack[stack.length - 1];
          const d = isName(name) ? file.dict(file.dict(resources?.ExtGState)?.[name.name]) : null;
          if (d) {
            if (typeof file.get(d.LW) === "number") gs.lw = file.num(d.LW);
            if (typeof file.get(d.LC) === "number") gs.cap = file.num(d.LC);
            if (typeof file.get(d.LJ) === "number") gs.join = file.num(d.LJ);
            if (typeof file.get(d.ML) === "number") gs.miter = file.num(d.ML);
            if (typeof file.get(d.ca) === "number") gs.fillAlpha = file.num(d.ca);
            if (typeof file.get(d.CA) === "number") gs.strokeAlpha = file.num(d.CA);
            const D = file.array(d.D);
            if (D.length) gs.dash = file.array(D[0]).map((x) => file.num(x));
          }
          break;
        }
        // Colour.
        case "g":
          gs.fillCs = GRAY;
          gs.fill = { rgb: GRAY.toRgb(nums(1)) };
          break;
        case "G":
          gs.strokeCs = GRAY;
          gs.stroke = { rgb: GRAY.toRgb(nums(1)) };
          break;
        case "rg":
          gs.fillCs = RGB;
          gs.fill = { rgb: RGB.toRgb(nums(3)) };
          break;
        case "RG":
          gs.strokeCs = RGB;
          gs.stroke = { rgb: RGB.toRgb(nums(3)) };
          break;
        case "k":
          gs.fillCs = CMYK;
          gs.fill = { rgb: CMYK.toRgb(nums(4)) };
          break;
        case "K":
          gs.strokeCs = CMYK;
          gs.stroke = { rgb: CMYK.toRgb(nums(4)) };
          break;
        case "cs":
        case "CS": {
          const cs = resolveColorSpace(file, stack[stack.length - 1], resources);
          const value: PaintVal = cs.pattern ? null : { rgb: cs.toRgb(cs.initial) };
          if (t.op === "cs") {
            gs.fillCs = cs;
            gs.fill = value;
          } else {
            gs.strokeCs = cs;
            gs.stroke = value;
          }
          break;
        }
        case "sc":
        case "scn":
        case "SC":
        case "SCN": {
          const fill = t.op === "sc" || t.op === "scn";
          const cs = fill ? gs.fillCs : gs.strokeCs;
          let value: PaintVal;
          const last = stack[stack.length - 1];
          if (cs.pattern && isName(last)) value = this.pattern(last.name, resources, gs);
          else value = { rgb: cs.toRgb(nums(cs.n || 1)) };
          if (fill) gs.fill = value;
          else gs.stroke = value;
          break;
        }
        // Paths.
        case "m": {
          const [x, y] = nums(2);
          moveTo(x, y);
          break;
        }
        case "l": {
          const [x, y] = nums(2);
          segTo({ p: P(x, y) }, { x, y });
          break;
        }
        case "c": {
          const [a, b, c, d, e, f] = nums(6);
          segTo({ c1: P(a, b), c2: P(c, d), p: P(e, f) }, { x: e, y: f });
          break;
        }
        case "v": {
          const [c, d, e, f] = nums(4);
          segTo({ c1: P(user.x, user.y), c2: P(c, d), p: P(e, f) }, { x: e, y: f });
          break;
        }
        case "y": {
          const [a, b, e, f] = nums(4);
          segTo({ c1: P(a, b), c2: P(e, f), p: P(e, f) }, { x: e, y: f });
          break;
        }
        case "h":
          if (cur) {
            (cur as Subpath).closed = true;
            const start = (cur as Subpath).start;
            const inv = invert(gs.ctm);
            if (inv) user = { x: inv[0] * start.x + inv[2] * start.y + inv[4], y: inv[1] * start.x + inv[3] * start.y + inv[5] };
          }
          cur = null;
          break;
        case "re": {
          const [x, y, w, h] = nums(4);
          moveTo(x, y);
          cur!.segs.push({ p: P(x + w, y) }, { p: P(x + w, y + h) }, { p: P(x, y + h) });
          cur!.closed = true;
          cur = null;
          user = { x, y };
          break;
        }
        // Painting.
        case "S":
          finish(false, true, false, false);
          break;
        case "s":
          finish(false, true, false, true);
          break;
        case "f":
        case "F":
          finish(true, false, false, false);
          break;
        case "f*":
          finish(true, false, true, false);
          break;
        case "B":
          finish(true, true, false, false);
          break;
        case "B*":
          finish(true, true, true, false);
          break;
        case "b":
          finish(true, true, false, true);
          break;
        case "b*":
          finish(true, true, true, true);
          break;
        case "n":
          finish(false, false, false, false);
          break;
        case "W":
          pendingClip = false;
          break;
        case "W*":
          pendingClip = true;
          break;
        // Shadings: the innermost clip filled with the gradient.
        case "sh": {
          const name = stack[stack.length - 1];
          const sh = isName(name) ? file.get(file.dict(resources?.Shading)?.[name.name]) : undefined;
          const id = sh !== undefined ? this.gradient(sh, gs.ctm) : null;
          const clip = gs.clips[gs.clips.length - 1];
          if (id && clip) this.emit(clip.paths, { ...gs, clips: gs.clips.slice(0, -1), fill: { gradient: id } }, true, false, clip.evenOdd);
          break;
        }
        // XObjects.
        case "Do": {
          const name = stack[stack.length - 1];
          const xo = isName(name) ? file.get(file.dict(resources?.XObject)?.[name.name]) : undefined;
          if (!isStream(xo)) break;
          const sub = nameOf(file.get(xo.dict.Subtype));
          if (sub === "Image") {
            this.skipped.images++;
          } else if (sub === "Form") {
            const data = file.decode(xo);
            if (!data) break;
            const m = file.array(xo.dict.Matrix).map((x) => file.num(x));
            const ctm = m.length === 6 ? mul(gs.ctm, m as Mat) : gs.ctm;
            this.run(data, file.dict(xo.dict.Resources) ?? resources, { ...gs, ctm, base: ctm });
          }
          break;
        }
        case "BI": {
          // An inline image: skip to EI.
          this.skipped.images++;
          const id = indexOfBytes(content, "ID", lx.pos);
          let p = id < 0 ? content.length : id + 3;
          for (; p < content.length - 1; p++) {
            if (content[p] === 69 && content[p + 1] === 73 && WS.has(content[p - 1]) && (p + 2 >= content.length || WS.has(content[p + 2]))) break;
          }
          lx.pos = p + 2;
          break;
        }
        // Text: counted, not drawn.
        case "BT":
          textShown = false;
          break;
        case "Tj":
        case "TJ":
        case "'":
        case '"':
          textShown = true;
          break;
        case "ET":
          if (textShown) this.skipped.text++;
          textShown = false;
          break;
        default:
          break;
      }
      stack.length = 0;
    }
    this.depth--;
  }

  /** A shading pattern's gradient (tiling patterns: a mid grey, as nothing better can stand in). */
  private pattern(name: string, resources: Record<string, Obj> | null, gs: GState): PaintVal {
    const file = this.file;
    const p = file.get(file.dict(resources?.Pattern)?.[name]);
    if (!isDict(p)) return null;
    if (file.num(p.dict.PatternType) !== 2) return { rgb: [0.5, 0.5, 0.5] };
    const m = file.array(p.dict.Matrix).map((x) => file.num(x));
    const id = this.gradient(file.get(p.dict.Shading), m.length === 6 ? mul(gs.base, m as Mat) : gs.base);
    return id ? { gradient: id } : { rgb: [0.5, 0.5, 0.5] };
  }

  /** An axial / radial shading as an SVG gradient in `m`'s space; its id, or null. */
  private gradient(o: Obj | undefined, m: Mat): string | null {
    const file = this.file;
    const sh = isDict(o) ? o.dict : null;
    if (!sh) return null;
    const type = file.num(sh.ShadingType);
    if (type !== 2 && type !== 3) return null;
    const cs = resolveColorSpace(file, sh.ColorSpace, null);
    const fn = makeFunction(file, sh.Function);
    if (!fn) return null;
    const domain = file.array(sh.Domain).map((x) => file.num(x));
    const t0 = domain[0] ?? 0, t1 = domain[1] ?? 1;
    const coords = file.array(sh.Coords).map((x) => file.num(x));
    // Stops: the stitching bounds when the function is stitched, else even samples.
    const fd = file.dict(sh.Function);
    let ts: number[] = [];
    if (fd && file.num(fd.FunctionType) === 3) ts = [t0, ...file.array(fd.Bounds).map((x) => file.num(x)), t1];
    else if (fd && file.num(fd.FunctionType) === 2 && file.num(fd.N, 1) === 1) ts = [t0, t1];
    else ts = Array.from({ length: 17 }, (_, i) => t0 + ((t1 - t0) * i) / 16);
    let r0 = 0;
    if (type === 3) r0 = coords[2] ?? 0;
    const r1 = type === 3 ? (coords[5] ?? 0) : 0;
    const stops = ts.map((t) => {
      let pos = t1 === t0 ? 0 : (t - t0) / (t1 - t0);
      if (type === 3 && r1 > 0) pos = r0 / r1 + pos * (1 - r0 / r1);
      return `<stop offset="${fmt(clamp01(pos))}" stop-color="${rgbHex(cs.toRgb(fn([t])))}"/>`;
    });
    const id = `g${this.nextId++}`;
    if (type === 2) {
      const [x0 = 0, y0 = 0, x1 = 1, y1 = 0] = coords;
      this.defs.push(`<linearGradient id="${id}" gradientUnits="userSpaceOnUse" x1="${fmt(x0)}" y1="${fmt(y0)}" x2="${fmt(x1)}" y2="${fmt(y1)}" gradientTransform="${matText(m)}">${stops.join("")}</linearGradient>`);
    } else {
      const [, , , x1 = 0, y1 = 0] = coords;
      this.defs.push(`<radialGradient id="${id}" gradientUnits="userSpaceOnUse" cx="${fmt(x1)}" cy="${fmt(y1)}" r="${fmt(r1)}" gradientTransform="${matText(m)}">${stops.join("")}</radialGradient>`);
    }
    return id;
  }

  private clip(paths: Subpath[], evenOdd: boolean): Clip | null {
    const live = paths.filter((sp) => sp.segs.length > 0);
    if (!live.length) return null;
    // A rectangle covering the whole page clips nothing (Illustrator's artboard clip): left out.
    if (live.length === 1 && live[0].segs.length >= 3 && live[0].segs.length <= 4 && live[0].segs.every((s) => !s.c1)) {
      const pts = [live[0].start, ...live[0].segs.map((s) => s.p)];
      const xs = pts.map((p) => p.x), ys = pts.map((p) => p.y);
      const axis = pts.every((p, i) => {
        const q = pts[(i + 1) % pts.length];
        return Math.abs(p.x - q.x) < 1e-3 || Math.abs(p.y - q.y) < 1e-3;
      });
      if (axis && Math.min(...xs) <= 0.5 && Math.min(...ys) <= 0.5 && Math.max(...xs) >= this.page.w - 0.5 && Math.max(...ys) >= this.page.h - 0.5) return null;
    }
    const id = this.nextId++;
    this.defs.push(`<clipPath id="c${id}"><path d="${toPathData(live)}"${evenOdd ? ' clip-rule="evenodd"' : ""}/></clipPath>`);
    return { id, paths: live, evenOdd };
  }

  private emit(paths: Subpath[], gs: GState, fill: boolean, stroke: boolean, evenOdd: boolean): void {
    let attrs = "";
    const paintAttr = (v: PaintVal) => (!v ? null : "gradient" in v ? `url(#${v.gradient})` : rgbHex(v.rgb));
    const f = fill ? paintAttr(gs.fill ?? { rgb: [0, 0, 0] }) : null;
    attrs += ` fill="${f ?? "none"}"`;
    if (f && gs.fillAlpha < 1) attrs += ` fill-opacity="${fmt(gs.fillAlpha)}"`;
    if (f && evenOdd) attrs += ' fill-rule="evenodd"';
    const s = stroke ? paintAttr(gs.stroke ?? { rgb: [0, 0, 0] }) : null;
    if (s) {
      const k = meanScale(gs.ctm);
      attrs += ` stroke="${s}" stroke-width="${fmt(gs.lw > 0 ? gs.lw * k : 1)}"`;
      if (gs.strokeAlpha < 1) attrs += ` stroke-opacity="${fmt(gs.strokeAlpha)}"`;
      if (gs.cap === 1) attrs += ' stroke-linecap="round"';
      else if (gs.cap === 2) attrs += ' stroke-linecap="square"';
      if (gs.join === 1) attrs += ' stroke-linejoin="round"';
      else if (gs.join === 2) attrs += ' stroke-linejoin="bevel"';
      if (gs.miter !== 4 && gs.join === 0) attrs += ` stroke-miterlimit="${fmt(gs.miter)}"`;
      if (gs.dash.length && gs.dash.some((d) => d > 0)) attrs += ` stroke-dasharray="${gs.dash.map((d) => fmt(d * k)).join(" ")}"`;
    }
    if (!f && !s) return;
    this.paths++;
    this.painted.push({ clips: gs.clips, el: `<path d="${toPathData(paths)}"${attrs}/>` });
  }
}

/** The first page of a PDF as SVG, its vector content as paths; null when it is not a PDF or has no page. */
export function pdfToSvg(bytes: Uint8Array, inflate: Inflate): PdfToSvgResult | null {
  if (latin1(bytes, 0, Math.min(bytes.length, 1024)).indexOf("%PDF") < 0) return null;
  const file = new PdfFile(bytes, inflate);
  const page = file.firstPage();
  if (!page) return null;
  const box = file.array(page.CropBox ?? page.MediaBox).map((x) => file.num(x));
  const [x0, y0, x1, y1] = box.length === 4 ? box : [0, 0, 612, 792];
  const w = Math.abs(x1 - x0), h = Math.abs(y1 - y0);
  // PDF's y goes up: the page flipped into SVG's y-down space, its top-left at 0, 0.
  const flip: Mat = [1, 0, 0, -1, -Math.min(x0, x1), Math.max(y0, y1)];
  const contents = file.get(page.Contents);
  const parts = Array.isArray(contents) ? contents.map((c) => file.get(c)) : [contents];
  const chunks: Uint8Array[] = [];
  for (const p of parts) {
    if (!isStream(p)) continue;
    const data = file.decode(p);
    if (data) chunks.push(data, new Uint8Array([10]));
  }
  const content = new Uint8Array(chunks.reduce((n, c) => n + c.length, 0));
  let at = 0;
  for (const c of chunks) {
    content.set(c, at);
    at += c.length;
  }
  const interp = new Interpreter(file, { w, h });
  const gs: GState = { ctm: flip, base: flip, fillCs: GRAY, strokeCs: GRAY, fill: { rgb: [0, 0, 0] }, stroke: { rgb: [0, 0, 0] }, lw: 1, cap: 0, join: 0, miter: 10, dash: [], fillAlpha: 1, strokeAlpha: 1, clips: [] };
  interp.run(content, file.dict(page.Resources), gs);
  // Painted paths in order, each run under the same clips inside one group per clip.
  let body = "";
  let open: Clip[] = [];
  for (const p of interp.painted) {
    let common = 0;
    while (common < open.length && common < p.clips.length && open[common] === p.clips[common]) common++;
    body += "</g>".repeat(open.length - common);
    for (const c of p.clips.slice(common)) body += `<g clip-path="url(#c${c.id})">`;
    open = p.clips;
    body += p.el;
  }
  body += "</g>".repeat(open.length);
  const defs = interp.defs.length ? `<defs>${interp.defs.join("")}</defs>` : "";
  return {
    svg: `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${fmt(w)} ${fmt(h)}">${defs}${body}</svg>`,
    paths: interp.paths,
    skipped: interp.skipped,
  };
}

