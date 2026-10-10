/**
 * The user's keyboard shortcuts (the Keyboard shortcuts panel, src/renderer/src/editor/shortcuts): the bindings they
 * changed (the owner's addition — Figma's own panel only shows them), the shortcuts they have used (Figma lights
 * those up in the panel) and the keyboard layout picked in its Layout tab. Main keeps them in settings.json (one set
 * per user, every window and tab), rebuilds the menu bar's accelerators from the bindings and tells every editor
 * (`shortcuts:changed`); a browser keeps them in localStorage. Pure data and checks, shared by main and the editor.
 */

/** One key press: `KeyboardEvent.code` (the key's place on a U.S. keyboard) and its modifiers. */
export interface KeyCombo {
  code: string;
  /** ⌘ on a Mac, Ctrl elsewhere */
  mod?: boolean;
  shift?: boolean;
  alt?: boolean;
  /** ⌃ (a Mac's Control) */
  ctrl?: boolean;
}

/** Figma's keyboard layouts (the Layout tab's "Keyboard layout:" list, its order; Generic is the default). */
export const KEYBOARD_LAYOUTS = [
  { id: "generic", label: "Generic" },
  { id: "zh", label: "Chinese" },
  { id: "da", label: "Danish" },
  { id: "fi", label: "Finnish" },
  { id: "fr", label: "French AZERTY" },
  { id: "de", label: "German QWERTZ" },
  { id: "it", label: "Italian" },
  { id: "ja", label: "Japanese (Kana)" },
  { id: "ko", label: "Korean" },
  { id: "no", label: "Norwegian" },
  { id: "pt", label: "Portuguese" },
  { id: "es", label: "Spanish" },
  { id: "es-419", label: "Spanish (Latin America)" },
  { id: "sv", label: "Swedish" },
  // Ours: a Turkish MacBook's (macOS "Turkish Q") and Turkish F.
  { id: "tr-f", label: "Turkish F" },
  { id: "tr-q-mac", label: "Turkish Q (Mac)" },
  { id: "en-gb-mac", label: "U.K. (Mac)" },
  { id: "en-gb-pc", label: "U.K. (PC)" },
  { id: "dvorak", label: "U.S. Dvorak" },
  { id: "us", label: "U.S. QWERTY" },
] as const;

export type KeyboardLayoutId = (typeof KEYBOARD_LAYOUTS)[number]["id"];

export interface ShortcutSettings {
  /** The commands whose keys the user changed: command id → its keys (empty: none) */
  bindings: Record<string, KeyCombo[]>;
  /** The shortcuts used at least once (the panel's row ids), lit in the panel */
  used: string[];
  layout: KeyboardLayoutId;
  /**
   * The user picked `layout` in the Layout tab. Until they do, the editor follows the system's layout when it is one
   * of these (detected, never written) and `layout` is Generic.
   */
  layoutPicked: boolean;
}

export const DEFAULT_SHORTCUT_SETTINGS: ShortcutSettings = { bindings: {}, used: [], layout: "generic", layoutPicked: false };

const CODE = /^(Key[A-Z]|Digit\d|Numpad\w{1,10}|F\d{1,2}|Arrow(Up|Down|Left|Right)|Backquote|Minus|Equal|BracketLeft|BracketRight|Backslash|Semicolon|Quote|Comma|Period|Slash|Backspace|Delete|Enter|Escape|Tab|Space|PageUp|PageDown|Home|End|IntlBackslash)$/;

export const isKeyboardLayout = (v: unknown): v is KeyboardLayoutId => KEYBOARD_LAYOUTS.some((l) => l.id === v);

/** A combo as plain data (only the fields and codes the contract names), or null. */
export function plainCombo(v: unknown): KeyCombo | null {
  if (!v || typeof v !== "object") return null;
  const c = v as Record<string, unknown>;
  if (typeof c.code !== "string" || !CODE.test(c.code)) return null;
  const out: KeyCombo = { code: c.code };
  for (const m of ["mod", "shift", "alt", "ctrl"] as const) if (c[m] === true) out[m] = true;
  return out;
}

/** Settings read from disk or sent by a view, checked: anything else is dropped, a broken value reads as the default. */
export function sanitizeShortcutSettings(v: unknown): ShortcutSettings {
  const raw = v && typeof v === "object" ? (v as Record<string, unknown>) : {};
  const bindings: Record<string, KeyCombo[]> = {};
  if (raw.bindings && typeof raw.bindings === "object")
    for (const [id, list] of Object.entries(raw.bindings as Record<string, unknown>).slice(0, 1000)) {
      if (id.length > 100 || !Array.isArray(list)) continue;
      bindings[id] = list.slice(0, 8).map(plainCombo).filter((c): c is KeyCombo => c !== null);
    }
  const used = Array.isArray(raw.used) ? [...new Set(raw.used.filter((u): u is string => typeof u === "string" && u.length <= 100))].slice(0, 2000) : [];
  const layout = isKeyboardLayout(raw.layout) ? raw.layout : "generic";
  // A layout other than Generic kept before `layoutPicked` existed was picked.
  return { bindings, used, layout, layoutPicked: raw.layoutPicked === true || layout !== "generic" };
}

export const sameCombo = (a: KeyCombo, b: KeyCombo) => a.code === b.code && !!a.mod === !!b.mod && !!a.shift === !!b.shift && !!a.alt === !!b.alt && !!a.ctrl === !!b.ctrl;

const ACCELERATOR_KEY: Record<string, string> = {
  Backquote: "`",
  Minus: "-",
  Equal: "=",
  BracketLeft: "[",
  BracketRight: "]",
  Backslash: "\\",
  Semicolon: ";",
  Quote: "'",
  Comma: ",",
  Period: ".",
  Slash: "/",
  ArrowUp: "Up",
  ArrowDown: "Down",
  ArrowLeft: "Left",
  ArrowRight: "Right",
  NumpadAdd: "numadd",
  NumpadSubtract: "numsub",
  NumpadMultiply: "nummult",
  NumpadDivide: "numdiv",
  NumpadDecimal: "numdec",
  NumpadEnter: "Enter",
  IntlBackslash: "§",
};

/** The menu bar's accelerator for a combo (Electron's syntax: "Alt+CmdOrCtrl+G"), as the registry writes them. */
export function comboToAccelerator(c: KeyCombo): string | undefined {
  let key = ACCELERATOR_KEY[c.code];
  if (!key) {
    if (/^Key[A-Z]$/.test(c.code)) key = c.code.slice(3);
    else if (/^Digit\d$/.test(c.code)) key = c.code.slice(5);
    else if (/^Numpad\d$/.test(c.code)) key = `num${c.code.slice(6)}`;
    else if (CODE.test(c.code)) key = c.code;
    else return undefined;
  }
  return [c.ctrl && "Ctrl", c.alt && "Alt", c.shift && "Shift", c.mod && "CmdOrCtrl", key].filter(Boolean).join("+");
}

/**
 * The menu bar's accelerator for a command: the user's binding (its first key; none when they cleared it), else the
 * registry's.
 */
export function acceleratorFor(id: string, registry: string | undefined, bindings: Record<string, KeyCombo[]> | undefined): string | undefined {
  const custom = bindings?.[id];
  if (!custom) return registry;
  return custom.length ? comboToAccelerator(custom[0]) : undefined;
}
