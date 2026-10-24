/**
 * Convert to Social file (docs/social.md §18.1, the owner's wireframe H): which of a Design file's frames become posts,
 * and the instruction that makes them so. Pure: the editor reads the pages' top-level layers (and a container's
 * children) from the engine, `findConvertible` says what was found — each page's rows, the page's brand when its name
 * is a brand's — the dialog's choices make a `SocialConversion`, and the editor applies it as one undo step
 * (editor/social/convert/convert.ts).
 *
 * The rules:
 * - a top-level frame (or component, instance) of a format's size is a post;
 * - a container — a top-level frame or section that isn't itself a format's size, whose children are mostly frames of
 *   one format's size — is unwrapped: its children become top-level posts in reading order (rows top-down, each row
 *   left to right), where they are on the page, and the empty container goes;
 * - a size fits a format exactly, else when the catalogue's nearest format has the same aspect ratio (±2 %) and an area
 *   within ±25 % of its sides; a size that fits none is listed as "Skip (no format)", unchecked;
 * - the page holding the file's thumbnail (DOCUMENT.thumbnailInfo), a page named "Thumbnail" or "Cover", and a page
 *   without a frame of a format's size are left out;
 * - a page whose name is a brand's name (case and accents folded, `foldName`) gives its posts that brand.
 */
import { foldName } from "../studio/library";
import { formatById, nearestFormat, SOCIAL_FORMATS } from "./formats";
import type { PlatformFormat } from "./types";

/** A layer as the conversion reads it: its place in its parent, its size. */
export interface ConvertNode {
  id: string;
  name: string;
  /** The engine's type ("FRAME", "SECTION", "INSTANCE", "SYMBOL", "TEXT" …) */
  type: string;
  x: number;
  y: number;
  width: number;
  height: number;
}

/** A page's top-level layer; a frame's or section's direct children come with it (a container's candidates). */
export interface ConvertTopNode extends ConvertNode {
  children?: ConvertNode[];
}

export interface ConvertPageInput {
  id: string;
  name: string;
  /** Its top-level layers, in layer order */
  nodes: ConvertTopNode[];
}

export interface ConvertInput {
  pages: ConvertPageInput[];
  /** The page holding the file's thumbnail frame (DOCUMENT.thumbnailInfo), if any */
  thumbnailPageId?: string | null;
  /** The Brands library's brands */
  brands?: readonly { id: string; name: string }[];
}

/** One line of the dialog's list: a top-level post, a container of posts, or a frame that fits no format. */
export interface ConvertRow {
  id: string;
  name: string;
  kind: "post" | "container";
  /** A post's size; a container's: its designs' (the size most of its children have) */
  width: number;
  height: number;
  /** How many posts it makes */
  count: number;
  /** The format suggested (null: none fits — "Skip (no format)") */
  suggested: string | null;
  /** A container's children in reading order: each one's own format (null: not a post, it is only unwrapped) and whether it is of the container's size */
  children?: { id: string; formatId: string | null; major: boolean }[];
}

export interface ConvertPage {
  pageId: string;
  pageName: string;
  brand: { id: string; name: string } | null;
  rows: ConvertRow[];
}

export interface ConvertFound {
  pages: ConvertPage[];
  /** Pages the conversion leaves out (a copy doesn't hold them) */
  leftOut: { pageId: string; pageName: string; reason: "thumbnail" | "no-designs" }[];
}

/** What the dialog chose for a row: converted or skipped, and with which format. */
export interface RowChoice {
  checked: boolean;
  formatId: string | null;
}

/**
 * The instruction a conversion is (handed to a Social copy in its FileUiState `socialConvert`, applied once on open; or
 * applied at once by "Convert this file"): per page, the containers to unwrap (their children in reading order) and the
 * posts to record; and the pages a copy drops.
 */
export interface SocialConversion {
  v: 1;
  pages: {
    pageId: string;
    brandId: string | null;
    /** Containers to unwrap: their children moved to the page in this order (reading order), then the container removed */
    unwrap: { id: string; children: string[] }[];
    /** The posts' records to write, in reading order */
    posts: { id: string; formatId: string }[];
  }[];
  /** Pages removed (a copy holds only the converted pages); empty when the file itself is converted */
  removePages: string[];
}

/** Types a post can be (Social's board: socialState.ts POST_TYPES). */
const POST_TYPES = new Set(["FRAME", "INSTANCE", "SYMBOL"]);
const CONTAINER_TYPES = new Set(["FRAME", "SECTION"]);
const ASPECT_TOLERANCE = 0.02;
const SIDE_TOLERANCE = 0.25;
/** Pages whose name says they are the file's cover (Figma's convention), folded */
const COVER_NAMES = new Set(["thumbnail", "cover"]);

