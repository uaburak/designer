/**
 * Google Fonts' pure parts (docs/desktop.md §14.1), shared by main (src/main/googleFonts.ts: the desktop's catalog and
 * file cache), the server (`GET /google-fonts/catalog`, the web app's catalog) and the web app's font source
 * (src/renderer/src/engine/webFonts.ts). No Node, no DOM: the catalog's reduction, face ids, a family's folder in the
 * google/fonts repository, its METADATA.pb and the file that holds a style.
 */
import type { GoogleFontFamily, GoogleFontStyle } from "../ipc";

export const CATALOG_URL = "https://fonts.google.com/metadata/fonts";
export const REPO_RAW = "https://raw.githubusercontent.com/google/fonts/main";
export const DOWNLOAD_LIST = "https://fonts.google.com/download/list?family=";
export const PREVIEW_CSS = "https://fonts.googleapis.com/css2";
/** The repository's licence folders, in the order a family is looked for */
export const LICENSE_DIRS = ["ofl", "apache", "ufl"];

/** Google's style names for a weight (the named instances its variable fonts carry, the subfamilies of its statics). */
const WEIGHT_NAMES: Record<number, string> = { 100: "Thin", 200: "ExtraLight", 300: "Light", 400: "Regular", 500: "Medium", 600: "SemiBold", 700: "Bold", 800: "ExtraBold", 900: "Black" };

export function googleStyleName(weight: number, italic: boolean): string {
  const w = WEIGHT_NAMES[weight] ?? String(weight);
  if (!italic) return w;
  return weight === 400 ? "Italic" : `${w} Italic`;
}

/** A face's id: a variable family's styles share their slant's file (`v` / `vi`), a static style is its own. */
export function googleFaceId(family: string, weight: number, italic: boolean, variable: boolean): string {
  const kind = variable ? (italic ? "vi" : "v") : `${weight}${italic ? "i" : ""}`;
  return `g:${kind}:${family}`;
}

export function parseGoogleFaceId(id: string): { family: string; variable: boolean; italic: boolean; weight: number } | null {
  const m = /^g:(v|vi|\d+i?):(.+)$/.exec(id);
  if (!m) return null;
  const kind = m[1];
  if (kind === "v" || kind === "vi") return { family: m[2], variable: true, italic: kind === "vi", weight: 400 };
  return { family: m[2], variable: false, italic: kind.endsWith("i"), weight: parseInt(kind, 10) };
}

interface RawFamily {
  family?: unknown;
  category?: unknown;
  popularity?: unknown;
  axes?: { tag?: unknown; min?: unknown; max?: unknown; defaultValue?: unknown }[];
  fonts?: Record<string, unknown>;
}

/** `fonts.google.com/metadata/fonts` (with or without its `)]}'` guard) → the families, sorted by name. */
export function parseCatalog(text: string): GoogleFontFamily[] {
  const start = text.indexOf("{");
  if (start < 0) throw new Error("google fonts: not a catalog");
  const data = JSON.parse(text.slice(start)) as { familyMetadataList?: RawFamily[] };
  const out: GoogleFontFamily[] = [];
  for (const f of data.familyMetadataList ?? []) {
    if (typeof f.family !== "string" || !f.family) continue;
    const axes = (f.axes ?? [])
      .filter((a) => typeof a.tag === "string")
      .map((a) => ({ tag: String(a.tag), min: Number(a.min), max: Number(a.max), default: Number(a.defaultValue) }));
    const variable = axes.length > 0;
    const styles: GoogleFontStyle[] = [];
    for (const key of Object.keys(f.fonts ?? {})) {
      const m = /^(\d+)(i?)$/.exec(key);
      if (!m) continue;
      const weight = parseInt(m[1], 10);
      // Variable fonts name their instances at the hundreds only (a wght axis from 1 to 1000 still has Thin … Black).
      if (!WEIGHT_NAMES[weight]) continue;
      const italic = m[2] === "i";
      styles.push({ style: googleStyleName(weight, italic), weight, italic, id: googleFaceId(f.family, weight, italic, variable) });
    }
    if (!styles.length) continue;
    styles.sort((a, b) => a.weight - b.weight || Number(a.italic) - Number(b.italic));
    out.push({
      family: f.family,
      category: typeof f.category === "string" ? f.category : "",
      popularity: typeof f.popularity === "number" ? f.popularity : 1e6,
      axes,
      styles,
    });
  }
  out.sort((a, b) => a.family.localeCompare(b.family));
  return out;
}

/** A family's folder in the repository (and in the cache): its name, lower case, letters and digits only. */
export function familyDir(family: string): string {
  return family.toLowerCase().replace(/[^a-z0-9]/g, "");
}

export interface MetadataFont {
  style: "normal" | "italic";
  weight: number;
  filename: string;
}

/** The `fonts { … }` entries of a METADATA.pb (protobuf text format). */
export function parseMetadataPb(text: string): MetadataFont[] {
  const out: MetadataFont[] = [];
  const block = /(?:^|\n)fonts\s*\{([\s\S]*?)\n\}/g;
  for (let m = block.exec(text); m; m = block.exec(text)) {
    const body = m[1];
    const field = (name: string) => new RegExp(`\\n\\s*${name}:\\s*(?:"((?:[^"\\\\]|\\\\.)*)"|(\\S+))`).exec(`\n${body}`);
    const style = field("style")?.[1];
    const weight = Number(field("weight")?.[2]);
    const filename = field("filename")?.[1];
    if (!filename || (style !== "normal" && style !== "italic") || !Number.isFinite(weight)) continue;
    out.push({ style, weight, filename });
  }
  return out;
}

/** The file of `fonts` that holds a style: the slant's variable font, else the static file of that weight and slant. */
export function pickFile(fonts: readonly MetadataFont[], weight: number, italic: boolean): MetadataFont | null {
  const style = italic ? "italic" : "normal";
  const same = fonts.filter((f) => f.style === style);
  const pool = same.length ? same : fonts;
  const variable = pool.find((f) => f.filename.includes("["));
  if (variable) return variable;
  let best: MetadataFont | null = null;
  for (const f of pool) if (!best || Math.abs(f.weight - weight) < Math.abs(best.weight - weight)) best = f;
  return best;
}

/** Where a family lives in the repository and its files (METADATA.pb's). */
export interface FamilyFiles {
  license: string;
  dir: string;
  fonts: MetadataFont[];
}

/** A face's file in the repository. */
export const repoFileUrl = (files: Pick<FamilyFiles, "license" | "dir">, filename: string): string => `${REPO_RAW}/${files.license}/${files.dir}/${encodeURIComponent(filename)}`;
/** A family's METADATA.pb under one licence folder. */
export const metadataUrl = (license: string, dir: string): string => `${REPO_RAW}/${license}/${dir}/METADATA.pb`;

/** An sfnt (TrueType, OpenType, a collection) by its first four bytes. */
export function isSfnt(b: Uint8Array): boolean {
  if (b.length < 12) return false;
  const tag = ((b[0] << 24) | (b[1] << 16) | (b[2] << 8) | b[3]) >>> 0;
  return tag === 0x00010000 || tag === 0x4f54544f || tag === 0x74727565 || tag === 0x74746366;
}
