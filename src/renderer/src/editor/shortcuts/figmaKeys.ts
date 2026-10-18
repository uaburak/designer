/**
 * The editor's commands' default keys, read from Figma's own table (src/shared/shortcutsTable.ts; Atlas 03 §6, §7):
 * each command that is one of Figma's actions names it here (`FIGMA_ACTION`, its id as the table, Quick actions'
 * popularity list and the menus use it), and its keys are the table's bindings that hold on this platform, in this
 * editor (Design, Draw, Dev Mode), for these preferences and this keyboard layout — Figma's per-layout bindings
 * included (German ⌘Ä bring forward, ⌘, Actions, ^ Show/Hide UI; Swedish letter spacing ⇧⌥). A command without one
 * keeps the registry's own keys.
 *
 * The table names a key by the character the layout types on it ("Ä", "#", "+"); the bindings name keys by their place
 * on a U.S. keyboard (src/shared/shortcuts.ts KeyCombo, shortcuts/layouts.ts). So a binding's character is found on
 * the layout's keyboard and that key taken as the bindings name it (the layout map's U.S. key); a character the layout
 * types only with ⌥ (] on a German keyboard) is no key there, as in Figma. Our Turkish layouts and the two Figma has no
 * bindings for (Finnish, Chinese: Atlas 03 open question 3) read the table as Figma's unknown layout.
 */
import type { KeyCombo, KeyboardLayoutId } from "@shared/shortcuts";
import { TABLE_ACTIONS, tableBindings, type FigmaEditor, type FigmaLayout, type TableContext, type TableKeys } from "@shared/shortcutsTable";
import { characters, layoutMap } from "./layouts";
import { FIGMA_ACTION } from "@shared/figmaActions";

export { FIGMA_ACTION };


const IN_TABLE = new Set(TABLE_ACTIONS);

/**
 * The same command's action in Figma's other editors (Atlas 03 §6.2): Dev Mode's Move (V), its ⇧D back to Design and
 * its Inspect panel (⌥8).
 */
const OTHER_EDITORS: Record<string, string[]> = {
  "tool.move": ["set-tool-default-dev-handoff"],
  "view.dev-mode": ["enter-design-mode"],
  "view.design-panel": ["show-dev-mode-inspect-panel"],
};

/** Figma's action id → our commands with it (File › Place image… and the toolbar's Image/video… are both `place`). */
export const COMMANDS_OF_ACTION = new Map<string, string[]>();
for (const [id, action] of Object.entries(FIGMA_ACTION)) COMMANDS_OF_ACTION.set(action, [...(COMMANDS_OF_ACTION.get(action) ?? []), id]);

/** The layout picked in the Layout tab, as Figma's table names it. */
export const FIGMA_LAYOUT: Record<KeyboardLayoutId, FigmaLayout> = {
  generic: "unknown",
  us: "us_qwerty",
  dvorak: "dvorak",
  de: "german",
  fr: "french_azerty",
  ja: "hiragana_kana",
  "en-gb-mac": "uk_mac",
  "en-gb-pc": "uk_pc",
  sv: "swedish",
  da: "danish",
  no: "norwegian",
  it: "italian",
  es: "spanish",
  // Figma has no bindings for these two (Atlas 03 §7.1, open question 3): the unknown layout's, until a probe says.
  fi: "unknown",
  zh: "unknown",
  "es-419": "spanish_latam",
  pt: "portuguese",
  ko: "korean",
  // Ours.
  "tr-f": "unknown",
  "tr-q-mac": "unknown",
};

/** What the editor's keys are read for (the table's conditions, Atlas 03 §6.1). */
export interface ShortcutContext {
  mac: boolean;
  /** Design (Motion too), Draw, Dev Mode */
  editor: FigmaEditor;
  layout: KeyboardLayoutId;
  desktop: boolean;
  numbersForOpacity: boolean;
  oldOutlineShortcuts: boolean;
}

/** Named keys → `KeyboardEvent.code`. */
const NAMED: Record<string, string> = {
  Backspace: "Backspace",
  Delete: "Delete",
  Enter: "Enter",
  Tab: "Tab",
  Escape: "Escape",
  Space: "Space",
  Left: "ArrowLeft",
  Right: "ArrowRight",
  Up: "ArrowUp",
  Down: "ArrowDown",
  Home: "Home",
  End: "End",
  "Page Up": "PageUp",
  "Page Down": "PageDown",
  F6: "F6",
  "Num +": "NumpadAdd",
  "Num -": "NumpadSubtract",
};

/** A U.S. keyboard: a character → its key, and ⇧ when the character is the key's upper one. */
const US_KEYS: Record<string, { code: string; shift?: true }> = {};
const US_ROWS: [string, string, string][] = [
  ["Backquote", "`", "~"],
  ["Minus", "-", "_"],
  ["Equal", "=", "+"],
  ["BracketLeft", "[", "{"],
  ["BracketRight", "]", "}"],
  ["Backslash", "\\", "|"],
  ["Semicolon", ";", ":"],
  ["Quote", "'", '"'],
  ["Comma", ",", "<"],
  ["Period", ".", ">"],
  ["Slash", "/", "?"],
];
for (const [code, lower, upper] of US_ROWS) {
  US_KEYS[lower] = { code };
  US_KEYS[upper] = { code, shift: true };
}
"!@#$%^&*()".split("").forEach((ch, i) => (US_KEYS[ch] = { code: `Digit${(i + 1) % 10}`, shift: true }));

