/**
 * The brand and product forms (docs/studio.md §3.2, §4.1): one component each, used by the Brands panel and by the
 * chat's form cards. 15b fills them.
 */
import type { BrandSave, ProductSave } from "../../../../shared/studio/types";

export interface BrandFormProps {
  brandId?: string;
  prefill?: Partial<BrandSave>;
  onDone(brandId: string): void;
  onCancel(): void;
}

export function BrandForm(_p: BrandFormProps) {
  return null;
}

export interface ProductFormProps {
  brandId: string;
  productId?: string;
  prefill?: Partial<ProductSave>;
  onDone(productId: string): void;
  onCancel(): void;
}

export function ProductForm(_p: ProductFormProps) {
  return null;
}
