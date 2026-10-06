import { createHash } from "node:crypto";
import { mkdir, open, readdir, readFile, stat, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { app } from "electron";
import type { FontFaceInfo, FontIndex } from "../shared/ipc";

/**
 * The installed fonts (docs/desktop.md §14): the system's and the user's
 * TTF / OTF / TTC / OTC files, read just enough to list their faces (`name`,
 * `OS/2`, `fvar`: a variable font lists its named instances), cached in
 * `userData/cache/fonts-v1.json` by path + mtime + size so only new or
 * changed files are parsed again. Views get the index (`fonts:list`, no
 * paths) and a face's whole file (`fonts:read`), which the engine parses.
 *
 * Interim (minimal): in the main process, on the first `fonts:list`, not yet
 * the separate fonts utility process §14 describes; no `fs.watch` rescan.
 */

const VERSION = 1;
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
      if (instances.length) faces.push(...instances);
      else faces.push({ id, family, style, postscriptName, weight, italic, stretch, source, collectionIndex: index });
    }
    return faces;
  } finally {
    await fh.close();
  }
}

// ---- Index --------------------------------------------------------------------------------

const cachePath = () => join(app.getPath("userData"), "cache", "fonts-v1.json");

async function buildIndex(): Promise<FontIndex> {
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
  return { version: VERSION, faces };
}

/** The installed fonts (scanned once per launch). */
export function fontIndex(): Promise<FontIndex> {
  indexing ??= buildIndex().catch((error: unknown) => {
    indexing = null;
    throw error;
  });
  return indexing;
}

/** A face's whole font file. */
export async function readFont(id: string): Promise<Uint8Array> {
  if (!paths.has(id)) await fontIndex();
  const path = paths.get(id);
  if (!path) throw new Error(`fonts: no face ${id}`);
  return new Uint8Array(await readFile(path));
}