const aspectDiff = (f: { width: number; height: number }, width: number, height: number) => Math.abs(Math.log(f.width / f.height) - Math.log(width / height));
const sideFits = (f: { width: number; height: number }, width: number, height: number) => {
  const scale = Math.sqrt((width * height) / (f.width * f.height));
  return scale >= 1 - SIDE_TOLERANCE && scale <= 1 + SIDE_TOLERANCE;
};

/**
 * The format a frame of this size is: the exact size first (the catalogue's order decides between formats of the same
 * size — 1080 × 1080 is Instagram square, 1080 × 1350 Instagram post, 1080 × 1440 Instagram post 3:4), else the nearest
 * format when it has the same aspect ratio and about the same size; null when none fits.
 */
export function suggestFormat(width: number, height: number): PlatformFormat | null {
  const w = Math.round(width);
  const h = Math.round(height);
  if (!(w > 0) || !(h > 0)) return null;
  const near = nearestFormat(w, h);
  if (!near) return null;
  if (near.width === w && near.height === h) return near;
  return aspectDiff(near, w, h) <= ASPECT_TOLERANCE && sideFits(near, w, h) ? near : null;
}

/** The formats a frame of this size may be (the Select's list): the same size first, then the same shape, in the catalogue's order. */
export function formatsFitting(width: number, height: number): PlatformFormat[] {
  const w = Math.round(width);
  const h = Math.round(height);
  if (!(w > 0) || !(h > 0)) return [];
  const fits = SOCIAL_FORMATS.filter((f) => (f.width === w && f.height === h) || (aspectDiff(f, w, h) <= ASPECT_TOLERANCE && sideFits(f, w, h)));
  return [...fits.filter((f) => f.width === w && f.height === h), ...fits.filter((f) => f.width !== w || f.height !== h)];
}

/** Reading order: rows top-down (a layer starting above the row's first one's middle is in its row), each left to right. */
export function readingOrder<T extends { x: number; y: number; height: number }>(nodes: readonly T[]): T[] {
  const rows: T[][] = [];
  for (const n of [...nodes].sort((a, b) => a.y - b.y || a.x - b.x)) {
    const row = rows[rows.length - 1];
    if (row && n.y < row[0].y + row[0].height / 2) row.push(n);
    else rows.push([n]);
  }
  return rows.flatMap((r) => r.sort((a, b) => a.x - b.x));
}

/** The brand whose name is the page's (folded), or null. */
export function brandForPage(pageName: string, brands: readonly { id: string; name: string }[] = []): { id: string; name: string } | null {
  const name = foldName(pageName);
  if (!name) return null;
  const b = brands.find((x) => foldName(x.name) === name);
  return b ? { id: b.id, name: b.name } : null;
}

/** A container row for `node`, or null when it isn't one (no children mostly of one format's size). */
function containerRow(node: ConvertTopNode): ConvertRow | null {
  const kids = node.children ?? [];
  if (!CONTAINER_TYPES.has(node.type) || kids.length < 2) return null;
  const sized = kids.map((c) => ({ c, format: POST_TYPES.has(c.type) ? suggestFormat(c.width, c.height) : null }));
  const bySize = new Map<string, { width: number; height: number; formatId: string; n: number }>();
  for (const { c, format } of sized) {
    if (!format) continue;
    const key = `${Math.round(c.width)}x${Math.round(c.height)}`;
    const g = bySize.get(key) ?? { width: Math.round(c.width), height: Math.round(c.height), formatId: format.id, n: 0 };
    g.n++;
    bySize.set(key, g);
  }
  const major = [...bySize.values()].sort((a, b) => b.n - a.n)[0];
  if (!major || major.n < 2 || major.n * 2 <= kids.length) return null;
  const formats = new Map(sized.map(({ c, format }) => [c.id, format?.id ?? null]));
  const children = readingOrder(kids).map((c) => ({ id: c.id, formatId: formats.get(c.id) ?? null, major: Math.round(c.width) === major.width && Math.round(c.height) === major.height && formats.get(c.id) !== null }));
  return { id: node.id, name: node.name, kind: "container", width: major.width, height: major.height, count: children.filter((c) => c.formatId !== null).length, suggested: major.formatId, children };
}

