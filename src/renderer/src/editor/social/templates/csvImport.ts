/**
 * Import CSV… (docs/social.md §4.5, Buzz's bulk create [ours]): a CSV file (RFC 4180, ours — no dependency) whose
 * header row names columns — `headline`, `body`, `cta`, `label`, `caption`, `hashtags`, `alt`, `product`, `brand`, in
 * any case and order; others are ignored — becomes one post per row × format, made from one template as a new
 * campaign's row, as one undo step. At most MAX_ROWS rows.
 */
import type { Guid } from "@/engine/codec";
import { t } from "@/i18n";
import { foldName } from "@shared/studio/library";
import type { SlotRole } from "@shared/social/types";
import type { Brand } from "@shared/studio/types";
import type { EditorController } from "../../controller";
import type { ImportedImage } from "../../images";
import type { Writer } from "../actions";
import { placePost } from "../board";
import { cleanHashtags, postRecord, readCampaigns, socialId, writeCampaigns } from "../posts";
import { readBoard } from "../socialState";
import { applyBrandNow, ensureTemplate, fillSlotsNow, newTemplatePostNow, productPicture } from "./templates";

export const MAX_ROWS = 500;

/** The columns the importer reads (lower case) and what each one fills. */
export const CSV_COLUMNS = ["headline", "body", "cta", "label", "caption", "hashtags", "alt", "product", "brand"] as const;
export type CsvColumn = (typeof CSV_COLUMNS)[number];

/**
 * RFC 4180 rows: fields separated by the delimiter, a field in double quotes may hold the delimiter, line breaks and
 * doubled quotes (""); CRLF, LF or CR end a record; a leading BOM is dropped; blank lines are skipped. The delimiter is
 * the header line's comma or — when it has more of them — semicolon (spreadsheets in Turkish write ";") [ours].
 */
export function parseCsv(text: string): string[][] {
  const src = text.replace(/^\uFEFF/, "");
  const firstLine = src.slice(0, src.search(/\r|\n/) >= 0 ? src.search(/\r|\n/) : src.length);
  const delim = (firstLine.match(/;/g)?.length ?? 0) > (firstLine.match(/,/g)?.length ?? 0) ? ";" : ",";
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let quoted = false;
  let i = 0;
  const endField = () => {
    row.push(field);
    field = "";
  };
  const endRow = () => {
    endField();
    if (row.length > 1 || row[0] !== "") rows.push(row);
    row = [];
  };
  while (i < src.length) {
    const c = src[i];
    if (quoted) {
      if (c === '"' && src[i + 1] === '"') {
        field += '"';
        i += 2;
        continue;
      }
      if (c === '"') quoted = false;
      else field += c;
      i++;
      continue;
    }
    if (c === '"' && field === "") quoted = true;
    else if (c === delim) endField();
    else if (c === "\r" || c === "\n") {
      endRow();
      if (c === "\r" && src[i + 1] === "\n") i++;
    } else field += c;
    i++;
  }
  if (field !== "" || row.length) endRow();
  return rows;
}

/** One row of posts to make: the text slots, the post's words, and the product and brand by name. */
export interface CsvPost {
  values: Partial<Record<SlotRole, string>>;
  caption: string;
  hashtags: string[];
  altText: string;
  product: string;
  brand: string;
}

export type CsvRead = { posts: CsvPost[]; columns: CsvColumn[] } | { error: string };

/** The rows as posts (the header row names the columns); an error when nothing is known or there are too many rows. */
export function readCsvPosts(text: string): CsvRead {
  const rows = parseCsv(text);
  if (!rows.length) return { error: t("The file is empty") };
  const header = rows[0].map((h) => h.trim().toLowerCase());
  const at = new Map<CsvColumn, number>();
  for (const col of CSV_COLUMNS) {
    const i = header.indexOf(col);
    if (i >= 0) at.set(col, i);
  }
  if (!at.size) return { error: t("No known column in the first row ({columns})", { columns: CSV_COLUMNS.join(", ") }) };
  const body = rows.slice(1);
  if (body.length > MAX_ROWS) return { error: t("At most {max} rows (this file has {n})", { max: String(MAX_ROWS), n: String(body.length) }) };
  const cell = (r: string[], col: CsvColumn) => (at.has(col) ? (r[at.get(col)!] ?? "").trim() : "");
  const posts = body.map((r) => {
    const values: Partial<Record<SlotRole, string>> = {};
    for (const role of ["headline", "body", "cta", "label"] as const) if (at.has(role)) values[role] = cell(r, role);
    return { values, caption: cell(r, "caption"), hashtags: cleanHashtags(cell(r, "hashtags").split(/[\s,]+/)), altText: cell(r, "alt"), product: cell(r, "product"), brand: cell(r, "brand") };
  });
  return { posts, columns: CSV_COLUMNS.filter((c) => at.has(c)) };
}

export interface CsvImportOptions {
  key: string;
  formatIds: string[];
  /** The new campaign's name */
  campaign: string;
  /** The board's brand, for rows naming none */
  brandId: string | null;
  brands: readonly Brand[];
}

/**
 * Makes the posts (§4.5): the template brought in, the rows' product pictures imported (once per product), then one
 * undo step "Import CSV" — a new campaign; per row and format, an instance of the template's variant for it at the
 * row's end, its slots filled, its caption, hashtags and alt text, the row's brand (by name, else the board's) bound,
 * the product's packshot in the picture slot. Returns the posts made.
 */
export async function importCsvPosts(ed: EditorController, w: Writer, posts: readonly CsvPost[], opts: CsvImportOptions): Promise<Guid[]> {
  const { entry, node } = await ensureTemplate(ed, opts.key);
  const byName = (name: string) => opts.brands.find((b) => foldName(b.name) === foldName(name)) ?? null;
  const fallback = opts.brands.find((b) => b.id === opts.brandId) ?? null;
  const pictures = new Map<string, ImportedImage | null>();
  const resolved = posts.map((p) => {
    const brand = (p.brand && byName(p.brand)) || fallback;
    const product = brand && p.product ? (brand.products.find((x) => foldName(x.name) === foldName(p.product)) ?? null) : null;
    return { p, brand, product };
  });
  for (const r of resolved) {
    if (!r.brand || !r.product || pictures.has(r.product.id)) continue;
    pictures.set(r.product.id, await productPicture(ed, r.brand.id, r.product.id).catch(() => null));
  }
  return w("Import CSV", () => {
    const page = ed.store.page;
    const campaign = { id: socialId(), name: opts.campaign, brandId: opts.brandId, created: Date.now() };
    writeCampaigns(ed, page, [...readCampaigns(ed, page), campaign]);
    const made: Guid[] = [];
    for (const { p, brand, product } of resolved) {
      for (const formatId of opts.formatIds) {
        const at = placePost(readBoard(ed, page).posts, campaign.id);
        const record = postRecord(formatId, { brandId: brand?.id ?? null, campaignId: campaign.id, productIds: product ? [product.id] : [], caption: p.caption, hashtags: p.hashtags, altText: p.altText });
        const id = newTemplatePostNow(ed, page, { key: opts.key, node, data: entry.data, formatId, at, record });
        fillSlotsNow(ed, id, p.values, product ? pictures.get(product.id) : null);
        if (brand) applyBrandNow(ed, [id], brand);
        made.push(id);
      }
    }
    return made;
  });
}
