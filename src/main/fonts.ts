import { createHash } from "node:crypto";
import { watch, type FSWatcher } from "node:fs";
import { mkdir, open, readdir, readFile, stat, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { app, webContents } from "electron";
import type { FontFaceInfo, FontIndex } from "../shared/ipc";
import { googleCatalog, googleFontPath, onGoogleCatalogChanged, setGoogleFontsRoot } from "./googleFonts";
import { viewOf } from "./views";

/**
 * The installed fonts (docs/desktop.md §14): the system's and the user's
 * TTF / OTF / TTC / OTC files, read just enough to list their faces (`name`,
 * `OS/2`, `fvar`: a variable font lists its named instances), cached in
 * `userData/cache/fonts-v1.json` by path + mtime + size so only new or
 * changed files are parsed again. Views get the index (`fonts:list`, no
 * paths) and a face's whole file (`fonts:read`), which the engine parses.
 *
 * The index also carries the Google Fonts catalog (`googleFonts.ts`): a
 * Google face's id downloads its file on the first `fonts:read`.
 *
 * Font folders are watched (`watchFonts`): a font installed or removed while
 * the app runs is rescanned and every view hears `fonts:changed`, as Figma's
 * font helper does. Interim: in the main process, not yet the separate fonts
 * utility process §14 describes.
 */

const VERSION = 2;
const EXTENSIONS = /\.(ttf|otf|ttc|otc)$/i;

interface CachedFile {
  mtimeMs: number;
  size: number;
  faces: FontFaceInfo[];
}
interface Cache {
  version: number;
  files: Record<string, CachedFile>;
}

let indexing: Promise<FontIndex> | null = null;
const paths = new Map<string, string>(); // face id → file path
const collectionIndices = new Map<string, number>(); // face id → its index in a collection (0 for a single-face file)

/** Where fonts live on this platform: [directory, source]. */
function fontDirs(): [string, FontFaceInfo["source"]][] {
  const home = homedir();
  if (process.platform === "darwin")
    return [
      ["/System/Library/Fonts", "system"],
      ["/System/Library/AssetsV2", "system"],
      ["/Library/Fonts", "user"],
      [join(home, "Library/Fonts"), "user"],
    ];
  if (process.platform === "win32")
    return [
      [join(process.env.WINDIR ?? "C:\\Windows", "Fonts"), "system"],
      [join(process.env.LOCALAPPDATA ?? join(home, "AppData/Local"), "Microsoft/Windows/Fonts"), "user"],
    ];
  return [
    ["/usr/share/fonts", "system"],
    ["/usr/local/share/fonts", "system"],
    [join(home, ".fonts"), "user"],
    [join(home, ".local/share/fonts"), "user"],
  ];
}

async function walk(dir: string, out: string[], depth = 0): Promise<void> {
  if (depth > 8) return;
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const e of entries) {
    const p = join(dir, e.name);
    if (e.isDirectory()) {
      // Downloaded system fonts: AssetsV2/com_apple_MobileAsset_Font*/…/AssetData/*.
      if (depth === 0 && dir.endsWith("AssetsV2") && !e.name.startsWith("com_apple_MobileAsset_Font")) continue;
      await walk(p, out, depth + 1);
    } else if (EXTENSIONS.test(e.name)) {
      out.push(p);
    }
  }
}

// ---- sfnt ---------------------------------------------------------------------------------

interface Table {
  offset: number;
  length: number;
}

async function readAt(fh: Awaited<ReturnType<typeof open>>, offset: number, length: number): Promise<Buffer> {
  const buf = Buffer.alloc(length);
  const { bytesRead } = await fh.read(buf, 0, length, offset);
  return buf.subarray(0, bytesRead);
}

function nameStrings(name: Buffer): Map<number, string> {
  const out = new Map<number, string>();
  const rank = new Map<number, number>();
  if (name.length < 6) return out;
  const count = name.readUInt16BE(2), stringOffset = name.readUInt16BE(4);
  for (let i = 0; i < count; i++) {
    const r = 6 + i * 12;
    if (r + 12 > name.length) break;
    const platform = name.readUInt16BE(r), encoding = name.readUInt16BE(r + 2), language = name.readUInt16BE(r + 4);
    const id = name.readUInt16BE(r + 6), length = name.readUInt16BE(r + 8), offset = name.readUInt16BE(r + 10);
    const start = stringOffset + offset;
    if (start + length > name.length) continue;
    // Windows English first, then Unicode, then Mac Roman English.
    let score = -1;
    let text = "";
    const raw = name.subarray(start, start + length);
    if (platform === 3 && (encoding === 1 || encoding === 10) && length % 2 === 0) {
      score = language === 0x409 ? 3 : 1;
      text = Buffer.from(raw).swap16().toString("utf16le");
    } else if (platform === 0 && length % 2 === 0) {
      score = 2;
      text = Buffer.from(raw).swap16().toString("utf16le");
    } else if (platform === 1 && encoding === 0 && language === 0) {
      score = 0;
      text = raw.toString("latin1");
    }
    if (score >= 0 && text && score > (rank.get(id) ?? -1)) {
      out.set(id, text);
      rank.set(id, score);
    }
  }
  return out;
}

