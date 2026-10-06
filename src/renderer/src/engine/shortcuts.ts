/**
 * The canvas's keyboard shortcuts that are TS's, not the engine's
 * (docs/engine.md §10.6 "Keyboard routing"): a key goes to the engine first;
 * when it isn't HANDLED, this table runs. Figma's keys. The shell's command
 * registry can replace this table; it is the default for the engine canvas.
 */
import type { CommandName, ToolName } from "./abi";
import type { Engine } from "./Engine";

export interface Shortcut {
  /** KeyboardEvent.code */
  code: string;
  primary?: boolean;
  shift?: boolean;
  alt?: boolean;
  run: (engine: Engine) => void;
}

const tool = (code: string, name: ToolName): Shortcut => ({ code, run: (e) => e.setTool(name) });
const cmd = (code: string, name: CommandName, mods: Partial<Pick<Shortcut, "primary" | "shift" | "alt">> = {}): Shortcut => ({
  code,
  ...mods,
  run: (e) => e.command(name),
});

export const DEFAULT_SHORTCUTS: Shortcut[] = [
  tool("KeyV", "MOVE"),
  tool("KeyF", "FRAME"),
  tool("KeyA", "FRAME"),
  tool("KeyR", "RECTANGLE"),
  tool("KeyO", "ELLIPSE"),
  tool("KeyH", "HAND"),
  tool("KeyT", "TEXT"),
  cmd("KeyZ", "UNDO", { primary: true }),
  cmd("KeyZ", "REDO", { primary: true, shift: true }),
  cmd("KeyY", "REDO", { primary: true }),
  cmd("Backspace", "DELETE"),
  cmd("Delete", "DELETE"),
  cmd("KeyA", "SELECT_ALL", { primary: true }),
  cmd("KeyA", "SELECT_INVERSE", { primary: true, shift: true }),
  cmd("Digit0", "ZOOM_TO_100", { shift: true }),
  cmd("Digit1", "ZOOM_TO_FIT", { shift: true }),
  cmd("Digit2", "ZOOM_TO_SELECTION", { shift: true }),
  cmd("Digit0", "ZOOM_TO_100", { primary: true }),
  cmd("Equal", "ZOOM_IN", { primary: true }),
  cmd("Equal", "ZOOM_IN", { primary: true, shift: true }),
  cmd("Minus", "ZOOM_OUT", { primary: true }),
  cmd("BracketRight", "BRING_FORWARD", { primary: true }),
  cmd("BracketLeft", "SEND_BACKWARD", { primary: true }),
  cmd("BracketRight", "BRING_TO_FRONT", { primary: true, alt: true }),
  cmd("BracketLeft", "SEND_TO_BACK", { primary: true, alt: true }),
  cmd("KeyL", "TOGGLE_LOCK", { primary: true, shift: true }),
  cmd("KeyH", "TOGGLE_VISIBLE", { primary: true, shift: true }),
  cmd("KeyG", "GROUP", { primary: true }),
  cmd("KeyG", "UNGROUP", { primary: true, shift: true }),
  cmd("KeyG", "FRAME_SELECTION", { primary: true, alt: true }),
  cmd("KeyD", "DUPLICATE", { primary: true }),
  cmd("KeyH", "FLIP_HORIZONTAL", { shift: true }),
  cmd("KeyV", "FLIP_VERTICAL", { shift: true }),
  cmd("KeyA", "ALIGN_LEFT", { alt: true }),
  cmd("KeyH", "ALIGN_HORIZONTAL_CENTER", { alt: true }),
  cmd("KeyD", "ALIGN_RIGHT", { alt: true }),
  cmd("KeyW", "ALIGN_TOP", { alt: true }),
  cmd("KeyV", "ALIGN_VERTICAL_CENTER", { alt: true }),
  cmd("KeyS", "ALIGN_BOTTOM", { alt: true }),
  cmd("KeyA", "ADD_AUTO_LAYOUT", { shift: true }),
  cmd("KeyA", "REMOVE_AUTO_LAYOUT", { shift: true, alt: true }),
];

/** Runs the shortcut for this key, if any; true when one ran. */
export function runShortcut(shortcuts: readonly Shortcut[], event: KeyboardEvent, primary: boolean, engine: Engine): boolean {
  const match = shortcuts.find(
    (s) => s.code === event.code && !!s.primary === primary && !!s.shift === event.shiftKey && !!s.alt === event.altKey
  );
  if (!match) return false;
  match.run(engine);
  return true;
}
