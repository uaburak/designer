/**
 * KeyboardEvent.code as the engine's keyCode (docs/engine.md §10.3): the index
 * in this list. It mirrors ENG_KEY_CODES in engine/src/editor/Keys.h — same
 * names, same order, append only (a test checks the two agree).
 */
export const KEY_CODES = [
  "Unidentified",
  "KeyA", "KeyB", "KeyC", "KeyD", "KeyE", "KeyF", "KeyG", "KeyH", "KeyI", "KeyJ", "KeyK", "KeyL", "KeyM",
  "KeyN", "KeyO", "KeyP", "KeyQ", "KeyR", "KeyS", "KeyT", "KeyU", "KeyV", "KeyW", "KeyX", "KeyY", "KeyZ",
  "Digit0", "Digit1", "Digit2", "Digit3", "Digit4", "Digit5", "Digit6", "Digit7", "Digit8", "Digit9",
  "Space", "Escape", "Enter", "NumpadEnter", "Tab", "Backspace", "Delete",
  "ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown",
  "ShiftLeft", "ShiftRight", "AltLeft", "AltRight", "ControlLeft", "ControlRight", "MetaLeft", "MetaRight",
  "Equal", "Minus", "NumpadAdd", "NumpadSubtract", "Numpad0", "Backslash", "BracketLeft", "BracketRight",
  "Comma", "Period", "Slash", "Semicolon", "Quote", "Backquote", "Home", "End", "PageUp", "PageDown",
] as const;

export type KeyCodeName = (typeof KEY_CODES)[number];

const index = new Map<string, number>(KEY_CODES.map((name, i) => [name, i]));

/** The engine's number for a KeyboardEvent.code (0, Unidentified, for the rest). */
export function keyCodeOf(code: string): number {
  return index.get(code) ?? 0;
}