/** What a file holds that can become posts, page by page (see the module's rules). */
export function findConvertible(input: ConvertInput): ConvertFound {
  const pages: ConvertPage[] = [];
  const leftOut: ConvertFound["leftOut"] = [];
  for (const page of input.pages) {
    if (page.id === input.thumbnailPageId || COVER_NAMES.has(foldName(page.name))) {
      leftOut.push({ pageId: page.id, pageName: page.name, reason: "thumbnail" });
      continue;
    }
    const rows: ConvertRow[] = [];
    for (const node of readingOrder(page.nodes)) {
      const own = POST_TYPES.has(node.type) ? suggestFormat(node.width, node.height) : null;
      if (own) {
        rows.push({ id: node.id, name: node.name, kind: "post", width: Math.round(node.width), height: Math.round(node.height), count: 1, suggested: own.id });
        continue;
      }
      const container = containerRow(node);
      if (container) rows.push(container);
      else if (POST_TYPES.has(node.type)) rows.push({ id: node.id, name: node.name, kind: "post", width: Math.round(node.width), height: Math.round(node.height), count: 1, suggested: null });
    }
    if (!rows.some((r) => r.suggested !== null)) {
      leftOut.push({ pageId: page.id, pageName: page.name, reason: "no-designs" });
      continue;
    }
    pages.push({ pageId: page.id, pageName: page.name, brand: brandForPage(page.name, input.brands), rows });
  }
  return { pages, leftOut };
}

/** The dialog's first choices: every row with a suggested format checked with it, the others skipped. */
export function defaultChoices(found: ConvertFound): Record<string, RowChoice> {
  const out: Record<string, RowChoice> = {};
  for (const p of found.pages) for (const r of p.rows) out[r.id] = { checked: r.suggested !== null, formatId: r.suggested };
  return out;
}

const chosen = (row: ConvertRow, choices: Readonly<Record<string, RowChoice>>): string | null => {
  const c = choices[row.id] ?? { checked: row.suggested !== null, formatId: row.suggested };
  return c.checked && c.formatId && formatById(c.formatId) ? c.formatId : null;
};

/** The footer's counts: the designs that move to Social, and the frames skipped. */
export function conversionCounts(found: ConvertFound, choices: Readonly<Record<string, RowChoice>>): { designs: number; skipped: number } {
  let designs = 0;
  let skipped = 0;
  for (const p of found.pages)
    for (const r of p.rows) {
      if (chosen(r, choices)) designs += r.count;
      else skipped += r.count;
    }
  return { designs, skipped };
}

/**
 * The conversion the choices make. `removePages`: the file's other pages (a copy holds only the converted ones; pass
 * none when the file itself is converted). A page whose rows are all skipped is left out (and removed with the others).
 */
export function conversionPlan(found: ConvertFound, choices: Readonly<Record<string, RowChoice>>, opts: { allPages?: readonly string[] } = {}): SocialConversion {
  const pages: SocialConversion["pages"] = [];
  for (const p of found.pages) {
    const unwrap: SocialConversion["pages"][number]["unwrap"] = [];
    const posts: SocialConversion["pages"][number]["posts"] = [];
    for (const r of p.rows) {
      const formatId = chosen(r, choices);
      if (!formatId) continue;
      if (r.kind === "post") {
        posts.push({ id: r.id, formatId });
        continue;
      }
      const kids = r.children ?? [];
      unwrap.push({ id: r.id, children: kids.map((c) => c.id) });
      // The container's size takes the format picked; a child of another format's size keeps its own.
      for (const c of kids) if (c.formatId) posts.push({ id: c.id, formatId: c.major ? formatId : c.formatId });
    }
    if (posts.length) pages.push({ pageId: p.pageId, brandId: p.brand?.id ?? null, unwrap, posts });
  }
  const kept = new Set(pages.map((p) => p.pageId));
  return { v: 1, pages, removePages: (opts.allPages ?? []).filter((id) => !kept.has(id)) };
}

/** A conversion read back from storage (the copy's ui state): null unless it is one. */
export function readConversion(raw: unknown): SocialConversion | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Partial<SocialConversion>;
  if (r.v !== 1 || !Array.isArray(r.pages)) return null;
  const ids = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : []);
  const pages = r.pages
    .filter((p) => p && typeof p.pageId === "string")
    .map((p) => ({
      pageId: p.pageId,
      brandId: typeof p.brandId === "string" ? p.brandId : null,
      unwrap: (Array.isArray(p.unwrap) ? p.unwrap : []).filter((u) => u && typeof u.id === "string").map((u) => ({ id: u.id, children: ids(u.children) })),
      posts: (Array.isArray(p.posts) ? p.posts : []).filter((x) => x && typeof x.id === "string" && typeof x.formatId === "string").map((x) => ({ id: x.id, formatId: x.formatId })),
    }));
  return { v: 1, pages, removePages: ids(r.removePages) };
}
