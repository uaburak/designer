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
 * A click on one of the widget's lines: that side alone; with ⇧ the opposite
 * edge joins (Left and right) or, when both are on, the clicked one leaves.
 */
export function clickConstraint(current: ConstraintType, side: ConstraintSide, shift: boolean): ConstraintType {
  const c = normalizeConstraint(current);
  if (side === "center") return "CENTER";
  if (shift) {
    if (c === "STRETCH") return side === "min" ? "MAX" : "MIN";
    if ((c === "MIN" && side === "max") || (c === "MAX" && side === "min")) return "STRETCH";
  }
  return side === "min" ? "MIN" : "MAX";
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
