/**
 * Keyboard layouts (the Keyboard shortcuts panel's Layout tab; help.figma.com "Select a keyboard layout": Figma's
 * shortcuts are a U.S. QWERTY keyboard's, a layout makes them match yours). Each layout is the legend of every
 * character key of a keyboard, in the key's place (`KeyboardEvent.code`, a U.S. keyboard's names).
 *
 * The editor's bindings name U.S. keys. With a layout picked, a shortcut is the key that types the same character
 * on that keyboard (⌘Z is the key labelled Z on a German keyboard — the U.S. Y); a character the layout lacks ([ on a
 * German keyboard) stays at its U.S. place (Ü there). Layouts whose letters aren't Latin (Japanese Kana, Korean)
 * keep the U.S. places: their keys are labelled with the Latin letters too. The legends are the layouts' own
 * (macOS's where they differ); Figma's own per-layout remaps aren't public — this is the rule above, not theirs.
 */
import type { KeyboardLayoutId } from "@shared/shortcuts";

/** A U.S. keyboard's character keys, row by row (the drawing's rows 1–4 between their wide keys). */
export const CHARACTER_ROWS: readonly (readonly string[])[] = [
  ["Backquote", "Digit1", "Digit2", "Digit3", "Digit4", "Digit5", "Digit6", "Digit7", "Digit8", "Digit9", "Digit0", "Minus", "Equal"],
  ["KeyQ", "KeyW", "KeyE", "KeyR", "KeyT", "KeyY", "KeyU", "KeyI", "KeyO", "KeyP", "BracketLeft", "BracketRight", "Backslash"],
  ["KeyA", "KeyS", "KeyD", "KeyF", "KeyG", "KeyH", "KeyJ", "KeyK", "KeyL", "Semicolon", "Quote"],
  ["KeyZ", "KeyX", "KeyC", "KeyV", "KeyB", "KeyN", "KeyM", "Comma", "Period", "Slash"],
];

interface LayoutDef {
  /** The four rows' legends, space-separated, in CHARACTER_ROWS' places */
  rows: [string, string, string, string];
  /** Letters that aren't Latin: shortcuts keep the U.S. places */
  latin?: false;
}

const US: LayoutDef["rows"] = ["` 1 2 3 4 5 6 7 8 9 0 - =", "Q W E R T Y U I O P [ ] \\", "A S D F G H J K L ; '", "Z X C V B N M , . /"];
const NORDIC_LETTERS = "Z X C V B N M , . -";

const LAYOUTS: Record<KeyboardLayoutId, LayoutDef> = {
  generic: { rows: US },
  us: { rows: US },
  zh: { rows: US },
  dvorak: { rows: ["` 1 2 3 4 5 6 7 8 9 0 [ ]", "' , . P Y F G C R L / = \\", "A O E U I D H T N S -", "; Q J K X B M W V Z"] },
  "en-gb-mac": { rows: ["§ 1 2 3 4 5 6 7 8 9 0 - =", "Q W E R T Y U I O P [ ] \\", "A S D F G H J K L ; '", "Z X C V B N M , . /"] },
  "en-gb-pc": { rows: ["` 1 2 3 4 5 6 7 8 9 0 - =", "Q W E R T Y U I O P [ ] #", "A S D F G H J K L ; '", "Z X C V B N M , . /"] },
  de: { rows: ["^ 1 2 3 4 5 6 7 8 9 0 ß ´", "Q W E R T Z U I O P Ü + #", "A S D F G H J K L Ö Ä", "Y X C V B N M , . -"] },
  fr: { rows: ["@ & é \" ' ( § è ! ç à ) -", "A Z E R T Y U I O P ^ $ `", "Q S D F G H J K L M ù", "W X C V B N , ; : ="] },
  it: { rows: ["\\ 1 2 3 4 5 6 7 8 9 0 ' ì", "Q W E R T Y U I O P è + ù", "A S D F G H J K L ò à", NORDIC_LETTERS] },
  es: { rows: ["º 1 2 3 4 5 6 7 8 9 0 ' ¡", "Q W E R T Y U I O P ` + ç", "A S D F G H J K L Ñ ´", NORDIC_LETTERS] },
  "es-419": { rows: ["| 1 2 3 4 5 6 7 8 9 0 ' ¿", "Q W E R T Y U I O P ´ + }", "A S D F G H J K L Ñ {", NORDIC_LETTERS] },
  pt: { rows: ["\\ 1 2 3 4 5 6 7 8 9 0 ' «", "Q W E R T Y U I O P + ´ ~", "A S D F G H J K L Ç º", NORDIC_LETTERS] },
  sv: { rows: ["§ 1 2 3 4 5 6 7 8 9 0 + ´", "Q W E R T Y U I O P Å ¨ '", "A S D F G H J K L Ö Ä", NORDIC_LETTERS] },
  fi: { rows: ["§ 1 2 3 4 5 6 7 8 9 0 + ´", "Q W E R T Y U I O P Å ¨ '", "A S D F G H J K L Ö Ä", NORDIC_LETTERS] },
  no: { rows: ["| 1 2 3 4 5 6 7 8 9 0 + \\", "Q W E R T Y U I O P Å ¨ '", "A S D F G H J K L Ø Æ", NORDIC_LETTERS] },
  da: { rows: ["½ 1 2 3 4 5 6 7 8 9 0 + ´", "Q W E R T Y U I O P Å ¨ '", "A S D F G H J K L Æ Ø", NORDIC_LETTERS] },
  ko: { rows: ["` 1 2 3 4 5 6 7 8 9 0 - =", "ㅂ ㅈ ㄷ ㄱ ㅅ ㅛ ㅕ ㅑ ㅐ ㅔ [ ] \\", "ㅁ ㄴ ㅇ ㄹ ㅎ ㅗ ㅓ ㅏ ㅣ ; '", "ㅋ ㅌ ㅊ ㅍ ㅠ ㅜ ㅡ , . /"], latin: false },
  ja: { rows: ["ー ぬ ふ あ う え お や ゆ よ わ ほ へ", "た て い す か ん な に ら せ ゛ ゜ む", "ち と し は き く ま の り れ け", "つ さ そ ひ こ み も ね る め"], latin: false },
};

