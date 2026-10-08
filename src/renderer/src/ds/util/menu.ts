import type { IconName } from "../icons/registry";

/** A menu's item (contract §4.8) — serialisable, so the same entries can build a native menu. */
export type MenuItem = {
  id: string;
  label: string;
  /** Display string, from keys() */
  shortcut?: string;
  /** Electron accelerator (native menus only) */
  accelerator?: string;
  /** A word after the label, greyed */
  hint?: string;
  icon?: IconName;
  /** A glyph after the label (a locked layer's padlock in "Select layer ▸") */
  trailingIcon?: IconName;
  /** The check column appears when any item defines it */
  checked?: boolean;
  disabled?: boolean;
  /** No special colour (Figma doesn't colour delete); kept for the native menu */
  danger?: boolean;
  items?: MenuEntry[];
};
export type MenuHeader = { header: string };
export type MenuEntry = MenuItem | "-" | MenuHeader;

export const isItem = (e: MenuEntry): e is MenuItem => e !== "-" && !("header" in e);

/** The entries as drawn: no line first, last or twice in a row (a header counts as a group start). */
export function tidy(entries: MenuEntry[]): MenuEntry[] {
  const out: MenuEntry[] = [];
  for (const entry of entries) {
    if (entry === "-" && (out.length === 0 || out[out.length - 1] === "-")) continue;
    out.push(entry);
  }
  while (out[out.length - 1] === "-") out.pop();
  return out;
}

/** The next enabled item from `from` in `dir`, wrapping; -1 when none. */
export function nextItem(list: MenuEntry[], from: number, dir: 1 | -1): number {
  const usable = list.map((e, i) => (isItem(e) && !e.disabled ? i : -1)).filter((i) => i >= 0);
  if (!usable.length) return -1;
  const at = usable.indexOf(from);
  return usable[at < 0 ? (dir === 1 ? 0 : usable.length - 1) : (at + dir + usable.length) % usable.length];
}

/** A native menu item as `menu:popup` takes it (structurally src/shared/ipc.ts NativeMenuItem; no electron import here). */
export type NativeMenuItem = {
  id?: string;
  label?: string;
  type?: "normal" | "separator" | "checkbox" | "submenu";
  checked?: boolean;
  enabled?: boolean;
  accelerator?: string;
  submenu?: NativeMenuItem[];
};

/** Entries → a native menu template (`menu:popup`): checks become checkboxes, headers disabled items. */
export function toNativeTemplate(entries: MenuEntry[]): NativeMenuItem[] {
  return tidy(entries).map((e): NativeMenuItem => {
    if (e === "-") return { type: "separator" };
    if (!isItem(e)) return { label: e.header, enabled: false };
    const base: NativeMenuItem = { id: e.id, label: e.label, enabled: !e.disabled };
    if (e.accelerator) base.accelerator = e.accelerator;
    if (e.items) return { ...base, type: "submenu", submenu: toNativeTemplate(e.items) };
    if (e.checked !== undefined) return { ...base, type: "checkbox", checked: e.checked };
    return base;
  });
}

/** Is `p` inside the triangle (a, b, c)? — the submenu's "safe area". */
export function inTriangle(p: { x: number; y: number }, a: { x: number; y: number }, b: { x: number; y: number }, c: { x: number; y: number }): boolean {
  const s = (p1: typeof p, p2: typeof p, p3: typeof p) => (p1.x - p3.x) * (p2.y - p3.y) - (p2.x - p3.x) * (p1.y - p3.y);
  const d1 = s(p, a, b);
  const d2 = s(p, b, c);
  const d3 = s(p, c, a);
  const neg = d1 < 0 || d2 < 0 || d3 < 0;
  const pos = d1 > 0 || d2 > 0 || d3 > 0;
  return !(neg && pos);
}
