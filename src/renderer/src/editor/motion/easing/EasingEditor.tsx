/**
 * The Easing menu and editors of Motion mode (docs/motion.md §6.3): the Easing dropdown (Hold first, then Figma's
 * curves and springs), the Bezier | Spring switch, Custom bezier (a 200 × 200 curve editor) and Custom spring (the
 * response curve and the Bounce field), the EASING variable binding. One editor for prototypes and Motion.
 *
 * Round 8's pre-commit: the stubs 8c and 8d build against (`EasingEditorProps` is fixed in src/shared/motion/types.ts);
 * 8d fills them. They render nothing until then.
 */
import type { EasingEditorProps } from "@shared/motion/types";

export function EasingEditor(_props: EasingEditorProps): null {
  return null;
}

/** The dropdown alone (a segment's or clip's easing name), opening the editor for the custom types. */
export function EasingMenu(_props: EasingEditorProps): null {
  return null;
}
