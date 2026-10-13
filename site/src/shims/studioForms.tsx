// Stand-in for src/renderer/src/editor/studio/forms.tsx (vite.config.ts SHIMS). The real brand and product forms
// read and write the store's brand library; the site's Studio scene never opens them.
export function BrandForm(_props: { brandId?: string; prefill?: unknown; onDone: (brandId: string) => void; onCancel: () => void }) {
  return null;
}

export function ProductForm(_props: { brandId: string; productId?: string; prefill?: unknown; onDone: (productId: string) => void; onCancel: () => void }) {
  return null;
}
