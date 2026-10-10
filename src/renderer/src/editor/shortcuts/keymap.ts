/**
 * The user's own keys (the owner's addition to Figma's Keyboard shortcuts panel): a binding replaces a command's keys
 * (src/shared/shortcuts.ts ShortcutSettings.bindings — only the commands changed; an empty list clears one). Pure
 * functions on the bindings, and `applyBindings`, which writes the keys in force into the command registry (the
 * keyboard layer, menus and tooltips read `command.keys`); the registry's defaults are Figma's, kept here.
 */
import { IS_MAC } from "@/ds";
import { sameCombo, type KeyCombo } from "@shared/shortcuts";
import { COMMAND_BY_ID, COMMANDS, comboText } from "../commands";
import { allRows } from "./panelData";

export type Bindings = Record<string, KeyCombo[]>;

// Taken on first use, before any binding is applied (the registry and this module import each other's neighbours).
let defaults: Map<string, KeyCombo[]> | null = null;
const DEFAULTS = () => (defaults ??= new Map<string, KeyCombo[]>(COMMANDS.map((c) => [c.id, c.keys ? [...c.keys] : []])));

/** A command's default (Figma's) keys. */
export const defaultKeys = (id: string): KeyCombo[] => DEFAULTS().get(id) ?? [];

/**
 * Commands that are one action under two names: the toolbar's "Image/video…" and File › Place image… (⇧⌘K both). A
 * key set on one is the other's too.
 */
export const ALIASES: Record<string, string[]> = { "tool.image": ["file.place-image"], "file.place-image": ["tool.image"] };
const withAliases = (id: string) => [id, ...(ALIASES[id] ?? [])];

/** A command's keys in force. */
export const keysOf = (id: string, bindings: Bindings): KeyCombo[] => bindings[id] ?? defaultKeys(id);

/** Has the user changed this command's keys? */
export const isCustom = (id: string, bindings: Bindings) => Object.prototype.hasOwnProperty.call(bindings, id);

/** The registry's keys become the ones in force (the user's, else Figma's). */
export function applyBindings(bindings: Bindings): void {
  for (const c of COMMANDS) {
    const keys = keysOf(c.id, bindings);
    c.keys = keys.length || defaultKeys(c.id).length || isCustom(c.id, bindings) ? [...keys] : undefined;
  }
}

/**
 * Keys a binding can't take: the engine's own on the canvas (Enter, Tab, \, Space, the arrows, the opacity digits)
 * and the app's (tabs, windows, quitting) — the menu bar and the window keep those.
 */
const RESERVED: { combo: KeyCombo; label: string }[] = [
  { combo: { code: "Enter" }, label: "Select children" },
  { combo: { code: "Enter", shift: true }, label: "Select parent" },
  { combo: { code: "Backslash" }, label: "Select parent" },
  { combo: { code: "Tab" }, label: "Select next sibling" },
  { combo: { code: "Tab", shift: true }, label: "Select previous sibling" },
  { combo: { code: "Space" }, label: "Pan" },
  ...["ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight"].flatMap((code) => [
    { combo: { code }, label: "Nudge" },
    { combo: { code, shift: true }, label: "Nudge" },
  ]),
  ...[0, 1, 2, 3, 4, 5, 6, 7, 8, 9].map((d) => ({ combo: { code: `Digit${d}` }, label: "Set opacity" })),
  { combo: { code: "KeyN", mod: true }, label: "New design file" },
  { combo: { code: "KeyW", mod: true }, label: "Close tab" },
  { combo: { code: "KeyW", mod: true, shift: true }, label: "Close window" },
  { combo: { code: "KeyT", mod: true, shift: true }, label: "Reopen closed tab" },
  { combo: { code: "KeyQ", mod: true }, label: IS_MAC ? "Quit" : "Exit" },
  { combo: { code: "KeyH", mod: true }, label: "Hide" },
  { combo: { code: "KeyM", mod: true }, label: "Minimize" },
  { combo: { code: "Comma", mod: true }, label: "Settings" },
  { combo: { code: "Tab", ctrl: true }, label: "Show Next Tab" },
  { combo: { code: "Tab", ctrl: true, shift: true }, label: "Show Previous Tab" },
  ...[1, 2, 3, 4, 5, 6, 7, 8, 9].map((d) => ({ combo: { code: `Digit${d}`, mod: true }, label: d === 1 ? "Home" : d === 9 ? "Last Tab" : `Tab ${d}` })),
];

