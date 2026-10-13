/**
 * The library's pure rules (docs/studio.md §3, §4.2): what a request still needs, and name matching. 15b fills it.
 */
import type { Brand, Missing, Product } from "./types";

/** What `brand` and `products` still lack before a post can be made (§4.2), in the order the forms ask. */
export function missingFor(_brand: Brand, _products: readonly Product[]): Missing[] {
  return [];
}
