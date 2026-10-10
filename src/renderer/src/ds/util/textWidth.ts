import { fontFamily, text, type TextStyle, type TextStyleName } from "../tokens";

/** Per type style: text → its width (px), as the chrome draws it. */
const caches = new Map<TextStyleName, Map<string, number>>();
let ctx: CanvasRenderingContext2D | null | undefined;

function context(): CanvasRenderingContext2D | null {
  if (ctx === undefined) {
    try {
      ctx = typeof document === "undefined" ? null : document.createElement("canvas").getContext("2d");
    } catch {
      ctx = null;
    }
  }
  return ctx;
}

/**
 * How wide `s` is set in a type style (`--ds-font-<style>`, `--ds-tracking-<style>`): one canvas `measureText`,
 * cached per style and text — the Layers list sizes its scroll width from every open row's name this way, not from
 * the DOM (it draws only the rows in view). Without a 2D canvas (tests) an estimate (0.6 em a character).
 */
export function textWidth(s: string, style: TextStyleName = "body-medium-regular"): number {
  let cache = caches.get(style);
  if (!cache) caches.set(style, (cache = new Map()));
  const hit = cache.get(s);
  if (hit !== undefined) return hit;
  const t: TextStyle = text[style];
  const tracking = parseFloat(t.tracking) || 0;
  const g = context();
  let w: number;
  if (g) {
    g.font = `${t.weight} ${t.size}px ${t.mono ? fontFamily.mono : fontFamily.sans}`;
    const spaced = g as CanvasRenderingContext2D & { letterSpacing?: string };
    if (spaced.letterSpacing !== undefined) {
      spaced.letterSpacing = `${tracking}px`;
      w = g.measureText(s).width;
    } else w = g.measureText(s).width + tracking * [...s].length;
  } else w = [...s].length * (t.size * 0.6 + tracking);
  cache.set(s, w);
  return w;
}

/** Forget every width (the UI font finished loading: what was measured with a fallback is stale). */
export function clearTextWidths(): void {
  caches.clear();
}

/** Calls `onChange` whenever the document finishes loading fonts, the widths measured before dropped; returns the unsubscribe. */
export function onFontsLoaded(onChange: () => void): () => void {
  const fonts = typeof document === "undefined" ? undefined : (document as Document & { fonts?: FontFaceSet }).fonts;
  if (!fonts?.addEventListener) return () => {};
  const done = () => {
    clearTextWidths();
    onChange();
  };
  fonts.addEventListener("loadingdone", done);
  return () => fonts.removeEventListener("loadingdone", done);
}