/**
 * The keys of the two layouts whose letters aren't Latin (shortcuts keep the U.S. places there) that type other
 * characters than a U.S. keyboard: a Japanese (JIS) keyboard's ^ @ [ ] : ¥, a Korean one's ₩.
 */
const OWN_KEYS: Partial<Record<KeyboardLayoutId, Record<string, string>>> = {
  ja: { "^": "Equal", "@": "BracketLeft", "[": "BracketRight", "]": "Backslash", ":": "Quote", "¥": "IntlYen" },
  ko: { "₩": "Backslash" },
};

/** Layouts read with the U.S. keys (no remapping: shortcuts/prefs.ts's identity layouts) */
const US_PLACES = new Set<KeyboardLayoutId>(["generic", "us", "zh", "ko", "ja", "fi", "tr-f", "tr-q-mac"]);

/**
 * A table key on a layout → the key the bindings name (a U.S. place), and ⇧ when the character needs it there; null:
 * not a key of this layout.
 */
export function keyOf(key: string, layout: KeyboardLayoutId): { code: string; shift?: true } | null {
  if (NAMED[key]) return { code: NAMED[key] };
  const num = /^Num (\d)$/.exec(key);
  if (num) return { code: `Numpad${num[1]}` };
  if (/^[A-Za-z]$/.test(key)) return { code: `Key${key.toUpperCase()}` };
  if (/^\d$/.test(key)) return { code: `Digit${key}` };
  const own = OWN_KEYS[layout]?.[key];
  if (own) return { code: own };
  // Figma's unknown layout (and ours read as it) types the U.S. characters; so do the U.S. places' layouts.
  if (US_PLACES.has(layout) || FIGMA_LAYOUT[layout] === "unknown") return US_KEYS[key] ?? null;
  const ch = key.toLowerCase();
  for (const [code, typed] of characters(layout)) if (typed === ch || typed === key) return { code: layoutMap(layout).toBinding(code) ?? code };
  return null;
}

/** Table keys → a combo on this platform (⌘ the mod on a Mac, Ctrl elsewhere; Windows' Win key isn't one). */
function comboOf(k: TableKeys, layout: KeyboardLayoutId, mac: boolean): KeyCombo | null {
  if (!mac && k.meta) return null;
  const at = keyOf(k.key, layout);
  if (!at) return null;
  const c: KeyCombo = { code: at.code };
  if (mac ? k.meta : k.control) c.mod = true;
  if (mac && k.control) c.ctrl = true;
  if (k.alt) c.alt = true;
  if (k.shift || at.shift) c.shift = true;
  return c;
}

const sameKeys = (a: KeyCombo, b: KeyCombo) => a.code === b.code && !!a.mod === !!b.mod && !!a.shift === !!b.shift && !!a.alt === !!b.alt && !!a.ctrl === !!b.ctrl;

/** The edit modes the keyboard layer tells apart (the others — TEXT, BRANCHING — never reach it). */
const KEPT_MODES = new Set(["VECTOR"]);

/**
 * Figma's keys for a command here, in the table's order (the first is the one menus show), each key once; null: the
 * command isn't one of Figma's actions with keys (the registry's own stand).
 */
export function figmaKeys(command: string, ctx: ShortcutContext): KeyCombo[] | null {
  const actions = [FIGMA_ACTION[command], ...(OTHER_EDITORS[command] ?? [])].filter((a) => a && IN_TABLE.has(a));
  if (!actions.length) return null;
  const tableCtx: TableContext = {
    mac: ctx.mac,
    editor: ctx.editor,
    layout: FIGMA_LAYOUT[ctx.layout],
    desktop: ctx.desktop,
    numbersForOpacity: ctx.numbersForOpacity,
    oldOutlineShortcuts: ctx.oldOutlineShortcuts,
    // Motion is Figma's metronome.
    flags: ["metronome"],
  };
  const out: KeyCombo[] = [];
  for (const b of actions.flatMap((a) => tableBindings(a, tableCtx))) {
    // A mode of its own: Dev Mode's (DEV_HANDOFF) is ours; text edit mode's are the engine's (move / extend the text
    // selection), FigJam's and Slides' aren't here.
    if (b.only.length && !(ctx.editor === "dev_handoff" && b.only.includes("DEV_HANDOFF"))) continue;
    const c = comboOf(b, ctx.layout, ctx.mac);
    if (!c || out.some((o) => sameKeys(o, c))) continue;
    if (b.display) {
      const shown = comboOf(b.display, ctx.layout, ctx.mac);
      c.shown = { key: b.display.key, ...(shown?.mod ? { mod: true } : {}), ...(shown?.ctrl ? { ctrl: true } : {}), ...(b.display.alt ? { alt: true } : {}), ...(b.display.shift ? { shift: true } : {}) };
    }
    const except = b.except.filter((m) => KEPT_MODES.has(m));
    if (except.length) c.except = except;
    out.push(c);
  }
  return out;
}