const faceId = (path: string, index: number) => createHash("sha1").update(`${path}#${index}`).digest("hex").slice(0, 16);

/** The faces of one font file (exported for tests). */
export async function parseFile(path: string, source: FontFaceInfo["source"]): Promise<FontFaceInfo[]> {
  const fh = await open(path, "r");
  try {
    const head = await readAt(fh, 0, 12);
    if (head.length < 12) return [];
    let offsets = [0];
    if (head.toString("latin1", 0, 4) === "ttcf") {
      const n = Math.min(head.readUInt32BE(8), 64);
      const dir = await readAt(fh, 12, n * 4);
      offsets = Array.from({ length: Math.floor(dir.length / 4) }, (_, i) => dir.readUInt32BE(i * 4));
    }
    const faces: FontFaceInfo[] = [];
    for (let index = 0; index < offsets.length; index++) {
      const base = offsets[index];
      const header = await readAt(fh, base, 12);
      if (header.length < 12) continue;
      const tag = header.readUInt32BE(0);
      if (tag !== 0x00010000 && tag !== 0x4f54544f /* OTTO */ && tag !== 0x74727565 /* true */) continue;
      const numTables = header.readUInt16BE(4);
      const records = await readAt(fh, base + 12, numTables * 16);
      const tables = new Map<string, Table>();
      for (let t = 0; t + 16 <= records.length; t += 16)
        tables.set(records.toString("latin1", t, t + 4), { offset: records.readUInt32BE(t + 8), length: records.readUInt32BE(t + 12) });
      const nameT = tables.get("name");
      if (!nameT) continue;
      const names = nameStrings(await readAt(fh, nameT.offset, nameT.length));
      const family = names.get(16) ?? names.get(1);
      const style = names.get(17) ?? names.get(2) ?? "Regular";
      if (!family || family.startsWith(".")) continue; // hidden system faces (".SF NS")
      let weight = 400, stretch = 5, italic = /italic|oblique/i.test(style);
      const os2 = tables.get("OS/2");
      if (os2) {
        const b = await readAt(fh, os2.offset, Math.min(os2.length, 64));
        if (b.length >= 8) {
          weight = b.readUInt16BE(4) || 400;
          stretch = b.readUInt16BE(6) || 5;
        }
        if (b.length >= 64) italic ||= (b.readUInt16BE(62) & 0x201) !== 0;
      }
      const id = faceId(path, index);
      const postscriptName = names.get(6) ?? "";
      const fvar = tables.get("fvar");
      const instances: FontFaceInfo[] = [];
      if (fvar) {
        // A variable font: one face per named instance.
        const f = await readAt(fh, fvar.offset, fvar.length);
        if (f.length >= 16) {
          const axesOffset = f.readUInt16BE(4), axisCount = f.readUInt16BE(8), axisSize = f.readUInt16BE(10);
          const instanceCount = f.readUInt16BE(12), instanceSize = f.readUInt16BE(14);
          let wght = -1, ital = -1;
          for (let a = 0; a < axisCount; a++) {
            const at = axesOffset + a * axisSize;
            if (at + 4 > f.length) break;
            const t = f.toString("latin1", at, at + 4);
            if (t === "wght") wght = a;
            if (t === "ital") ital = a;
          }
          for (let i = 0; i < instanceCount; i++) {
            const at = axesOffset + axisCount * axisSize + i * instanceSize;
            if (at + 4 + axisCount * 4 > f.length) break;
            const sub = names.get(f.readUInt16BE(at));
            if (!sub) continue;
            const coord = (axis: number) => f.readInt32BE(at + 4 + axis * 4) / 65536;
            instances.push({
              id, family, style: sub, postscriptName, weight: wght >= 0 ? Math.round(coord(wght)) : weight,
              italic: ital >= 0 ? coord(ital) > 0.5 : italic || /italic|oblique/i.test(sub), stretch, source, collectionIndex: index,
            });
          }
        }
      }
      if (instances.length) faces.push(...instances.map((f) => ({ ...f, variable: true })));
      else faces.push({ id, family, style, postscriptName, weight, italic, stretch, source, collectionIndex: index, ...(fvar ? { variable: true } : {}) });
    }
    return faces;
  } finally {
    await fh.close();
  }
}

