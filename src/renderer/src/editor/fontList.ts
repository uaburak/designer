/**
 * The font pickers' list (docs/editor.md "Typography"): every family the font service knows — the bundled Inter and
 * the desktop's index of the system's and the user's fonts (`fonts:list`, src/main/fonts.ts), variable fonts by
 * their named instances — with each family's own styles. Read once per process and again when the list changes.
 */
import { useEffect, useState } from "react";
import { fonts, type FontFamily } from "@/engine/fonts";

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
 * Figma's font filters (help.figma.com "Browse and apply fonts"): All fonts, In this file, Popular, Installed by you,
 * Google fonts, Variable fonts ("Used at <organization>" needs an organization; this app has none).
 */
export const FONT_FILTERS = [
  { value: "all", label: "All fonts" },
  { value: "file", label: "In this file" },
  { value: "popular", label: "Popular" },
  { value: "installed", label: "Installed by you" },
  { value: "google", label: "Google fonts" },
  { value: "variable", label: "Variable fonts" },
] as const;
export type FontFilter = (typeof FONT_FILTERS)[number]["value"];

/** How many of the most used Google families "Popular" lists (Figma curates its own; Google's ranking stands in). */
export const POPULAR_COUNT = 50;

const fold = (s: string) => s.normalize("NFKD").replace(/[̀-ͯ]/g, "").toLowerCase();

/**
 * The families a filter and a search leave, in the list's order (by name). `inFile`: the families the document uses
 * (lower case). A search matches anywhere in the name, case and accents ignored, words in any order.
 */
export function filterFamilies(list: readonly FontFamily[], filter: FontFilter, query: string, inFile: ReadonlySet<string> = new Set()): FontFamily[] {
  let out: readonly FontFamily[] = list;
  switch (filter) {
    case "file":
      out = list.filter((f) => inFile.has(f.family.toLowerCase()));
      break;
    case "popular": {
      const ranked = list.filter((f) => f.source === "google" && f.popularity !== undefined).sort((a, b) => a.popularity! - b.popularity!);
      const top = new Set(ranked.slice(0, POPULAR_COUNT).map((f) => f.family));
      // Figma's Inter, its default, is one of its popular fonts.
      top.add("Inter");
      out = list.filter((f) => top.has(f.family));
      break;
    }
    case "installed":
      out = list.filter((f) => f.source === "local");
      break;
    case "google":
      out = list.filter((f) => f.source === "google");
      break;
    case "variable":
      out = list.filter((f) => f.variable);
      break;
  }
  const words = fold(query).split(/\s+/).filter(Boolean);
  if (!words.length) return [...out];
  return out.filter((f) => {
    const name = fold(f.family);
    return words.every((w) => name.includes(w));
  });
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
