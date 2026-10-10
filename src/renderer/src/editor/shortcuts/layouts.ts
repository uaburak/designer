/**
 * Keyboard layouts (the Keyboard shortcuts panel's Layout tab; help.figma.com "Select a keyboard layout": Figma's
 * shortcuts are a U.S. QWERTY keyboard's, a layout makes them match yours). Each layout is the legend of every
 * character key of a keyboard, in the key's place (`KeyboardEvent.code`, a U.S. keyboard's names).
 *
 * The editor's bindings name U.S. keys. With a layout picked, a shortcut is the key that types the same character
 * on that keyboard (⌘Z is the key labelled Z on a German keyboard — the U.S. Y); a character the layout lacks ([ on a
 * German keyboard) stays at its U.S. place (Ü there). A U.S. key whose character the layout lacks and whose place
 * another shortcut took (the German /, the Turkish Q's =, \, ' and /) gets the first key left without a shortcut, in the
 * rows' order — every shortcut stays on a key, and its caps say which. Layouts whose letters aren't Latin (Japanese
 * Kana, Korean) keep the U.S. places: their keys are labelled with the Latin letters too. The legends are the
 * layouts' own (macOS's where they differ); Figma's own per-layout remaps aren't public — this is the rule above, not
 * theirs.
 *
 * The Turkish layouts are an ISO keyboard's (a Turkish MacBook's: the U.S. \ is the key left of a tall Return, and
 * one more key right of the left ⇧), their characters macOS's own (UCKeyTranslate on the "Turkish Q" and "Turkish F"
 * input sources, docs/research/shortcuts-panel/keylayouts.swift → keylayouts-tr.json): a letter's legend is what ⇧
 * types, so the key that types ı is I and the one that types i is İ — and ⌘I is İ's key, as on macOS.
 */
import type { KeyboardLayoutId } from "@shared/shortcuts";

/** A U.S. keyboard's character keys, row by row (the drawing's rows 1–4 between their wide keys). */
export const CHARACTER_ROWS: readonly (readonly string[])[] = [
  ["Backquote", "Digit1", "Digit2", "Digit3", "Digit4", "Digit5", "Digit6", "Digit7", "Digit8", "Digit9", "Digit0", "Minus", "Equal"],
  ["KeyQ", "KeyW", "KeyE", "KeyR", "KeyT", "KeyY", "KeyU", "KeyI", "KeyO", "KeyP", "BracketLeft", "BracketRight", "Backslash"],
  ["KeyA", "KeyS", "KeyD", "KeyF", "KeyG", "KeyH", "KeyJ", "KeyK", "KeyL", "Semicolon", "Quote"],
  ["KeyZ", "KeyX", "KeyC", "KeyV", "KeyB", "KeyN", "KeyM", "Comma", "Period", "Slash"],
];

/**
 * An ISO keyboard's character keys (a MacBook's outside the U.S. and Japan): the U.S. \ (Backslash) is the key left
 * of a tall Return, and one more key is right of the left ⇧ (IntlBackslash). Chromium names the key left of 1
 * Backquote on a Mac's ISO keyboard too.
 */
export const ISO_CHARACTER_ROWS: readonly (readonly string[])[] = [
  CHARACTER_ROWS[0],
  CHARACTER_ROWS[1].slice(0, 12),
  [...CHARACTER_ROWS[2], "Backslash"],
  ["IntlBackslash", ...CHARACTER_ROWS[3]],
];