/** What a command is called in a conflict: its row's wording in the panel, else its own. */
export function commandName(id: string): string {
  for (const r of allRows()) if (r.kind === "keys" && r.parts.length === 1 && r.parts[0].command === id) return r.label;
  return COMMAND_BY_ID.get(id)?.label ?? id;
}

export interface Conflict {
  /** The command that has the key (null: a key the app or the canvas keeps) */
  id: string | null;
  label: string;
}

/** Who has this key already (but `forId` and its aliases): a kept key first, else every command with it. */
export function conflictsOf(combo: KeyCombo, forId: string, bindings: Bindings): Conflict[] {
  const reserved = RESERVED.find((r) => sameCombo(r.combo, combo));
  if (reserved) return [{ id: null, label: reserved.label }];
  const mine = new Set(withAliases(forId));
  const out: Conflict[] = [];
  for (const c of COMMANDS) if (!mine.has(c.id) && keysOf(c.id, bindings).some((k) => sameCombo(k, combo))) out.push({ id: c.id, label: commandName(c.id) });
  // An alias pair is one action: named once.
  return out.filter((c, i) => !out.slice(0, i).some((o) => ALIASES[o.id ?? ""]?.includes(c.id ?? "")));
}

const same = (a: KeyCombo[], b: KeyCombo[]) => a.length === b.length && a.every((k, i) => sameCombo(k, b[i]));

/** Bindings without the entries that are a command's default anyway. */
function normalized(bindings: Bindings): Bindings {
  const out: Bindings = {};
  for (const [id, keys] of Object.entries(bindings)) if (!same(keys, defaultKeys(id))) out[id] = keys;
  return out;
}

/**
 * A command's new key (null: none — Backspace while recording). With `replace`, the commands that had the key lose
 * it (their other keys stay). Throws on a key the app or the canvas keeps.
 */
export function withBinding(bindings: Bindings, id: string, combo: KeyCombo | null, replace = false): Bindings {
  const next: Bindings = { ...bindings };
  if (combo) {
    const conflicts = conflictsOf(combo, id, bindings);
    if (conflicts.some((c) => c.id === null)) throw new Error(`${comboText(combo)} is kept for ${conflicts[0].label}`);
    if (replace) for (const c of conflicts) for (const other of withAliases(c.id!)) next[other] = keysOf(other, bindings).filter((k) => !sameCombo(k, combo));
  }
  for (const target of withAliases(id)) next[target] = combo ? [combo] : [];
  return normalized(next);
}

/** A command back to Figma's keys (and its aliases). */
export function withoutBinding(bindings: Bindings, id: string): Bindings {
  const next: Bindings = { ...bindings };
  for (const target of withAliases(id)) delete next[target];
  return next;
}

/** The key a recorded press makes (the press as the bindings name keys), or null: a modifier alone. */
export function comboOfPress(e: Pick<KeyboardEvent, "code" | "metaKey" | "ctrlKey" | "altKey" | "shiftKey">, code = e.code, mac = IS_MAC): KeyCombo | null {
  if (/^(Meta|Control|Alt|Shift|CapsLock|Fn|OS)(Left|Right)?$/.test(code) || !code) return null;
  const combo: KeyCombo = { code };
  if (mac ? e.metaKey : e.ctrlKey) combo.mod = true;
  if (mac && e.ctrlKey) combo.ctrl = true;
  if (e.altKey) combo.alt = true;
  if (e.shiftKey) combo.shift = true;
  return combo;
}
