/**
 * Figma's keyboard shortcut table (docs/research/atlas/03-menus-shortcuts.md §6): the JSON its editor carries in its
 * C++ binary — 260 action ids, 1 183 bindings — kept as it is in shortcuts.figma.json. An action has entries: the edit
 * modes they work in ("GLOBAL" but "!TEXT", or only "TEXT"…), then their bindings. A binding is "Mod+Mod+Key" — the key
 * a character as the keyboard layout types it ("Ä", "=", "+") or a named key ("Enter", "Num +", "Page Up") — with the
 * conditions that must all hold (platform, editor, preference, flag, keyboard layout) and what menus show when that
 * isn't the keys ("Meta+Shift+=" shown "Meta++"). The first binding that applies is the one a menu shows (§6.1). Pure
 * data and its reading, shared.
 */
import TABLE_JSON from "./shortcuts.figma.json";

type RawBinding = string | (string | { display: string })[];
type RawTable = Record<string, { editModes: string[]; shortcuts: RawBinding[] }[]>;

const TABLE = TABLE_JSON as unknown as RawTable;

/** Figma's keyboard layouts (§7.1: its enum's names as the table's `layout:` conditions write them). */
export type FigmaLayout =
  | "unknown"
  | "us_qwerty"
  | "dvorak"
  | "german"
  | "french_azerty"
  | "hiragana_kana"
  | "uk_mac"
  | "uk_pc"
  | "swedish"
  | "danish"
  | "norwegian"
  | "italian"
  | "spanish"
  | "finnish"
  | "spanish_latam"
  | "chinese"
  | "portuguese"
  | "korean";

/** Figma's editors a binding can name; ours are Design, Draw (illustration) and Dev Mode (dev_handoff). */
export type FigmaEditor = "design" | "illustration" | "dev_handoff";

/** What a binding's conditions are read against. */
export interface TableContext {
  mac: boolean;
  editor: FigmaEditor;
  layout: FigmaLayout;
  /** The desktop app (Figma's `desktop`) */
  desktop: boolean;
  /** Preferences › Use number keys for opacity (`pref:use-numbers-for-opacity`) */
  numbersForOpacity: boolean;
  /** Preferences › Use old shortcuts for outlines (`pref:use-old-outline-shortcuts`) */
  oldOutlineShortcuts: boolean;
  /** Figma's feature flags that are on here (`flag:metronome`: Motion) */
  flags: readonly string[];
}

/** Keys as the table writes them: the modifiers and the key. */
export interface TableKeys {
  key: string;
  meta?: boolean;
  control?: boolean;
  alt?: boolean;
  shift?: boolean;
}

export interface TableBinding extends TableKeys {
  /** What menus show instead (absent: the keys themselves) */
  display?: TableKeys;
  /** The edit modes it is inert in ("TEXT", "VECTOR", "BRANCHING"…) */
  except: string[];
  /** The edit modes it works in alone (empty: every mode but `except`) */
  only: string[];
}

const MODIFIERS: Record<string, keyof Omit<TableKeys, "key">> = { Meta: "meta", Control: "control", Alt: "alt", Shift: "shift" };

/** "Meta+Shift+=" → its modifiers and key ("Meta++" is ⌘ and "+", "Meta+Num +" ⌘ and "Num +"). */
export function parseTableKeys(text: string): TableKeys {
  const out: TableKeys = { key: "" };
  let rest = text;
  for (;;) {
    const at = rest.indexOf("+");
    const name = at > 0 ? rest.slice(0, at) : "";
    const mod = MODIFIERS[name];
    // A modifier only with a key after it ("Shift+" alone would be no key).
    if (!mod || at === rest.length - 1) break;
    out[mod] = true;
    rest = rest.slice(at + 1);
  }
  out.key = rest;
  return out;
}

const EDITORS = new Set(["design", "illustration", "dev_handoff", "figjam", "slides", "buzz", "sites", "zoom", "handoff_extension", "mcp_app"]);

/** Does one condition hold? Unknown ones (other hosts, labs, flags not on) don't. */
export function holds(condition: string, ctx: TableContext): boolean {
  if (condition.startsWith("!")) return !holds(condition.slice(1), ctx);
  if (condition === "mac") return ctx.mac;
  if (condition === "desktop") return ctx.desktop;
  if (EDITORS.has(condition)) return condition === ctx.editor;
  if (condition.startsWith("layout:")) return condition.slice(7) === ctx.layout;
  if (condition === "pref:use-numbers-for-opacity") return ctx.numbersForOpacity;
  if (condition === "pref:use-old-outline-shortcuts") return ctx.oldOutlineShortcuts;
  if (condition.startsWith("flag:")) return ctx.flags.includes(condition.slice(5));
  // chromeos, safari, ipad, meet-device, lab:…, slides:…, selection-only-slides-or-assets
  return false;
}

/** The action ids the table has (260). */
export const TABLE_ACTIONS: readonly string[] = Object.keys(TABLE);

/** Every binding of an action whose conditions hold here, in the table's order (the first is the one menus show). */
export function tableBindings(action: string, ctx: TableContext): TableBinding[] {
  const out: TableBinding[] = [];
  for (const entry of TABLE[action] ?? []) {
    const except = entry.editModes.filter((m) => m.startsWith("!")).map((m) => m.slice(1));
    const only = entry.editModes.filter((m) => !m.startsWith("!") && m !== "GLOBAL");
    for (const raw of entry.shortcuts) {
      const [keys, ...conditions] = typeof raw === "string" ? [raw] : raw;
      if (typeof keys !== "string") continue;
      let display: TableKeys | undefined;
      let ok = true;
      for (const c of conditions) {
        if (typeof c === "string") ok &&= holds(c, ctx);
        else display = parseTableKeys(c.display);
      }
      if (ok) out.push({ ...parseTableKeys(keys), ...(display ? { display } : {}), except, only });
    }
  }
  return out;
}

/** Every binding of the table, whatever its conditions (counts and checks). */
export function allTableBindings(): { action: string; keys: string; conditions: string[] }[] {
  const out: { action: string; keys: string; conditions: string[] }[] = [];
  for (const [action, entries] of Object.entries(TABLE))
    for (const entry of entries)
      for (const raw of entry.shortcuts) {
        const [keys, ...rest] = typeof raw === "string" ? [raw] : raw;
        out.push({ action, keys: keys as string, conditions: rest.filter((c): c is string => typeof c === "string") });
      }
  return out;
}
