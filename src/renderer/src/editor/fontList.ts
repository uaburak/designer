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
