/**
 * The Position section's Constraints row (Figma UI3): the widget — a box with
 * an inner square, a line from each edge and a cross in the middle; click a
 * line to pin that side, ⇧-click for both — and the horizontal / vertical
 * dropdowns, writing `horizontalConstraint` / `verticalConstraint`.
 */
import { MIXED, PropertyRow, Select, isMixed, type Mixed } from "@/ds";
import type { ConstraintType } from "@/engine/codec";
import { useEditor } from "../../controller";
import { mixed } from "../../model/mixed";
import { CONSTRAINT_OPTIONS, clickConstraint, normalizeConstraint, selectedSides, type ConstraintAxis, type ConstraintSide } from "../../model/constraints";
import type { PanelNode } from "./shared";
import styles from "./Design.module.css";

const FIELD: Record<ConstraintAxis, "horizontalConstraint" | "verticalConstraint"> = { horizontal: "horizontalConstraint", vertical: "verticalConstraint" };

export function ConstraintsRow({ nodes }: { nodes: PanelNode[] }) {
  const ed = useEditor();
  const refs = nodes.map((n) => n.guid);
  const h = mixed(nodes.map((n) => normalizeConstraint(n.horizontalConstraint)));
  const v = mixed(nodes.map((n) => normalizeConstraint(n.verticalConstraint)));
  const set = (axis: ConstraintAxis, c: ConstraintType) => ed.setProps(refs, { [FIELD[axis]]: c }, "Constraints");
  const click = (axis: ConstraintAxis, side: ConstraintSide, shift: boolean) => {
    const now = axis === "horizontal" ? h : v;
    set(axis, clickConstraint(isMixed(now) || now === undefined ? "MIN" : now, side, shift));
  };
  return (
    <PropertyRow label="Constraints" span={2}>
      <div className={styles.constraintRow}>
        <ConstraintsWidget horizontal={h ?? "MIN"} vertical={v ?? "MIN"} onClick={click} />
        <div className={styles.constraintSelects}>
          <Select label="Horizontal constraint" value={h ?? MIXED} options={CONSTRAINT_OPTIONS.horizontal} onChange={(c) => set("horizontal", c as ConstraintType)} />
          <Select label="Vertical constraint" value={v ?? MIXED} options={CONSTRAINT_OPTIONS.vertical} onChange={(c) => set("vertical", c as ConstraintType)} />
        </div>
      </div>
    </PropertyRow>
  );
}

/** The widget: 4 edge lines and the middle cross, each a button (blue when on). */
export function ConstraintsWidget({ horizontal, vertical, onClick }: { horizontal: Mixed<ConstraintType>; vertical: Mixed<ConstraintType>; onClick: (axis: ConstraintAxis, side: ConstraintSide, shift: boolean) => void }) {
  const hs = isMixed(horizontal) ? [] : selectedSides(horizontal);
  const vs = isMixed(vertical) ? [] : selectedSides(vertical);
  // The 56 × 56 box; the inner square 24 in the middle (16 … 40).
  const lines: { axis: ConstraintAxis; side: ConstraintSide; d: string; hit: [number, number, number, number]; label: string }[] = [
    { axis: "vertical", side: "min", d: "M28 4.5V12.5", hit: [22, 0, 12, 16], label: "Top" },
    { axis: "vertical", side: "max", d: "M28 43.5V51.5", hit: [22, 40, 12, 16], label: "Bottom" },
    { axis: "horizontal", side: "min", d: "M4.5 28H12.5", hit: [0, 22, 16, 12], label: "Left" },
    { axis: "horizontal", side: "max", d: "M43.5 28H51.5", hit: [40, 22, 16, 12], label: "Right" },
    { axis: "horizontal", side: "center", d: "M22 28H34", hit: [17, 24, 22, 8], label: "Center horizontally" },
    { axis: "vertical", side: "center", d: "M28 22V34", hit: [24, 17, 8, 22], label: "Center vertically" },
  ];
  const on = (axis: ConstraintAxis, side: ConstraintSide) => (axis === "horizontal" ? hs : vs).includes(side);
  return (
    <svg data-ds-editor="ConstraintsWidget" className={styles.constraintWidget} viewBox="0 0 56 56" width="56" height="56" role="group" aria-label="Constraints">
      <rect className={styles.constraintBox} x="0.5" y="0.5" width="55" height="55" rx="4.5" />
      <rect className={styles.constraintInner} x="16.5" y="16.5" width="23" height="23" rx="1.5" />
      {lines.map((l) => (
        <g key={l.label} role="button" aria-label={l.label} aria-pressed={on(l.axis, l.side)} className={styles.constraintLine} data-on={on(l.axis, l.side) || undefined} onPointerDown={(e) => e.preventDefault()} onClick={(e) => onClick(l.axis, l.side, e.shiftKey)}>
          <rect x={l.hit[0]} y={l.hit[1]} width={l.hit[2]} height={l.hit[3]} fill="transparent" />
          <path d={l.d} />
        </g>
      ))}
    </svg>
  );
}
