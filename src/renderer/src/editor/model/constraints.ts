/**
 * Figma's constraints (help.figma.com "Apply constraints to define how layers
 * resize"; the help calls Stretch "Left and right", the live dropdowns show "Left + Right" / "Top + Bottom" —
 * popovers/constraint-*-menu.txt):
 * the Position section's widget and its two dropdowns, as plain data on
 * `horizontalConstraint` / `verticalConstraint` (schema/document.kiwi's
 * ConstraintType: MIN, CENTER, MAX, STRETCH, SCALE).
 *
 * Shown for a layer whose nearest frame (groups pass through) is not the page,
 * unless an auto-layout parent places it (an "Ignore auto layout" child has them).
 */
import type { ConstraintType } from "@/engine/codec";

export type ConstraintAxis = "horizontal" | "vertical";
export type ConstraintSide = "min" | "center" | "max";

export const CONSTRAINT_OPTIONS: Record<ConstraintAxis, { value: ConstraintType; label: string }[]> = {
  horizontal: [
    { value: "MIN", label: "Left" },
    { value: "MAX", label: "Right" },
    { value: "STRETCH", label: "Left + Right" },
    { value: "CENTER", label: "Center" },
    { value: "SCALE", label: "Scale" },
  ],
  vertical: [
    { value: "MIN", label: "Top" },
    { value: "MAX", label: "Bottom" },
    { value: "STRETCH", label: "Top + Bottom" },
    { value: "CENTER", label: "Center" },
    { value: "SCALE", label: "Scale" },
  ],
};

/** The glyph a constraint dropdown shows before its value (live: an icon, the text at 33 in; the glyphs unverified). */
export const CONSTRAINT_ICONS = {
  horizontal: { MIN: "24.constraint.left", MAX: "24.constraint.right", STRETCH: "24.constraint.left-right", CENTER: "24.constraint.center-horizontal", SCALE: "24.constraint.scale-horizontal" },
  vertical: { MIN: "24.constraint.top", MAX: "24.constraint.bottom", STRETCH: "24.constraint.top-bottom", CENTER: "24.constraint.center-vertical", SCALE: "24.constraint.scale-vertical" },
} as const satisfies Record<ConstraintAxis, Record<string, string>>;

/** Figma's files also hold FIXED_MIN / FIXED_MAX (older names): they read as Left / Right. */
export function normalizeConstraint(c: string | undefined): ConstraintType {
  if (c === "FIXED_MIN" || c === undefined) return "MIN";
  if (c === "FIXED_MAX") return "MAX";
  return c as ConstraintType;
}

/** The widget's lines that show selected for a constraint (Scale: none). */
export function selectedSides(c: ConstraintType): ConstraintSide[] {
  switch (normalizeConstraint(c)) {
    case "MIN":
      return ["min"];
    case "MAX":
      return ["max"];
    case "STRETCH":
      return ["min", "max"];
    case "CENTER":
      return ["center"];
    default:
      return [];
  }
}

/**
 * A click on one of the widget's lines (Figma's constraint selector, Atlas 09 §7): that side alone. With ⇧ or ⌘ it
 * toggles: the side already on → Scale; the opposite side on → both (Left and right); both on → the opposite side
 * alone (the clicked one leaves); else that side. The centre line: Center, a second click Scale.
 */
export function clickConstraint(current: ConstraintType, side: ConstraintSide, toggle: boolean): ConstraintType {
  const c = normalizeConstraint(current);
  if (side === "center") return c === "CENTER" ? "SCALE" : "CENTER";
  const own = side === "min" ? "MIN" : "MAX";
  const opposite = side === "min" ? "MAX" : "MIN";
  if (toggle) {
    if (c === own) return "SCALE";
    if (c === opposite) return "STRETCH";
    if (c === "STRETCH") return opposite;
  }
  return own;
}

/** The fewest facts that decide whether a layer has constraints. */
export interface ConstraintHost {
  type: string;
  group: boolean;
  stackMode?: string;
}

/**
 * Does the layer get the Constraints row? `chain` is its ancestors, nearest
 * first, up to and including the page. Groups pass through to the frame above.
 */
export function hasConstraints(chain: readonly ConstraintHost[], absolute: boolean): boolean {
  const parent = chain[0];
  if (!parent || parent.type === "CANVAS") return false;
  if (!parent.group && parent.stackMode && parent.stackMode !== "NONE" && !absolute) return false;
  const frame = chain.find((a) => !a.group);
  return !!frame && frame.type !== "CANVAS" && frame.type !== "DOCUMENT";
}
