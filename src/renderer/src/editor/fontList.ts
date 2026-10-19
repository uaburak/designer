/**
 * The font pickers' list (docs/editor.md "Typography"): every family the font service knows — the bundled Inter and
 * the desktop's index of the system's and the user's fonts (`fonts:list`, src/main/fonts.ts), variable fonts by
 * their named instances, Google Fonts, and the open file's organization and team fonts (docs/desktop.md §14.3) —
 * with each family's own styles. Read once per process and again when the list changes.
 */
import { t } from "@/i18n";
import { useEffect, useState } from "react";
import { fonts, type FontFamily, type FontScope } from "@/engine/fonts";

let current: FontFamily[] | null = null;

function load(): Promise<FontFamily[]> {
  return fonts.families().then((list) => (current = list));
}

/** The families (null until the first list arrives). Re-renders when fonts are installed or removed. */
export function useFontFamilies(): FontFamily[] | null {
  const [list, setList] = useState<FontFamily[] | null>(current);
  useEffect(() => {
    let alive = true;
    const read = () =>
      void load()
        .then((l) => alive && setList(l))
        .catch(() => {});
    read();
    const off = fonts.onListChange(read);
    return () => {
      alive = false;
      off();
    };
  }, []);
  return list;
}

/** The open file's organization (for "Used at ‹organization›"); null in a local file. Re-renders when it changes. */
export function useFontScope(): FontScope | null {
  const [scope, setScope] = useState<FontScope | null>(() => fonts.scope());
  useEffect(() => {
    const read = () => setScope(fonts.scope());
    read();
    return fonts.onListChange(read);
  }, []);
  return scope;
}

/**
 * The family options a picker shows: the list's, plus the names in `extra` it lacks (a file's missing fonts stay
 * selectable as the current value).
 */
export function familyNames(list: readonly FontFamily[] | null, extra: readonly string[]): string[] {
  const names = list ? list.map((f) => f.family) : [];
  const have = new Set(names.map((n) => n.toLowerCase()));
  const missing = [...new Set(extra.filter((n) => n && !have.has(n.toLowerCase())))];
  if (!missing.length) return names;
  return [...names, ...missing].sort((a, b) => a.localeCompare(b, undefined, { sensitivity: "base" }));
}

/** A family's styles for the Font style menu; a family not in the list offers the current style only. */
export function familyStyles(list: readonly FontFamily[] | null, family: string, currentStyle?: string): string[] {
  const f = list?.find((x) => x.family.toLowerCase() === family.toLowerCase());
  const styles = f ? [...f.styles] : [];
  if (currentStyle && !styles.some((s) => s === currentStyle)) styles.unshift(currentStyle);
  return styles;
}

// ---- The picker's filters (Figma's "All fonts" menu) ------------------------------------------

/**
 * Figma's font filters, in live's order (popovers/font-picker-filter-menu.txt: 240 × 229): All fonts | In this file |
 * Popular fonts, Google fonts, Variable fonts | [Used at ‹organization›], Uploaded by you, Installed by you. "Used at
 * ‹organization›" (R11 §4: shared fonts, organizations only) is shown only in an organization's file and lists the
 * organization's and the file's team's fonts (docs/desktop.md §14.3). Nothing is uploaded to this app's picker as
 * "yours" yet, so "Uploaded by you" lists nothing.
 */
export const FONT_FILTERS = [
  { value: "all", label: "All fonts" },
  { value: "file", label: "In this file" },
  { value: "popular", label: "Popular fonts" },
  { value: "google", label: "Google fonts" },
  { value: "variable", label: "Variable fonts" },
  { value: "org", label: "Used at" },
  { value: "uploaded", label: "Uploaded by you" },
  { value: "installed", label: "Installed by you" },
] as const;
export type FontFilter = (typeof FONT_FILTERS)[number]["value"];

/**
 * The filter menu's rows with live's lines between its groups (after All fonts, In this file, Variable fonts); in an
 * organization's file (`orgName` given) "Used at ‹organization›" heads the last group. `local: false` — the web app,
 * which has no fonts on the computer (Figma's needs its font installer for them): no "Uploaded by you" or "Installed
 * by you" (this app's uploaded fonts are files on the computer too, docs/desktop.md §14.2).
 */
