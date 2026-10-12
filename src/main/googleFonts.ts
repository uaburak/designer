import { createHash } from "node:crypto";
import { mkdir, readFile, rename, stat, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import {
  CATALOG_URL, DOWNLOAD_LIST, LICENSE_DIRS, PREVIEW_CSS, familyDir, googleStyleName, isSfnt, parseCatalog, parseGoogleFaceId, parseMetadataPb, pickFile, metadataUrl, repoFileUrl,
  type FamilyFiles,
} from "../shared/fonts/google";
import type { GoogleFontFamily } from "../shared/ipc";
import { mainFetch } from "./net";

/**
 * Google Fonts, as Figma serves them (docs/desktop.md §14.1, docs/research/figma/R11-fonts.md): every family of the
 * Google Fonts catalog is in the font picker; a family's file is downloaded the first time a text uses it and kept,
 * so it works offline afterwards (one not downloaded yet is missing while offline).
 *
 * - **Catalog**: `fonts.google.com/metadata/fonts` (no API key; family, category, popularity, axes, weights), reduced to
 *   `GoogleFontFamily` and cached in `userData/cache/google-fonts-v1.json`; refreshed in the background when older than
 *   a week. The list goes to views inside `fonts:list` (no paths, no URLs).
 * - **Files**: the TTFs of the google/fonts repository — the very bytes Figma lays text out with (the SHA-1 digests
 *   Figma stores in a file's `derivedTextData.fontMetaData` equal the repository's files, not the re-encoded ones
 *   fonts.gstatic.com serves; R11). A family's `METADATA.pb` names its files; a variable family is one file per slant
 *   (every style is a named instance of it), a static family one file per style. Cached under
 *   `userData/fonts/google/<dir>/`. When the repository can't be reached the files of `fonts.google.com/download/list`
 *   are used instead (same outlines, other bytes).
 *
 * Everything that touches the network goes through `setFetch` (tests mock it).
 */

const CATALOG_VERSION = 1;
const REFRESH_MS = 7 * 24 * 3600 * 1000;
const TIMEOUT_MS = 30_000;

type Fetch = (url: string, init?: { headers?: Record<string, string>; signal?: AbortSignal }) => Promise<{ ok: boolean; status: number; text(): Promise<string>; arrayBuffer(): Promise<ArrayBuffer> }>;

let fetcher: Fetch = (url, init) => mainFetch(url, init);
let root = "";

/** Where the catalog and the files are kept (main sets `userData` at start; tests a temporary folder). */
export function setGoogleFontsRoot(dir: string): void {
  root = dir;
  catalogLoad = null;
  metadataCache.clear();
  downloads.clear();
  previews.clear();
}

/** The network (tests replace it). */
export function setFetch(f: Fetch): void {
  fetcher = f;
}

async function get(url: string, headers?: Record<string, string>): Promise<{ ok: boolean; status: number; text(): Promise<string>; arrayBuffer(): Promise<ArrayBuffer> }> {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), TIMEOUT_MS);
  try {
    return await fetcher(url, { headers, signal: ctl.signal });
  } finally {
    clearTimeout(timer);
  }
}

// ---- Catalog ------------------------------------------------------------------------------

// The pure parts (the catalog's reduction, face ids, METADATA.pb, pickFile) are src/shared/fonts/google.ts, shared with
// the server and the web app.
export { familyDir, googleFaceId, googleStyleName, parseCatalog, parseGoogleFaceId, parseMetadataPb, pickFile, type MetadataFont } from "../shared/fonts/google";

interface CatalogCache {
  version: number;
  fetchedAt: number;
  families: GoogleFontFamily[];
}

const catalogPath = () => join(root, "cache", "google-fonts-v1.json");
let catalogLoad: Promise<GoogleFontFamily[]> | null = null;
let refreshing: Promise<boolean> | null = null;
let onCatalogChanged: (() => void) | null = null;

/** Told when a background refresh brought a different catalog (main sends `fonts:changed`). */
export function onGoogleCatalogChanged(listener: () => void): void {
  onCatalogChanged = listener;
}

async function readCatalogCache(): Promise<CatalogCache | null> {
  try {
    const c = JSON.parse(await readFile(catalogPath(), "utf8")) as CatalogCache;
    return c.version === CATALOG_VERSION && Array.isArray(c.families) ? c : null;
  } catch {
    return null;
  }
}

