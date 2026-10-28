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
  /** A tag at the row's right end (live context-layer-row.txt: "Rename layers" with an "AI" link, 20 × 18 at 164) */
  badge?: string;
  /** A chip right after the label (live 2026-10-18 effects-add-menu.txt: Shader's "Beta", 32 × 16, 8 after it) */
  chip?: string;
  icon?: IconName;
  /** A filled dot before the label in this colour — a token, e.g. `var(--figma-color-bg-success)` (the frame status menu) */
  swatch?: string;
  /** The row's own colour — a token (the frame status menu): its glyph in it, and the highlight in it instead of the
   *  menu's blue (the glyph and label white on it) */
  tint?: string;
  /** A space's 16 square before the label (the space switcher's orgs, docs/multiplayer.md §14.16): its picture
   *  (a data: URL) or, without one, the name's initial on a colour */
  spaceAvatar?: { name: string; src?: string | null };
  /** A glyph after the label (a locked layer's padlock in "Select layer ▸") */
  trailingIcon?: IconName;
  /** The check column appears when any item defines it */
  checked?: boolean;
  /** The glyph before this item's own label, not in a column (live main menu: "Actions…" at 40, the others at 16) */
  inlineIcon?: boolean;
  /** One of a set (live: the toolbar's tool menus are `menuitemradio`); drawn as a checked item */
  radio?: boolean;
  /** A submenu's least width (live Figma's measured width where its rows alone don't make it) */
  minWidth?: number;
  /** A submenu's width as live Figma measured it (the rows alone come out a fraction wider; see Menu `width`) */
  width?: number;
  /** A submenu's margin to the window's bottom where live measured another than 8 (Preferences: 5) */
  edgeBottom?: number;
  disabled?: boolean;
  /** No special colour (Figma doesn't colour delete); kept for the native menu */
  danger?: boolean;
  items?: MenuEntry[];
  /**
   * The account menu's header (Home; live Figma): the person's photo (48) centred, the label — their name — underlined
   * as a link, the email under it in the secondary colour. Still a row of the menu (keys reach it; picking it runs it).
   */
  profile?: { email: string; picture?: string };
  /** `checked` drawn at the row's end instead of in a check column (the account menu's current account: every row keeps
   *  the glyph column's text edge) */
  checkEnd?: boolean;
  /** A person's photo in the glyph column (the account menu's accounts) */
  avatar?: { name: string; picture?: string };
};
export type MenuHeader = { header: string };
export type MenuEntry = MenuItem | "-" | MenuHeader;

export const isItem = (e: MenuEntry): e is MenuItem => e !== "-" && !("header" in e);

/**
 * A shortcut as live Figma's context menus draw it: one glyph per key (the modifiers ⌃ ⌥ ⇧ ⌘ each on its own, then
 * the key — "⇧⌘R" → ⇧, ⌘, R; "⌘⌫" → ⌘, ⌫; "Ctrl+Shift+R" stays whole).
 */
export function shortcutKeys(shortcut: string): string[] {
  const out: string[] = [];
  let rest = shortcut;
  while (rest.length > 1 && "⌃⌥⇧⌘".includes(rest[0])) {
    out.push(rest[0]);
    rest = rest.slice(1);
  }
  if (rest) out.push(rest);
  return out;
}

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