export function fontFilterMenu(orgName: string | null = null, opts: { local?: boolean } = {}): ({ value: FontFilter; label: string } | "-")[] {
  const [all, file, popular, google, variable, org, uploaded, installed] = FONT_FILTERS;
  const used = orgName !== null ? [{ value: org.value, label: t("Used at {org}", { org: orgName }) }] : [];
  const local = opts.local === false ? [] : [uploaded, installed];
  const last = [...used, ...local];
  return [all, "-", file, "-", popular, google, variable, ...(last.length ? ["-" as const, ...last] : [])];
}

/** The menu outside an organization (a local file). */
export const FONT_FILTER_MENU = fontFilterMenu(null);

/**
 * Figma's "Popular fonts" (Atlas 06 §6.2, `3187` 119712): fifteen slots, each the first of its names the list has
 * (the system UI fonts by their names on Windows and on a Mac).
 */
export const POPULAR_FONTS: readonly (readonly string[])[] = [
  ["Inter"], ["Roboto"], ["Segoe", "Segoe UI"], ["SF Pro Text", "SF UI Text"], ["Serif"], ["Crimson Text"], ["New York"],
  ["Playfair Display"], ["Source Serif Pro"], ["Caveat"], ["Figma Hand"], ["Pacifico"], ["Anonymous Pro"], ["IBM Plex Mono"],
  ["Roboto Mono"],
];

/** The families "Popular fonts" lists from `list` (lower case). */
export function popularFamilies(list: readonly FontFamily[]): Set<string> {
  const have = new Set(list.map((f) => f.family.toLowerCase()));
  const out = new Set<string>();
  for (const slot of POPULAR_FONTS) {
    const name = slot.find((n) => have.has(n.toLowerCase()));
    if (name) out.add(name.toLowerCase());
  }
  return out;
}

/**
 * Google families Figma never lists (§6.3): the "…charted" ones, Playwrite's but two, test and placeholder families,
 * and the colour fonts its renderer can't draw.
 */
const HIDDEN_GOOGLE = new Set(
  ["Noto Color Emoji Compat Test", "?????", "Decovar Alpha", "Blaka Ink", "Bungee Color", "Bungee Spice", "Cairo Play", "Foldit", "Honk", "Kalnia Glaze", "Noto Color Emoji", "Noto Znamenny Musical Notation"].map((n) => n.toLowerCase())
);
/** And not under "Google fonts" (§6.2: families Figma serves itself, icon fonts, the system ones). */
const NOT_GOOGLE_SET = new Set(
  ["Ested-VF", "Figma Hand", "Font Awesome 5", "Font Awesome 6", "KyivType", "Material Icons", "SF Pro", "SF Pro Rounded", "SF Compact", "SF Compact Rounded", "Sudo Var", "Wavefont"].map((n) => n.toLowerCase())
);

/** Whether the picker lists a family at all (§6.3): families with no styles and the hidden Google families aren't. */
export function listedFamily(f: FontFamily): boolean {
  if (!f.styles.length) return false;
  if (f.source !== "google") return true;
  const name = f.family.toLowerCase();
  if (HIDDEN_GOOGLE.has(name) || name.endsWith("charted")) return false;
  return !name.startsWith("playwrite ") || name === "playwrite us modern" || name === "playwrite us trad";
}

const fold = (s: string) => s.normalize("NFKD").replace(/[̀-ͯ]/g, "").toLowerCase();

/**
 * A search's words (Figma's, §6.3): lower case, split at spaces and punctuation ("helvetica-neue" is two), accents
 * ignored.
 */
export function searchTokens(query: string): string[] {
  return fold(query)
    .split(/[\s\p{P}\p{S}]+/u)
    .filter(Boolean);
}

/**
 * The families a filter and a search leave, in the list's order (by name; "In this file" by use, most used first,
 * when `inFile` counts them). `inFile`: the families the document uses (lower case). A search (Figma's, §6.3) keeps
 * the families holding every word, case and accents ignored, those starting with the first word first; names that
 * start with "." are hidden from it.
 */