async function writeAtomic(path: string, data: string | Uint8Array): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const tmp = `${path}.${process.pid}.${Date.now()}.tmp`;
  await writeFile(tmp, data);
  await rename(tmp, path);
}

/** Fetches the catalog and caches it; true when it differs from what was cached. */
async function refreshCatalog(previous: GoogleFontFamily[] | null): Promise<GoogleFontFamily[] | null> {
  const res = await get(CATALOG_URL);
  if (!res.ok) throw new Error(`google fonts: catalog ${res.status}`);
  const families = parseCatalog(await res.text());
  if (!families.length) throw new Error("google fonts: empty catalog");
  await writeAtomic(catalogPath(), JSON.stringify({ version: CATALOG_VERSION, fetchedAt: Date.now(), families } satisfies CatalogCache));
  const same = previous && JSON.stringify(previous) === JSON.stringify(families);
  return same ? null : families;
}

/**
 * The catalog: the cached one at once (refreshed in the background past a week), else fetched now; offline with no
 * cache, none (no Google family is listed until the network is back and `fonts:changed` says so).
 */
export function googleCatalog(): Promise<GoogleFontFamily[]> {
  catalogLoad ??= (async () => {
    if (!root) return [];
    const cached = await readCatalogCache();
    if (cached) {
      if (Date.now() - cached.fetchedAt > REFRESH_MS) refreshInBackground(cached.families);
      return cached.families;
    }
    try {
      return (await refreshCatalog(null)) ?? [];
    } catch {
      catalogLoad = null; // offline: try again on the next list
      setTimeout(() => refreshInBackground(null), 60_000).unref?.();
      return [];
    }
  })();
  return catalogLoad;
}

function refreshInBackground(previous: GoogleFontFamily[] | null): void {
  if (refreshing) return;
  refreshing = refreshCatalog(previous)
    .then((changed) => {
      if (!changed) return false;
      catalogLoad = Promise.resolve(changed);
      onCatalogChanged?.();
      return true;
    })
    .catch(() => false)
    .finally(() => {
      refreshing = null;
    });
}

// ---- Files --------------------------------------------------------------------------------

const filesDir = (dir: string) => join(root, "fonts", "google", dir);
const metadataCache = new Map<string, Promise<FamilyFiles | null>>();
const downloads = new Map<string, Promise<string>>();
const previews = new Map<string, Promise<Uint8Array>>();

/** Where a family lives in the repository and its files (METADATA.pb, cached next to the files). */
function familyFiles(family: string): Promise<FamilyFiles | null> {
  const dir = familyDir(family);
  let p = metadataCache.get(dir);
  if (!p) {
    p = (async () => {
      const cached = join(filesDir(dir), "files.json");
      try {
        return JSON.parse(await readFile(cached, "utf8")) as FamilyFiles;
      } catch {
        // not yet
      }
      for (const license of LICENSE_DIRS) {
        const res = await get(metadataUrl(license, dir)).catch(() => null);
        if (!res?.ok) continue;
        const fonts = parseMetadataPb(await res.text());
        if (!fonts.length) continue;
        const files: FamilyFiles = { license, dir, fonts };
        await writeAtomic(cached, JSON.stringify(files)).catch(() => {});
        return files;
      }
      return null;
    })();
    p.catch(() => metadataCache.delete(dir));
    metadataCache.set(dir, p);
    void p.then((v) => v ?? metadataCache.delete(dir));
  }
  return p;
}

