/**
 * Key caps as the Keyboard shortcuts panel draws them (live: one bordered cap per key in Apple's order ⌃ ⌥ ⇧ ⌘, the
 * key last; "↩ Enter", "⇥ Tab", "⎋ Esc", "Space", "Home", "End" as words; Page Up / Down as 🌐 ↑ / ↓; "and" between
 * two keys that share their modifiers: "⌘ B and I").
 */
import { IS_MAC, type IconName } from "@/ds";
import { sameCombo, type KeyCombo } from "@shared/shortcuts";
import type { FixedCap, ShortcutRow } from "./panelData";
import { keysOf, type Bindings } from "./keymap";

export interface Cap {
  text: string;
  icon?: IconName;
}

/** The caps of a row's keys: one group per command ("and" between groups); `part` is the row's part it sets. */
export interface CapGroup {
  part: number;
  caps: Cap[];
}

const MAC_MODS: Record<string, string> = { ctrl: "⌃", alt: "⌥", shift: "⇧", mod: "⌘" };
const PC_MODS: Record<string, string> = { ctrl: "Ctrl", alt: "Alt", shift: "Shift", mod: "Ctrl" };

const KEY_CAP: Record<string, string> = {
  Enter: "↩ Enter",
  NumpadEnter: "↩ Enter",
  Tab: "⇥ Tab",
  Escape: "⎋ Esc",
  Space: "Space",
  Backspace: "⌫",
  Delete: "⌦",
  Home: "Home",
  End: "End",
  ArrowUp: "↑",
  ArrowDown: "↓",
  ArrowLeft: "←",
  ArrowRight: "→",
  BracketLeft: "[",
  BracketRight: "]",
  Backslash: "\\",
  Equal: "+",
  Minus: "–",
  Slash: "/",
  Quote: "′",
  Semicolon: ";",
  Comma: ",",
  Period: ".",
  Backquote: "`",
  NumpadAdd: "+",
  NumpadSubtract: "–",
};

/** A layout's legend for a binding's key (shortcuts/layouts.ts), or null: the U.S. one. */
export type LegendOf = (code: string) => string | null;

/** One key's cap(s): Page Up / Down are the globe and an arrow on a Mac. */
export function keyCaps(code: string, mac = IS_MAC, legend?: LegendOf, labels?: Record<string, string>): Cap[] {
  if (labels?.[code]) return [{ text: labels[code] }];
  if (code === "PageUp" || code === "PageDown") return mac ? [{ text: "", icon: "24.globe" }, { text: code === "PageUp" ? "↑" : "↓" }] : [{ text: code === "PageUp" ? "PgUp" : "PgDn" }];
  const own = legend?.(code);
  if (own) return [{ text: own.toUpperCase() }];
  return [{ text: KEY_CAP[code] ?? code.replace(/^Key|^Digit|^Numpad/, "") }];
}

/** Modifier caps in Apple's order (elsewhere Ctrl, Alt, Shift). */
export function modCaps(c: Omit<KeyCombo, "code">, mac = IS_MAC): Cap[] {
  const order = mac ? (["ctrl", "alt", "shift", "mod"] as const) : (["mod", "ctrl", "alt", "shift"] as const);
  const names = mac ? MAC_MODS : PC_MODS;
  const out: Cap[] = [];
  for (const m of order) if (c[m] && !(m === "ctrl" && !mac && c.mod)) out.push({ text: names[m] });
  return out;
}

export const comboCaps = (c: KeyCombo, mac = IS_MAC, legend?: LegendOf, labels?: Record<string, string>): Cap[] => [...modCaps(c, mac), ...keyCaps(c.code, mac, legend, labels)];

const sameMods = (a: KeyCombo, b: KeyCombo) => sameCombo({ ...a, code: "" }, { ...b, code: "" });

/** A keys row's caps in force: each part's first key ("⌘ B and I" when they share their modifiers). */
export function rowCaps(row: Extract<ShortcutRow, { kind: "keys" }>, bindings: Bindings, mac = IS_MAC, legend?: LegendOf): CapGroup[] {
  const firsts = row.parts.map((p) => keysOf(p.command, bindings)[0] as KeyCombo | undefined);
  if (firsts.length === 2 && firsts[0] && firsts[1] && sameMods(firsts[0], firsts[1])) {
    return [
      { part: 0, caps: comboCaps(firsts[0], mac, legend, row.parts[0].labels) },
      { part: 1, caps: keyCaps(firsts[1].code, mac, legend, row.parts[1].labels) },
    ];
  }
  return row.parts.map((p, i) => ({ part: i, caps: firsts[i] ? comboCaps(firsts[i]!, mac, legend, p.labels) : [] }));
}

const FIXED: Record<string, Cap> = { enter: { text: "↩ Enter" }, tab: { text: "⇥ Tab" }, esc: { text: "⎋ Esc" }, backspace: { text: "⌫" }, globe: { text: "", icon: "24.globe" } };

/** A fixed row's caps (Figma's keys for what the engine or a gesture does). */
export function fixedCaps(caps: FixedCap[], mac = IS_MAC): Cap[] {
  const names = mac ? MAC_MODS : PC_MODS;
  return caps.map((c) => (names[c] ? { text: names[c] } : FIXED[c] ?? { text: c }));
}
