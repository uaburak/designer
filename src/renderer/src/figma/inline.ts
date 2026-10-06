/**
 * What an exported file carries inside it: its pictures' and its fonts'
 * bytes as data URLs (an SVG opened on its own, or drawn as an image, loads
 * nothing of its own).
 */

/** A file's bytes as a data URL — null when it can't be read (CORS, gone). */
export async function dataUrl(url: string): Promise<string | null> {
  if (url.startsWith("data:")) return url;
  try {
    const res = await fetch(url, { mode: "cors", credentials: "omit" });
    if (!res.ok) return null;
    const blob = await res.blob();
    return await new Promise<string>((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(String(reader.result));
      reader.onerror = () => reject(reader.error);
      reader.readAsDataURL(blob);
    });
  } catch {
    return null;
  }
}

const URL_IN_CSS = /url\(\s*(['"]?)([^'")]+)\1\s*\)/g;

/** What a text asks of the fonts: its families (CSS's list), its weight and style, its characters. */
export interface FontUse {
  family: string;
  weight: number;
  style: string;
  text: string;
}

const unquoted = (family: string) => family.trim().replace(/^['"]|['"]$/g, "");
const weightRange = (v: string): [number, number] => {
  const [a, b] = v.trim().split(/\s+/).map((p) => (p === "bold" ? 700 : p === "normal" || !p ? 400 : parseFloat(p)));
  return [a || 400, b || a || 400];
};
/** A face's unicode-range ("U+0000-00FF, U+0131, U+4??") as code point spans — all of them when it has none. */
const codeRanges = (v: string): [number, number][] =>
  v.trim()
    ? v.split(",").map((r) => r.trim().replace(/^u\+/i, "")).filter(Boolean).map((r): [number, number] => {
        if (r.includes("?")) return [parseInt(r.replace(/\?/g, "0"), 16), parseInt(r.replace(/\?/g, "F"), 16)];
        const [a, b = a] = r.split("-");
        return [parseInt(a, 16), parseInt(b, 16)];
      })
    : [[0, 0x10ffff]];

/**
 * The page's own @font-face rules a file's texts are drawn with, their files
 * inside them: for each text, its family's files of the nearest weight (as
 * the browser picks one) that hold one of its characters — not every weight
 * and alphabet the page loads. A file the page declares for several weights
 * (a variable font's, at 300, 400…) goes in once, for all of them: the
 * alphabets of a family keep the same descriptors, so the browser takes them
 * as one font (with different ones it would take one alphabet alone).
 */
export async function fontsCss(uses: readonly FontUse[]): Promise<string> {
  if (!uses.length) return "";
  interface FontFile { cssText: string; base: string | null; family: string; italic: boolean; weights: [number, number]; ranges: [number, number][] }
  const files = new Map<string, FontFile>();
  for (const sheet of [...document.styleSheets]) {
    let list: CSSRuleList;
    try {
      list = sheet.cssRules;
    } catch {
      continue; // another site's sheet
    }
    for (const rule of [...list]) {
      if (!(rule instanceof CSSFontFaceRule)) continue;
      const family = unquoted(rule.style.getPropertyValue("font-family"));
      const italic = /italic|oblique/.test(rule.style.getPropertyValue("font-style"));
      const range = rule.style.getPropertyValue("unicode-range");
      const weights = weightRange(rule.style.getPropertyValue("font-weight"));
      const key = [family, italic, rule.style.getPropertyValue("src"), range].join("|");
      const known = files.get(key);
      if (known) known.weights = [Math.min(known.weights[0], weights[0]), Math.max(known.weights[1], weights[1])];
      else files.set(key, { cssText: rule.cssText, base: sheet.href, family, italic, weights, ranges: codeRanges(range) });
    }
  }
  const all = [...files.values()];
  const chosen = new Set<FontFile>();
  for (const use of uses) {
    const families = new Set(use.family.split(",").map(unquoted));
    const italic = use.style !== "normal";
    const own = all.filter((f) => families.has(f.family));
    const styled = own.some((f) => f.italic === italic) ? own.filter((f) => f.italic === italic) : own;
    const distance = (f: FontFile) => (use.weight < f.weights[0] ? f.weights[0] - use.weight : use.weight > f.weights[1] ? use.weight - f.weights[1] : 0);
    const nearest = Math.min(...styled.map(distance));
    const points = [...use.text].map((ch) => ch.codePointAt(0)!);
    for (const f of styled) if (distance(f) === nearest && points.some((p) => f.ranges.some(([a, b]) => p >= a && p <= b))) chosen.add(f);
  }
  const rules: string[] = [];
  for (const f of chosen) {
    const [low, high] = f.weights;
    let css = f.cssText.replace(/font-weight:\s*[^;]+;/, `font-weight: ${low === high ? low : `${low} ${high}`};`);
    for (const m of css.matchAll(URL_IN_CSS)) {
      const data = await dataUrl(new URL(m[2], f.base ?? location.href).href);
      if (data) css = css.replace(m[0], `url("${data}")`);
    }
    rules.push(css);
  }
  return rules.join("\n");
}