/** code → legend, for a layout. */
export function legends(layout: KeyboardLayoutId): Map<string, string> {
  const def = LAYOUTS[layout] ?? LAYOUTS.generic;
  const out = new Map<string, string>();
  CHARACTER_ROWS.forEach((codes, r) => {
    const keys = def.rows[r].split(" ");
    codes.forEach((code, i) => out.set(code, keys[i] ?? ""));
  });
  return out;
}

const US_LEGENDS = legends("us");

export interface LayoutMap {
  /** A pressed key (its code) → the U.S. key a binding names, or null: no shortcut is on it */
  toBinding(code: string): string | null;
  /** A binding's U.S. key → the key to press on this layout */
  toPhysical(code: string): string;
  /** What the key a binding names is labelled on this layout (its legend), or null: not a character key */
  label(code: string): string | null;
}

const cache = new Map<KeyboardLayoutId, LayoutMap>();

/** The layout's shortcut keys (identity for Generic, U.S. QWERTY and the non-Latin layouts). */
export function layoutMap(layout: KeyboardLayoutId): LayoutMap {
  const hit = cache.get(layout);
  if (hit) return hit;
  const own = legends(layout);
  const latin = (LAYOUTS[layout] ?? LAYOUTS.generic).latin !== false;
  const toUs = new Map<string, string | null>();
  const toPhys = new Map<string, string>();
  if (latin) {
    const usByChar = new Map<string, string>();
    for (const [code, ch] of US_LEGENDS) usByChar.set(ch.toLowerCase(), code);
    const ownChars = new Set([...own.values()].map((c) => c.toLowerCase()));
    for (const [code, ch] of own) {
      const us = usByChar.get(ch.toLowerCase());
      // The key types a U.S. character: it is that key's shortcut. Otherwise it keeps its own place's, unless that
      // character is elsewhere on this keyboard (then the shortcut went there).
      const target = us ?? (ownChars.has(US_LEGENDS.get(code)!.toLowerCase()) ? null : code);
      toUs.set(code, target);
      if (target) toPhys.set(target, code);
    }
  }
  const map: LayoutMap = {
    toBinding: (code) => (toUs.has(code) ? toUs.get(code)! : code),
    toPhysical: (code) => toPhys.get(code) ?? code,
    label: (code) => {
      if (!US_LEGENDS.has(code)) return null;
      return latin ? (own.get(toPhys.get(code) ?? code) ?? null) : (US_LEGENDS.get(code) ?? null);
    },
  };
  cache.set(layout, map);
  return map;
}

/** One key of the drawn keyboard: its legend (or glyph) and its width in CSS px. */
export interface DrawnKey {
  code: string;
  legend: string;
  width: number;
}

/**
 * The Layout tab's keyboard (live: 26 × 25 keys 32 apart; ⌫ and ⇥ 55, ⇪ 67, ↩ 45, ⇧ 80 and 63, the space bar 308),
 * the picked layout's legends on its character keys.
 */
export function drawnKeyboard(layout: KeyboardLayoutId): DrawnKey[][] {
  const own = legends(layout);
  const key = (code: string): DrawnKey => ({ code, legend: own.get(code) ?? "", width: 26 });
  const wide = (code: string, legend: string, width: number): DrawnKey => ({ code, legend, width });
  return [
    [...CHARACTER_ROWS[0].map(key), wide("Backspace", "⌫", 55)],
    [wide("Tab", "⇥", 55), ...CHARACTER_ROWS[1].map(key)],
    [wide("CapsLock", "⇪", 67), ...CHARACTER_ROWS[2].map(key), wide("Enter", "↩", 45)],
    [wide("ShiftLeft", "⇧", 80), ...CHARACTER_ROWS[3].map(key), wide("ShiftRight", "⇧", 63)],
    [wide("ControlLeft", "⌃", 26), wide("AltLeft", "⌥", 26), wide("MetaLeft", "⌘", 26), wide("Space", "", 308), wide("MetaRight", "⌘", 26), wide("AltRight", "⌥", 26)],
  ];
}