export function filterFamilies(
  list: readonly FontFamily[],
  filter: FontFilter,
  query: string,
  inFile: ReadonlySet<string> | ReadonlyMap<string, number> = new Set()
): FontFamily[] {
  let out: readonly FontFamily[] = list.filter(listedFamily);
  switch (filter) {
    case "file":
      out = out.filter((f) => inFile.has(f.family.toLowerCase()));
      if (inFile instanceof Map) {
        const uses = inFile as ReadonlyMap<string, number>;
        out = [...out].sort((a, b) => (uses.get(b.family.toLowerCase()) ?? 0) - (uses.get(a.family.toLowerCase()) ?? 0));
      }
      break;
    case "popular": {
      const top = popularFamilies(out);
      out = out.filter((f) => top.has(f.family.toLowerCase()));
      break;
    }
    case "installed":
      out = out.filter((f) => f.source === "local");
      break;
    case "google":
      out = out.filter((f) => f.source === "google" && !NOT_GOOGLE_SET.has(f.family.toLowerCase()));
      break;
    case "variable":
      // Every face a variable font (§6.2).
      out = out.filter((f) => f.faces.length > 0 && f.faces.every((x) => x.variable));
      break;
    case "org":
      out = out.filter((f) => f.source === "shared");
      break;
    case "uploaded":
      out = [];
      break;
  }
  const words = searchTokens(query);
  if (!words.length) return [...out];
  const found = out.filter((f) => {
    if (f.family.startsWith(".")) return false;
    const name = fold(f.family);
    return words.every((w) => name.includes(w));
  });
  const first = (f: FontFamily) => (fold(f.family).startsWith(words[0]) ? 0 : 1);
  return found.map((f, i) => ({ f, i })).sort((a, b) => first(a.f) - first(b.f) || a.i - b.i).map((x) => x.f);
}

// ---- The document's fonts ---------------------------------------------------------------------

export interface DocumentFontUse {
  family: string;
  style: string;
  uses: number;
}

interface FontsReader {
  documentFonts(): DocumentFontUse[];
  on(type: "DOCUMENT_CHANGED", cb: () => void): () => void;
}

/** The fonts the document names (engine.documentFonts), read again a moment after each committed change. */
export function useDocumentFonts(engine: FontsReader | null, delayMs = 250): DocumentFontUse[] {
  const [used, setUsed] = useState<DocumentFontUse[]>(() => {
    try {
      return engine?.documentFonts() ?? [];
    } catch {
      return [];
    }
  });
  useEffect(() => {
    if (!engine) return;
    let timer = 0;
    const read = () => {
      timer = 0;
      try {
        setUsed(engine.documentFonts());
      } catch {
        // the engine is gone
      }
    };
    read();
    const off = engine.on("DOCUMENT_CHANGED", () => {
      if (!timer) timer = window.setTimeout(read, delayMs);
    });
    return () => {
      off();
      if (timer) window.clearTimeout(timer);
    };
  }, [engine, delayMs]);
  return used;
}

const normStyle = (s: string) => s.replace(/[\s_-]/g, "").toLowerCase();

/** Whether `family` has `style` (spaces, case and the PostScript name as the engine matches them). */
export function hasStyle(family: FontFamily, style: string): boolean {
  const s = normStyle(style);
  return family.styles.some((x) => normStyle(x) === s) || family.faces.some((x) => !!x.postscriptName && normStyle(x.postscriptName) === s);
}

/**
 * The document's fonts nobody has: a family not in the list, or a style the family lacks (Figma counts both as
 * missing). In the engine's order (family, then style).
 */
export function missingFonts(list: readonly FontFamily[] | null, used: readonly DocumentFontUse[]): DocumentFontUse[] {
  if (!list) return [];
  const byName = new Map(list.map((f) => [f.family.toLowerCase(), f]));
  return used.filter((u) => {
    const f = byName.get(u.family.toLowerCase());
    return !f || !hasStyle(f, u.style);
  });
}

/** Figma's weight order for a style's name ("Semi Bold Italic" → 600). */
const WEIGHTS: [RegExp, number][] = [[/hairline|thin/i, 100], [/extra ?light|ultra ?light/i, 200], [/semi ?bold|demi ?bold/i, 600], [/extra ?bold|ultra ?bold/i, 800], [/light/i, 300], [/medium/i, 500], [/black|heavy/i, 900], [/bold/i, 700]];
export function styleWeight(style: string): number {
  for (const [re, w] of WEIGHTS) if (re.test(style)) return w;
  return 400;
}

/** The Font style menu's groups (live): upright styles by weight, then the italic ones by weight. */
export function groupStyles(list: readonly string[]): { upright: string[]; italic: string[] } {
  const italic = (s: string) => /italic|oblique/i.test(s);
  const order = (a: string, b: string) => styleWeight(a) - styleWeight(b);
  return { upright: list.filter((s) => !italic(s)).sort(order), italic: list.filter(italic).sort(order) };
}
