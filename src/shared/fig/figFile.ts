/**
 * A `.fig` file (docs/data.md §11, docs/schema.md §11.1): a ZIP of stored entries
 *   canvas.fig       the fig container (snapshot bytes as they are)
 *   thumbnail.png
 *   meta.json        {client_meta: {background_color, thumbnail_size, render_coordinates}, file_name, exported_at, …}
 *   images/<sha1>    image bytes, named by the hex SHA-1 of the bytes (not always true for Figma's files)
 * or a bare canvas.fig.
 */
import type { FigCodecs } from "./compression";
import { FigFormatError, PRELUDE_DESIGN, PRELUDE_FIGJAM, PRELUDE_SLIDES } from "./container";
import { isZip, readZip, writeZip, type ZipEntry } from "./zip";

export interface FigMeta {
  client_meta?: {
    background_color?: { r: number; g: number; b: number; a: number };
    thumbnail_size?: { width: number; height: number };
    render_coordinates?: { x: number; y: number; width: number; height: number };
  };
  file_name?: string;
  developer_related_links?: unknown[];
  exported_at?: string;
  [key: string]: unknown;
}

export interface FigFile {
  canvas: Uint8Array;
  meta: FigMeta | null;
  thumbnail: Uint8Array | null;
  /** By entry name without "images/" (normally the hex SHA-1) */
  images: Map<string, Uint8Array>;
  /** The input was a bare canvas.fig */
  bare: boolean;
}

const PRELUDES = [PRELUDE_DESIGN, PRELUDE_FIGJAM, PRELUDE_SLIDES];
const looksLikeCanvas = (b: Uint8Array) => b.length >= 8 && PRELUDES.includes(String.fromCharCode(...b.subarray(0, 8)));

export function readFigFile(bytes: Uint8Array, codecs: Pick<FigCodecs, "inflateRaw">): FigFile {
  if (looksLikeCanvas(bytes)) return { canvas: bytes, meta: null, thumbnail: null, images: new Map(), bare: true };
  if (!isZip(bytes)) throw new FigFormatError("unsupported-format", "This isn't a .fig file");
  const entries = readZip(bytes, codecs.inflateRaw);
  let canvas: Uint8Array | null = null;
  let meta: FigMeta | null = null;
  let thumbnail: Uint8Array | null = null;
  const images = new Map<string, Uint8Array>();
  for (const e of entries) {
    if (e.name === "canvas.fig") canvas = e.data;
    else if (e.name === "thumbnail.png") thumbnail = e.data;
    else if (e.name === "meta.json") {
      try {
        meta = JSON.parse(new TextDecoder().decode(e.data)) as FigMeta;
      } catch {
        meta = null;
      }
    } else if (e.name.startsWith("images/") && e.name.length > "images/".length) images.set(e.name.slice("images/".length), e.data);
  }
  if (!canvas) throw new FigFormatError("corrupt", "The .fig file has no canvas.fig");
  return { canvas, meta, thumbnail, images, bare: false };
}

export function writeFigFile(file: { canvas: Uint8Array; meta: FigMeta | null; thumbnail: Uint8Array | null; images: Iterable<[string, Uint8Array]> }, opts: { date?: Date } = {}): Uint8Array {
  const entries: ZipEntry[] = [{ name: "canvas.fig", data: file.canvas }];
  if (file.thumbnail) entries.push({ name: "thumbnail.png", data: file.thumbnail });
  if (file.meta) entries.push({ name: "meta.json", data: new TextEncoder().encode(JSON.stringify(file.meta)) });
  entries.push({ name: "images/", data: new Uint8Array(0) });
  for (const [name, data] of file.images) entries.push({ name: `images/${name}`, data });
  return writeZip(entries, opts);
}