/** The download list's file for a style (when the repository has no folder for the family). */
async function fromDownloadList(family: string, weight: number, italic: boolean, variable: boolean): Promise<{ name: string; bytes: Uint8Array } | null> {
  const res = await get(DOWNLOAD_LIST + encodeURIComponent(family));
  if (!res.ok) return null;
  const text = await res.text();
  const data = JSON.parse(text.slice(text.indexOf("{"))) as { manifest?: { fileRefs?: { filename: string; url: string }[] } };
  const refs = data.manifest?.fileRefs ?? [];
  const isItalic = (n: string) => /italic/i.test(n.replace(/^static\//, ""));
  let ref = variable ? refs.find((r) => r.filename.includes("VariableFont") && isItalic(r.filename) === italic) : undefined;
  if (!ref) {
    const want = googleStyleName(weight, italic).replace(/\s/g, "").toLowerCase();
    ref = refs.find((r) => /\.(ttf|otf)$/i.test(r.filename) && r.filename.replace(/^.*-/, "").replace(/\.\w+$/, "").toLowerCase() === want);
  }
  if (!ref) return null;
  const file = await get(ref.url);
  if (!file.ok) return null;
  const bytes = new Uint8Array(await file.arrayBuffer());
  return isSfnt(bytes) ? { name: ref.filename.replace(/^.*\//, ""), bytes } : null;
}

/** The cached file's path for a Google face id, downloaded first if needed (concurrent asks share one download). */
export function googleFontPath(id: string): Promise<string> {
  const face = parseGoogleFaceId(id);
  if (!face) return Promise.reject(new Error(`google fonts: bad id ${id}`));
  let p = downloads.get(id);
  if (!p) {
    p = download(face.family, face.weight, face.italic, face.variable);
    downloads.set(id, p);
    p.catch(() => downloads.delete(id));
  }
  return p;
}

async function download(family: string, weight: number, italic: boolean, variable: boolean): Promise<string> {
  if (!root) throw new Error("google fonts: no folder");
  const dir = familyDir(family);
  const files = await familyFiles(family).catch(() => null);
  const file = files ? pickFile(files.fonts, weight, italic) : null;
  if (files && file) {
    const path = join(filesDir(dir), file.filename);
    if (await exists(path)) return path;
    const res = await get(repoFileUrl(files, file.filename)).catch(() => null);
    if (res?.ok) {
      const bytes = new Uint8Array(await res.arrayBuffer());
      if (isSfnt(bytes)) {
        await writeAtomic(path, bytes);
        return path;
      }
    }
  }
  // Not in the repository (or it failed): Google's download list.
  const alt = await fromDownloadList(family, weight, italic, variable);
  if (!alt) throw new Error(`google fonts: no file for ${family} ${googleStyleName(weight, italic)}`);
  const path = join(filesDir(dir), "list", alt.name);
  if (!(await exists(path))) await writeAtomic(path, alt.bytes);
  return path;
}

/** Whether a Google face's file is already on disk (offline: only those work). */
export async function googleFontCached(id: string): Promise<boolean> {
  const face = parseGoogleFaceId(id);
  if (!face) return false;
  try {
    const files = JSON.parse(await readFile(join(filesDir(familyDir(face.family)), "files.json"), "utf8")) as FamilyFiles;
    const file = pickFile(files.fonts, face.weight, face.italic);
    return !!file && (await exists(join(filesDir(files.dir), file.filename)));
  } catch {
    return false;
  }
}

async function exists(path: string): Promise<boolean> {
  try {
    return (await stat(path)).size > 0;
  } catch {
    return false;
  }
}

// ---- Previews -----------------------------------------------------------------------------

/**
 * A tiny font that draws `text` (the family's name) in the family's Regular, for the picker's row in its own face:
 * Google's css2 API with `text=` subsets the font to those characters (a few KB). Cached on disk by family and text.
 */
export function googlePreview(family: string, text: string): Promise<Uint8Array> {
  const key = createHash("sha1").update(`${family}\n${text}`).digest("hex").slice(0, 20);
  let p = previews.get(key);
  if (!p) {
    p = (async () => {
      const path = join(root, "cache", "font-previews", `${key}.ttf`);
      try {
        const b = new Uint8Array(await readFile(path));
        if (isSfnt(b)) return b;
      } catch {
        // not yet
      }
      const css = await get(`${PREVIEW_CSS}?family=${encodeURIComponent(family)}&text=${encodeURIComponent(text)}`);
      if (!css.ok) throw new Error(`google fonts: preview ${css.status}`);
      // Without a browser's user agent the API answers TrueType.
      const url = /url\((https:[^)]+)\)/.exec(await css.text())?.[1];
      if (!url) throw new Error("google fonts: no preview");
      const res = await get(url);
      if (!res.ok) throw new Error(`google fonts: preview ${res.status}`);
      const bytes = new Uint8Array(await res.arrayBuffer());
      if (!isSfnt(bytes)) throw new Error("google fonts: preview not a font");
      if (root) await writeAtomic(path, bytes).catch(() => {});
      return bytes;
    })();
    p.catch(() => previews.delete(key));
    previews.set(key, p);
  }
  return p;
}
