/**
 * The library's pure rules (docs/studio.md §3, §4.1): what a request still needs, and name matching.
 */
import type { Brand, Missing, Product } from "./types";

/**
 * Name matching (§3.1): case and accents folded, Turkish too — "İSTANBUL" and "ıstanbul" both fold to "istanbul",
 * "Şeker" to "seker", "ÇİĞDEM" to "cigdem".
 */
export function foldName(s: string): string {
  return s
    .replace(/İ/g, "i")
    .replace(/ı/g, "i")
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/ß/g, "ss")
    .replace(/\s+/g, " ")
    .trim();
}

/** How well `query` matches `name` (0: not at all): the whole name, its start, a word's start, any part, every word of the query. */
export function nameScore(name: string, query: string): number {
  const n = foldName(name);
  const q = foldName(query);
  if (!q) return 0;
  if (n === q) return 4;
  if (n.startsWith(q)) return 3;
  if (n.split(" ").some((w) => w.startsWith(q))) return 2.5;
  if (n.includes(q)) return 2;
  const words = q.split(" ");
  return words.length > 1 && words.every((w) => n.includes(w)) ? 1 : 0;
}

/** What `brand` and `products` still lack before a post can be made (§4.1), in the order the forms ask. */
export function missingFor(brand: Brand | null | undefined, products: readonly Product[]): Missing[] {
  if (!brand) return [{ brandId: null, productId: null, field: "brand", message: "The brand isn't in the library" }];
  const out: Missing[] = [];
  const brandItem = (field: Missing["field"], message: string) => out.push({ brandId: brand.id, productId: null, field, message });
  if (!brand.logos.length) brandItem("logo", `${brand.name} has no logo`);
  if (!brand.colors.length) brandItem("colors", `${brand.name} has no colours`);
  const mine = products.filter((p) => p.brandId === brand.id);
  if (!mine.length) out.push({ brandId: brand.id, productId: null, field: "product", message: "No product is named" });
  const each = (field: Missing["field"], lacks: (p: Product) => boolean, message: (p: Product) => string) => {
    for (const p of mine) if (lacks(p)) out.push({ brandId: brand.id, productId: p.id, field, message: message(p) });
  };
  each("packshot", (p) => !p.images.some((i) => i.role === "packshot"), (p) => `${p.name} has no product photo`);
  each("shape", (p) => !p.shape.trim(), (p) => `${p.name} has no shape described`);
  each("labels", (p) => !p.labels.length, (p) => `${p.name} has no label texts`);
  each("labels-confirmed", (p) => p.labels.length > 0 && !p.labelsConfirmed, (p) => `${p.name}'s label texts aren't confirmed`);
  return out;
}