interface LayoutDef {
  /** The four rows' legends, space-separated, in CHARACTER_ROWS' places (ISO_CHARACTER_ROWS' for an ISO keyboard) */
  rows: [string, string, string, string];
  /** Letters that aren't Latin: shortcuts keep the U.S. places */
  latin?: false;
  /** An ISO keyboard: the rows are ISO_CHARACTER_ROWS' */
  iso?: true;
  /** The language whose case rules make a legend the character its key types (Turkish: I types ı, İ types i) */
  locale?: string;
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
  // macOS "Turkish Q" (com.apple.keylayout.Turkish-QWERTY-PC), a Turkish MacBook's printed keys.
  "tr-q-mac": { rows: ['" 1 2 3 4 5 6 7 8 9 0 * -', "Q W E R T Y U I O P Ğ Ü", "A S D F G H J K L Ş İ ,", "< Z X C V B N M Ö Ç ."], iso: true, locale: "tr" },
  // macOS "Turkish F" (com.apple.keylayout.Turkish-Standard).
  "tr-f": { rows: ["+ 1 2 3 4 5 6 7 8 9 0 / -", "F G Ğ I O D R N H P Q W", "U İ E A Ü T K M L Y Ş X", "< J Ö V C Ç Z S B . ,"], iso: true, locale: "tr" },
};

const defOf = (layout: KeyboardLayoutId): LayoutDef => LAYOUTS[layout] ?? LAYOUTS.generic;

/** Is the layout's keyboard an ISO one (drawn with a tall Return and a key right of the left ⇧)? */
export const isIso = (layout: KeyboardLayoutId): boolean => defOf(layout).iso === true;

/** code → legend, for a layout. */
export function legends(layout: KeyboardLayoutId): Map<string, string> {
  const def = defOf(layout);
  const out = new Map<string, string>();
  (def.iso ? ISO_CHARACTER_ROWS : CHARACTER_ROWS).forEach((codes, r) => {
    const keys = def.rows[r].split(" ");
    codes.forEach((code, i) => out.set(code, keys[i] ?? ""));
  });
  return out;
}

/** code → the character the key types: its legend in the layout's lower case (Turkish I → ı, İ → i). */
export function characters(layout: KeyboardLayoutId): Map<string, string> {
  const def = defOf(layout);
  const out = new Map<string, string>();
  for (const [code, legend] of legends(layout)) out.set(code, def.locale ? legend.toLocaleLowerCase(def.locale) : legend.toLowerCase());
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
  const latin = defOf(layout).latin !== false;
  const toUs = new Map<string, string | null>();
  const toPhys = new Map<string, string>();
  if (latin) {
    const usByChar = new Map<string, string>();
    for (const [code, ch] of US_LEGENDS) usByChar.set(ch.toLowerCase(), code);
    const typed = characters(layout);
    const ownChars = new Set(typed.values());
    const free: string[] = [];
    for (const [code, ch] of typed) {
      const usHere = US_LEGENDS.get(code)?.toLowerCase();
      // The key types a U.S. character: it is that key's shortcut. Otherwise it keeps its own place's, unless that
      // character is elsewhere on this keyboard (then the shortcut went there) or it has no U.S. place (ISO's
      // extra key).
      const target = usByChar.get(ch) ?? (usHere !== undefined && !ownChars.has(usHere) ? code : null);
      if (target) {
        toUs.set(code, target);
        toPhys.set(target, code);
      } else free.push(code);
    }
    // U.S. keys left without a key take the keys left without a shortcut, in the rows' order (ISO's extra key last;
    // left over, it is itself).
    free.sort((a, b) => Number(a === "IntlBackslash") - Number(b === "IntlBackslash"));
    const unplaced = [...US_LEGENDS.keys()].filter((code) => !toPhys.has(code));
    for (const code of free) {
      const us = unplaced.shift();
      if (us) {
        toUs.set(code, us);
        toPhys.set(us, code);
      } else if (code !== "IntlBackslash") toUs.set(code, null);
    }
  }
  const map: LayoutMap = {
    toBinding: (code) => (toUs.has(code) ? toUs.get(code)! : code),
    toPhysical: (code) => toPhys.get(code) ?? code,
    label: (code) => {
      if (!US_LEGENDS.has(code) && !own.has(code)) return null;
      return latin ? (own.get(toPhys.get(code) ?? code) ?? null) : (US_LEGENDS.get(code) ?? null);
    },
  };
  cache.set(layout, map);
  return map;
}