// ---- Index --------------------------------------------------------------------------------

const cachePath = () => join(app.getPath("userData"), "cache", `fonts-v${VERSION}.json`);

/** Bumped on every change of the installed fonts (the `fonts:changed` event carries it). */
let indexVersion = 1;

let googleRootSet = false;

async function buildIndex(): Promise<FontIndex> {
  if (!googleRootSet) {
    googleRootSet = true;
    setGoogleFontsRoot(app.getPath("userData"));
  }
  const [local, google] = await Promise.all([scanLocal(), googleCatalog().catch(() => [])]);
  return { version: indexVersion, faces: local, google };
}

async function scanLocal(): Promise<FontFaceInfo[]> {
  let cache: Cache = { version: VERSION, files: {} };
  try {
    const read = JSON.parse(await readFile(cachePath(), "utf8")) as Cache;
    if (read.version === VERSION && read.files) cache = read;
  } catch {
    // no cache yet
  }
  const next: Cache = { version: VERSION, files: {} };
  const faces: FontFaceInfo[] = [];
  for (const [dir, source] of fontDirs()) {
    const files: string[] = [];
    await walk(dir, files);
    for (const path of files) {
      try {
        const s = await stat(path);
        const hit = cache.files[path];
        const entry =
          hit && hit.mtimeMs === s.mtimeMs && hit.size === s.size ? hit : { mtimeMs: s.mtimeMs, size: s.size, faces: await parseFile(path, source) };
        next.files[path] = entry;
        for (const f of entry.faces) {
          paths.set(f.id, path);
          collectionIndices.set(f.id, f.collectionIndex);
          faces.push(f);
        }
      } catch {
        // unreadable or malformed: skipped
      }
    }
  }
  try {
    await mkdir(dirname(cachePath()), { recursive: true });
    await writeFile(cachePath(), JSON.stringify(next));
  } catch {
    // the cache is an optimisation
  }
  faces.sort((a, b) => a.family.localeCompare(b.family) || a.weight - b.weight || Number(a.italic) - Number(b.italic));
  return faces;
}

/** Builds the index ahead of the first view's `fonts:list` (the cached JSON makes it a few ms; a first scan more). */
export function warmFontIndex(): void {
  void fontIndex().catch(() => {});
}

/** The installed fonts (scanned once per launch). */
export function fontIndex(): Promise<FontIndex> {
  indexing ??= buildIndex().catch((error: unknown) => {
    indexing = null;
    throw error;
  });
  return indexing;
}

// ---- Watching ----------------------------------------------------------------------------

/** The folders a user installs fonts into (and the system's own, which only an update changes). */
export function watchedFontDirs(): string[] {
  return fontDirs()
    .filter(([dir, source]) => source === "user" || !dir.includes("AssetsV2"))
    .map(([dir]) => dir);
}

/** A signature of the faces (what a picker shows): equal before and after a rescan → nothing to tell. */
export const facesSignature = (faces: readonly FontFaceInfo[]) => faces.map((f) => `${f.id}\t${f.family}\t${f.style}`).join("\n");

/**
 * Watches the font folders (recursively where the platform can) and, a moment after the last change, rescans them;
 * when the faces differ `changed(version)` is called (main sends `fonts:changed` to every view). The Google catalog's
 * background refresh reports the same way. Returns a stop.
 */
export function watchFonts(changed: (version: number) => void, options: { dirs?: string[]; debounceMs?: number; rescan?: () => Promise<FontFaceInfo[]> } = {}): () => void {
  let timer: ReturnType<typeof setTimeout> | null = null;
  let last: string | null = null;
  const rescan = options.rescan ?? scanLocal;
  const first = options.rescan ? rescan() : fontIndex().then((i) => i.faces);
  void first.then((faces) => (last ??= facesSignature(faces))).catch(() => {});
  const run = async () => {
    timer = null;
    try {
      const faces = await rescan();
      const sig = facesSignature(faces);
      if (sig === last) return;
      last = sig;
      indexVersion++;
      const google = await googleCatalog().catch(() => []);
      indexing = Promise.resolve({ version: indexVersion, faces, google });
      changed(indexVersion);
    } catch {
      // the next change tries again
    }
  };
  const poke = () => {
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => void run(), options.debounceMs ?? 600);
  };
  const own: FSWatcher[] = [];
  for (const dir of options.dirs ?? watchedFontDirs()) {
    try {
      const w = watch(dir, { recursive: process.platform !== "linux", persistent: false }, (_event, name) => {
        if (!name || EXTENSIONS.test(String(name)) || !String(name).includes(".")) poke();
      });
      w.on("error", () => {});
      own.push(w);
    } catch {
      // a folder that doesn't exist (no ~/Library/Fonts yet): nothing to watch
    }
  }
  onGoogleCatalogChanged(() => {
    indexVersion++;
    indexing = null;
    changed(indexVersion);
  });
  return () => {
    if (timer) clearTimeout(timer);
    for (const w of own) w.close();
  };
}

