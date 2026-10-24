/**
 * The Brands view's pure rules (docs/studio.md §3.2): a brand's counts and gaps for its card, a product's readiness
 * (missingFor's steps), and the brand page's filters — series, readiness, a search — and sort. No React, no store.
 */
import { t } from "@/i18n";
import { foldName, missingFor, nameScore } from "../../../../../shared/studio/library";
import type { Brand, Missing, Product } from "../../../../../shared/studio/types";

export const hasPhoto = (p: Product): boolean => p.images.some((i) => i.role === "packshot");
export const seriesKey = (p: Product): string | null => (p.series?.trim() ? foldName(p.series) : null);

/** A brand's numbers for its card: products, series, logos, products with a photo, confirmed label texts. */
export interface BrandStats {
  products: number;
  series: number;
  logos: number;
  withPhoto: number;
  labelsConfirmed: number;
}

export function brandStats(b: Brand): BrandStats {
  return {
    products: b.products.length,
    series: new Set(b.products.map(seriesKey).filter((s): s is string => !!s)).size,
    logos: b.logos.filter((i) => i.role === "logo").length,
    withPhoto: b.products.filter(hasPhoto).length,
    labelsConfirmed: b.products.filter((p) => p.labelsConfirmed).length,
  };
}

/** The brand's own obvious gaps (English keys: the view translates them), in the order its form asks. */
export function brandGaps(b: Brand): string[] {
  const out: string[] = [];
  if (!b.logos.some((i) => i.role === "logo")) out.push("No logo yet");
  if (!b.colors.length) out.push("No colours yet");
  if (!b.fonts.length) out.push("No font yet");
  if (!b.products.length) out.push("No products yet");
  return out;
}

/** One readiness step (§4.1): missingFor's fields, in its order. */
export interface ReadinessStep {
  field: Missing["field"];
  /** English key, translated by the view */
  label: string;
  done: boolean;
}

const STEPS: { field: Missing["field"]; label: string }[] = [
  { field: "brand", label: "Brand in the library" },
  { field: "logo", label: "Brand logo" },
  { field: "colors", label: "Brand colours" },
  { field: "product", label: "Product in the library" },
  { field: "packshot", label: "Product photo" },
  { field: "shape", label: "Shape described" },
  { field: "labels", label: "Label texts" },
  { field: "labels-confirmed", label: "Label texts confirmed" },
];

/** The eight steps a post needs from this product, each ticked or not. */
export function productReadiness(brand: Brand, product: Product): { steps: ReadinessStep[]; missing: Missing[] } {
  const missing = missingFor(brand, [product]);
  const lacks = new Set(missing.map((m) => m.field));
  return {
    missing,
    // "labels-confirmed" isn't reported while there are no texts; it isn't done either
    steps: STEPS.map((s) => ({ ...s, done: !lacks.has(s.field) && (s.field !== "labels-confirmed" || product.labelsConfirmed) })),
  };
}

/** A product card's badge: its first gap (English key), and how many more there are. */
export function productGap(p: Product): { label: string; more: number } | null {
  const gaps = [!hasPhoto(p) && "No photo", !p.shape.trim() && "No shape", !p.labels.length && "No label texts", p.labels.length > 0 && !p.labelsConfirmed && "Labels not confirmed"].filter((x): x is string => !!x);
  return gaps.length ? { label: gaps[0], more: gaps.length - 1 } : null;
}

// ── The brand page's filters ──────────────────────────────────────────────────────────────────────────────────────

/** "all", "none" (no series) or a series' folded key */
export type SeriesFilter = "all" | "none" | { key: string };

export interface ProductFilter {
  series: SeriesFilter;
  labelsUnconfirmed: boolean;
  noPhoto: boolean;
  query: string;
  sort: "name" | "series";
}

export const NO_FILTER: ProductFilter = { series: "all", labelsUnconfirmed: false, noPhoto: false, query: "", sort: "name" };

/** The series of a brand with their product counts, A to Z (each once, in the spelling first met), and those with none. */
export function seriesCounts(products: readonly Product[]): { series: { key: string; name: string; count: number }[]; none: number } {
  const by = new Map<string, { key: string; name: string; count: number }>();
  let none = 0;
  for (const p of products) {
    const key = seriesKey(p);
    if (!key) {
      none++;
      continue;
    }
    const s = by.get(key) ?? { key, name: p.series!.trim(), count: 0 };
    s.count++;
    by.set(key, s);
  }
  return { series: [...by.values()].sort((a, b) => a.key.localeCompare(b.key)), none };
}

const byName = (a: Product, b: Product) => foldName(a.name).localeCompare(foldName(b.name));

/** The products the filter shows, in its order (a search: best match first). */
export function filterProducts(products: readonly Product[], f: ProductFilter): Product[] {
  let list = products.filter((p) => {
    if (f.series === "none" && seriesKey(p)) return false;
    if (typeof f.series === "object" && seriesKey(p) !== f.series.key) return false;
    if (f.labelsUnconfirmed && p.labelsConfirmed) return false;
    if (f.noPhoto && hasPhoto(p)) return false;
    return true;
  });
  if (foldName(f.query)) {
    const scored = list.map((p) => ({ p, s: Math.max(nameScore(p.name, f.query), p.series ? nameScore(p.series, f.query) : 0) })).filter((x) => x.s > 0);
    return scored.sort((x, y) => y.s - x.s || byName(x.p, y.p)).map((x) => x.p);
  }
  list = [...list].sort(byName);
  if (f.sort === "series") list.sort((a, b) => (seriesKey(a) ?? "￿").localeCompare(seriesKey(b) ?? "￿") || byName(a, b));
  return list;
}

/** The brands a list search shows, best first: a brand's name or any of its products' (or series'). */
export function filterBrands(brands: readonly Brand[], query: string): Brand[] {
  if (!foldName(query)) return [...brands];
  return brands
    .map((b) => ({ b, s: Math.max(nameScore(b.name, query), ...b.products.map((p) => Math.max(nameScore(p.name, query), p.series ? nameScore(p.series, query) : 0))) }))
    .filter((x) => x.s > 0)
    .sort((x, y) => y.s - x.s)
    .map((x) => x.b);
}

/** The request Design posts puts in the agent's composer: the brand, and the products picked. */
export function designRequest(brand: Brand, products: readonly Product[]): string {
  if (!products.length) return t("Design posts for {brand}: ", { brand: brand.name });
  return t("Design posts for {brand} with {products}: ", { brand: brand.name, products: products.map((p) => p.name).join(", ") });
}

/** The first line (or sentence) of a brand's tone, for its page's header. */
export function toneSummary(tone: string): string {
  const line = tone.trim().split(/\n/)[0] ?? "";
  const sentence = /^(.+?[.!?])(\s|$)/.exec(line)?.[1] ?? line;
  return sentence.trim();
}