/**
 * The layout a keyboard map has (`navigator.keyboard.getLayoutMap()`: code → the character the key types) — the
 * system's own, preselected while the user hasn't picked one — or null: none is close enough, or it is a U.S.
 * keyboard (Generic stays). The key left of 1 and the ISO one right of ⇧ aren't compared: Electron's map swaps them on
 * a Mac's ISO keyboard (Backquote "<", IntlBackslash '"' on a Turkish MacBook, 2026-10-10). Two other keys may differ
 * (dead keys).
 */
export function detectLayout(map: ReadonlyMap<string, string>): KeyboardLayoutId | null {
  let best: { id: KeyboardLayoutId; misses: number } | null = null;
  for (const id of Object.keys(LAYOUTS) as KeyboardLayoutId[]) {
    // Generic stands for U.S. QWERTY and Chinese (the same keys); Korean and Japanese type Latin letters too.
    if (defOf(id).latin === false || id === "us" || id === "zh") continue;
    const locale = defOf(id).locale;
    let misses = 0;
    for (const [code, ch] of characters(id)) {
      if (code === "Backquote" || code === "IntlBackslash") continue;
      const got = map.get(code);
      if (got === undefined || (locale ? got.toLocaleLowerCase(locale) : got.toLowerCase()) !== ch) misses++;
    }
    if (!best || misses < best.misses) best = { id, misses };
  }
  if (!best || best.misses > 2 || best.id === "generic") return null;
  return best.id;
}

/** One key of the drawn keyboard: its legend (or glyph) and its width in CSS px. */
export interface DrawnKey {
  code: string;
  legend: string;
  width: number;
  /**
   * An ISO keyboard's tall Return: "top" is the key (its upper part `width` wide, its lower part `lower` wide, the
   * right edges aligned), "below" its lower part's room in the next row.
   */
  tall?: { part: "top"; lower: number } | { part: "below" };
}

/**
 * The Layout tab's keyboard (live: 26 × 25 keys 32 apart; ⌫ and ⇥ 55, ⇪ 67, ↩ 45, ⇧ 80 and 63, the space bar 308),
 * the picked layout's legends on its character keys. An ISO keyboard keeps the rows' width (471): ⇥ 42, the tall ↩
 * 39 over 31, ⇪ 50, the left ⇧ 50 and the key beside it.
 */
export function drawnKeyboard(layout: KeyboardLayoutId): DrawnKey[][] {
  const own = legends(layout);
  const key = (code: string): DrawnKey => ({ code, legend: own.get(code) ?? "", width: 26 });
  const wide = (code: string, legend: string, width: number): DrawnKey => ({ code, legend, width });
  const bottom = [wide("ControlLeft", "⌃", 26), wide("AltLeft", "⌥", 26), wide("MetaLeft", "⌘", 26), wide("Space", "", 308), wide("MetaRight", "⌘", 26), wide("AltRight", "⌥", 26)];
  if (isIso(layout))
    return [
      [...ISO_CHARACTER_ROWS[0].map(key), wide("Backspace", "⌫", 55)],
      [wide("Tab", "⇥", 42), ...ISO_CHARACTER_ROWS[1].map(key), { code: "Enter", legend: "↩", width: 39, tall: { part: "top", lower: 31 } }],
      [wide("CapsLock", "⇪", 50), ...ISO_CHARACTER_ROWS[2].map(key), { code: "EnterLower", legend: "", width: 31, tall: { part: "below" } }],
      [wide("ShiftLeft", "⇧", 50), ...ISO_CHARACTER_ROWS[3].map(key), wide("ShiftRight", "⇧", 63)],
      bottom,
    ];
  return [
    [...CHARACTER_ROWS[0].map(key), wide("Backspace", "⌫", 55)],
    [wide("Tab", "⇥", 55), ...CHARACTER_ROWS[1].map(key)],
    [wide("CapsLock", "⇪", 67), ...CHARACTER_ROWS[2].map(key), wide("Enter", "↩", 45)],
    [wide("ShiftLeft", "⇧", 80), ...CHARACTER_ROWS[3].map(key), wide("ShiftRight", "⇧", 63)],
    bottom,
  ];
}
