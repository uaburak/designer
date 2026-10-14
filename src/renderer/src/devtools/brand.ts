// TEMPORARY developer tool (see DevPanel.tsx): one brand colour in, every brand-family token out, for both themes.
// Each token keeps its own relation to the original brand colour (the hue it's turned by, how much lighter/darker and
// more/less saturated, its alpha), applied to the new colour — so hover stays a touch darker, the tertiary tint stays a
// pale wash, selection stays the brand's. The family is the colour tokens whose hue is near the original brand's (and
// that are saturated), minus other roles' families (component, danger, warning, success, AI, folders, files).
import type { Theme } from "./store";

interface RGBA {
  r: number;
  g: number;
  b: number;
  a: number;
}

export function parseColor(v: string): RGBA | null {
  v = v.trim();
  let m = v.match(/^#([0-9a-f]{3,8})$/i);
  if (m) {
    let h = m[1];
    if (h.length === 3 || h.length === 4) h = [...h].map((c) => c + c).join("");
    if (h.length !== 6 && h.length !== 8) return null;
    const n = (i: number) => parseInt(h.slice(i, i + 2), 16);
    return { r: n(0), g: n(2), b: n(4), a: h.length === 8 ? n(6) / 255 : 1 };
  }
  m = v.match(/^rgba?\(\s*([\d.]+)[\s,]+([\d.]+)[\s,]+([\d.]+)(?:[\s,/]+([\d.]+%?))?\s*\)$/i);
  if (m) {
    const a = m[4] === undefined ? 1 : m[4].endsWith("%") ? parseFloat(m[4]) / 100 : parseFloat(m[4]);
    return { r: +m[1], g: +m[2], b: +m[3], a };
  }
  return null;
}

function toHsl({ r, g, b }: RGBA): [number, number, number] {
  r /= 255;
  g /= 255;
  b /= 255;
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const l = (max + min) / 2;
  if (max === min) return [0, 0, l];
  const d = max - min;
  const s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
  const h = max === r ? (g - b) / d + (g < b ? 6 : 0) : max === g ? (b - r) / d + 2 : (r - g) / d + 4;
  return [h * 60, s, l];
}

function fromHsl(h: number, s: number, l: number, a: number): string {
  h = ((h % 360) + 360) % 360;
  const c = (1 - Math.abs(2 * l - 1)) * s;
  const x = c * (1 - Math.abs(((h / 60) % 2) - 1));
  const m = l - c / 2;
  const [r, g, b] = h < 60 ? [c, x, 0] : h < 120 ? [x, c, 0] : h < 180 ? [0, c, x] : h < 240 ? [0, x, c] : h < 300 ? [x, 0, c] : [c, 0, x];
  const hex = (v: number) =>
    Math.round(Math.min(1, Math.max(0, v + m)) * 255)
      .toString(16)
      .padStart(2, "0");
  const alpha = a < 1 ? Math.round(a * 255).toString(16).padStart(2, "0") : "";
  return `#${hex(r)}${hex(g)}${hex(b)}${alpha}`;
}

const clamp = (v: number, lo = 0, hi = 1) => Math.min(hi, Math.max(lo, v));
const hueDist = (a: number, b: number) => Math.abs(((a - b + 540) % 360) - 180);
const OTHER_ROLES = /component|danger|warning|success|ai-|folder|file-|figjam|slides|sites|buzz|dev|measure|graph|marquee-fill/;

/** The stylesheets' own token values per theme (not the panel's overrides): what the relations are measured from. */
export function baseTokens(): Record<Theme, Record<string, string>> {
  const out: Record<Theme, Record<string, string>> = { light: {}, dark: {} };
  const walk = (rules: CSSRuleList) => {
    for (const rule of Array.from(rules)) {
      if (rule instanceof CSSStyleRule) {
        const sel = rule.selectorText;
        if (/data-contrast/.test(sel)) continue;
        const themes: Theme[] = /\[data-theme="?dark"?\]/.test(sel) ? ["dark"] : /\[data-theme="?light"?\]/.test(sel) ? ["light"] : /:root/.test(sel) ? ["light", "dark"] : [];
        for (const t of themes) for (const p of Array.from(rule.style)) if (p.startsWith("--")) out[t][p] ??= rule.style.getPropertyValue(p).trim();
      } else if ("cssRules" in rule) walk((rule as CSSGroupingRule).cssRules);
    }
  };
  for (const sheet of Array.from(document.styleSheets)) {
    if ((sheet.ownerNode as Element | null)?.hasAttribute?.("data-dev-panel")) continue;
    try {
      walk(sheet.cssRules);
    } catch {
      // cross-origin
    }
  }
  return out;
}

/** The brand family's tokens for `theme`, recoloured from `brand` (a hex). */
export function brandTokens(brand: string, theme: Theme, base = baseTokens()): Record<string, string> {
  const want = parseColor(brand);
  const tokens = base[theme];
  const orig = parseColor(tokens["--figma-color-bg-brand"] ?? "");
  if (!want || !orig) return {};
  const [oh, os, ol] = toHsl(orig);
  const [nh, ns, nl] = toHsl(want);
  const out: Record<string, string> = {};
  for (const [name, value] of Object.entries(tokens)) {
    if (!/color/.test(name) || OTHER_ROLES.test(name)) continue;
    const c = parseColor(value);
    if (!c) continue;
    const [h, s, l] = toHsl(c);
    if (s < 0.25 || hueDist(h, oh) > 28) continue;
    // The same turn of hue, and the same lightness / saturation steps, from the new colour (tints keep their paleness)
    const L = l > 0.85 || l < 0.15 ? l : clamp(nl + (l - ol));
    const S = clamp(ns + (s - os));
    out[name] = fromHsl(nh + (h - oh), S, L, c.a);
  }
  out["--figma-color-bg-brand"] = fromHsl(nh, ns, nl, 1);
  return out;
}
