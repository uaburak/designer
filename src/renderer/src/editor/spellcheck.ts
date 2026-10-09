/**
 * Text › Spell check (round 10; live lists "Spell check ▸", its items aren't captured — help.figma.com "Check spelling
 * in Figma": misspelled words underlined in red while a text is edited; unverified look). The desktop app's spell
 * checker (Electron's, with the system's dictionaries: the preload's `spelling.misspelled`) reads the edited text's
 * words a moment after it changes; the engine underlines them (SET_SPELLING_MARKS). On by default, kept per machine;
 * the web build has no spell checker (the command is disabled there).
 */
import type { Guid } from "@/engine/codec";
import type { EditorController } from "./controller";

const KEY = "designer.spellcheck";
const DELAY = 250;

type SpellingBridge = { designer?: { spelling?: { misspelled?: (words: string[]) => boolean[] } } };

/** The desktop app's spell checker, or null (the web build, an old preload). */
export function spellChecker(): ((words: string[]) => boolean[]) | null {
  const f = (globalThis as unknown as SpellingBridge).designer?.spelling?.misspelled;
  return typeof f === "function" ? f : null;
}

export function spellCheckOn(): boolean {
  try {
    return localStorage.getItem(KEY) !== "off";
  } catch {
    return true;
  }
}

/** Spell check on / off (this machine); the edited text is checked again (or its marks cleared) at once. */
export function setSpellCheck(ed: EditorController, on: boolean): void {
  try {
    localStorage.setItem(KEY, on ? "on" : "off");
  } catch {
    // Private mode: this session only.
  }
  checkers.get(ed)?.();
}

/** A text's words: letters (and the marks, apostrophes and hyphens inside a word), as UTF-16 ranges. */
export function wordsOf(text: string): { from: number; to: number; word: string }[] {
  const out: { from: number; to: number; word: string }[] = [];
  for (const m of text.matchAll(/\p{L}[\p{L}\p{M}]*(?:['’-]\p{L}[\p{L}\p{M}]*)*/gu)) {
    const from = m.index ?? 0;
    out.push({ from, to: from + m[0].length, word: m[0] });
  }
  return out;
}

/** The misspelled ranges of `text` by `misspelled` (words of one letter and with digits aren't asked). */
export function misspelledRanges(text: string, misspelled: (words: string[]) => boolean[]): [number, number][] {
  const words = wordsOf(text).filter((w) => w.word.length > 1);
  if (!words.length) return [];
  const flags = misspelled(words.map((w) => w.word));
  return words.filter((_, i) => flags[i] === true).map((w) => [w.from, w.to]);
}

const checkers = new WeakMap<EditorController, () => void>();

/** Checks the edited text after each change (and when an edit starts); marks go with the edit. */
export function attachSpellcheck(ed: EditorController): () => void {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const run = () => {
    timer = undefined;
    const ref: Guid | undefined = ed.engine.destroyed ? undefined : ed.engine.textEdit?.ref ?? undefined;
    if (!ref) return;
    const check = spellChecker();
    const characters = (ed.engine.readNode(ref, { fields: ["textData"] }) as { textData?: { characters?: string } } | null)?.textData?.characters ?? "";
    const ranges = check && spellCheckOn() ? misspelledRanges(characters, check) : [];
    ed.engine.command("SET_SPELLING_MARKS", { ranges });
  };
  const schedule = () => {
    if (timer !== undefined) clearTimeout(timer);
    timer = setTimeout(run, DELAY);
  };
  checkers.set(ed, schedule);
  const offs = [
    ed.engine.on("TEXT_EDIT", (e) => {
      if (e.active) schedule();
    }),
    ed.engine.onDocumentChanged(() => {
      if (ed.engine.textEdit?.ref) schedule();
    }),
  ];
  return () => {
    if (timer !== undefined) clearTimeout(timer);
    checkers.delete(ed);
    offs.forEach((off) => off());
  };
}