/** Starts watching at launch: every editor view hears `fonts:changed` and reads the list again. */
export function startFontWatch(): () => void {
  return watchFonts((version) => {
    for (const contents of webContents.getAllWebContents())
      if (viewOf(contents)?.role === "editor" && !contents.isDestroyed()) contents.send("fonts:changed", { version });
  });
}

/**
 * A face's font file for the engine. A single-face file (TTF, OTF, a variable font) is read whole. A collection
 * (TTC / OTC — Helvetica, PingFang, Hiragino: tens of MB, every face of a family in one file) is **sliced** to the
 * one face asked for: its tables alone, in a collection header that still lists it at its `collectionIndex` (every
 * entry before it points at the same face), so the engine's `engine_font_add_take(bytes, collectionIndex)` reads
 * it as before. A 74 MB file crossed the IPC and lived in the Wasm heap for one face of ~10 MB.
 */
export async function readFont(id: string): Promise<Uint8Array> {
  if (id.startsWith("g:")) return new Uint8Array(await readFile(await googleFontPath(id)));
  if (!paths.has(id)) await fontIndex();
  const path = paths.get(id);
  if (!path) throw new Error(`fonts: no face ${id}`);
  const index = collectionIndices.get(id) ?? 0;
  const fh = await open(path, "r");
  try {
    const head = await readAt(fh, 0, 12);
    if (head.length < 12 || head.toString("latin1", 0, 4) !== "ttcf") return new Uint8Array(await readFile(path));
    const n = head.readUInt32BE(8);
    if (index >= n) throw new Error(`fonts: face ${index} is not in the collection`);
    const dir = await readAt(fh, 12, n * 4);
    const base = dir.readUInt32BE(index * 4);
    const sliced = await sliceFace(fh, base, index);
    return sliced ?? new Uint8Array(await readFile(path));
  } finally {
    await fh.close();
  }
}

/**
 * One face of a collection as a collection of its own: a `ttcf` header (version 1, `index + 1` entries, all at the
 * face's offset table), the face's table directory with new offsets, then its tables, each 4-byte aligned. Null
 * when the face's header isn't an sfnt (the whole file is sent instead).
 */
export async function sliceFace(fh: Awaited<ReturnType<typeof open>>, base: number, index: number): Promise<Uint8Array | null> {
  const header = await readAt(fh, base, 12);
  if (header.length < 12) return null;
  const tag = header.readUInt32BE(0);
  if (tag !== 0x00010000 && tag !== 0x4f54544f /* OTTO */ && tag !== 0x74727565 /* true */) return null;
  const numTables = header.readUInt16BE(4);
  const records = await readAt(fh, base + 12, numTables * 16);
  const tables: { tag: Buffer; checksum: number; offset: number; length: number }[] = [];
  for (let t = 0; t + 16 <= records.length; t += 16) tables.push({ tag: records.subarray(t, t + 4), checksum: records.readUInt32BE(t + 4), offset: records.readUInt32BE(t + 8), length: records.readUInt32BE(t + 12) });
  const align = (x: number) => (x + 3) & ~3;
  const ttcHeader = 12 + (index + 1) * 4;
  const faceStart = ttcHeader;
  const dirSize = 12 + tables.length * 16;
  let at = align(faceStart + dirSize);
  const placed = tables.map((t) => {
    const offset = at;
    at = align(at + t.length);
    return { ...t, newOffset: offset };
  });
  const out = Buffer.alloc(at);
  out.write("ttcf", 0, "latin1");
  out.writeUInt32BE(0x00010000, 4);
  out.writeUInt32BE(index + 1, 8);
  for (let i = 0; i <= index; i++) out.writeUInt32BE(faceStart, 12 + i * 4);
  header.copy(out, faceStart, 0, 12);
  for (let i = 0; i < placed.length; i++) {
    const t = placed[i];
    const r = faceStart + 12 + i * 16;
    t.tag.copy(out, r);
    out.writeUInt32BE(t.checksum, r + 4);
    out.writeUInt32BE(t.newOffset, r + 8);
    out.writeUInt32BE(t.length, r + 12);
    const { bytesRead } = await fh.read(out, t.newOffset, t.length, t.offset);
    if (bytesRead !== t.length) return null;
  }
  return new Uint8Array(out.buffer, out.byteOffset, out.byteLength);
}
