/**
 * The Position section's Constraints row (Figma UI3): the widget — a box with
 * an inner square, a line from each edge and a cross in the middle; click a
 * line to pin that side, ⇧-click for both — and the horizontal / vertical
 * dropdowns, writing `horizontalConstraint` / `verticalConstraint`.
 */
import { MIXED, PropertyRow, Select, ToggleIconButton, isMixed, type Mixed } from "@/ds";
import type { ConstraintType } from "@/engine/codec";
import { useEditor } from "../../controller";
import { mixed } from "../../model/mixed";
import { CONSTRAINT_ICONS, CONSTRAINT_OPTIONS, clickConstraint, normalizeConstraint, selectedSides, type ConstraintAxis, type ConstraintSide } from "../../model/constraints";
import { useUI } from "../../hooks";
import type { PanelNode } from "./shared";
import styles from "./Design.module.css";

const FIELD: Record<ConstraintAxis, "horizontalConstraint" | "verticalConstraint"> = { horizontal: "horizontalConstraint", vertical: "verticalConstraint" };

/**
 * The inline Constraints row (Figma's live panel, a layer in a frame with Position's "Constraints" toggle on): the
 * label, the horizontal and vertical dropdowns stacked in the first column (8 apart), the widget (88 × 57) in the second.
 */
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
  const prefix = (axis: ConstraintAxis, c: Mixed<ConstraintType> | undefined) => (isMixed(c) || c === undefined ? undefined : CONSTRAINT_ICONS[axis][c as keyof (typeof CONSTRAINT_ICONS)["horizontal"]]);
  // Live (design/frame-child-constraints-expanded.txt): "Constraints" 2 lower than a one-label row (191), the dropdowns
  // at 207 and 239 — outlined 88 × 24 on the panel's colour, the glyph then the value at 33 in — the widget beside.
  return (
    <PropertyRow labels={["Constraints", undefined]} data-constraints-row="">
      <div className={styles.constraintSelects}>
        <Select className={styles.constraintSelect} variant="outlined" prefix={prefix("horizontal", h)} menuWidth={126} label="Horizontal constraints" value={h ?? MIXED} options={CONSTRAINT_OPTIONS.horizontal} onChange={(c) => set("horizontal", c as ConstraintType)} />
        <Select className={styles.constraintSelect} variant="outlined" prefix={prefix("vertical", v)} menuWidth={136} label="Vertical constraints" value={v ?? MIXED} options={CONSTRAINT_OPTIONS.vertical} onChange={(c) => set("vertical", c as ConstraintType)} />
      </div>
      <ConstraintsWidget horizontal={h ?? "MIN"} vertical={v ?? "MIN"} onClick={click} />
    </PropertyRow>
  );
}

/** Position's "Constraints" toggle (a layer in a frame): shows or hides the inline row, for every selection after. */
export function ConstraintsToggle() {
  const ed = useEditor();
  const open = useUI((s) => !!s.constraintsOpen);
  return <ToggleIconButton icon="24.constraints" label="Constraints" tone="secondary" className={styles.constraintsToggle} pressed={open} aria-expanded={open} onPressedChange={(on) => ed.ui.set({ constraintsOpen: on })} />;
}

/** The widget: 4 edge lines and the middle cross, each a button (blue when on). */
export function ConstraintsWidget({ horizontal, vertical, onClick }: { horizontal: Mixed<ConstraintType>; vertical: Mixed<ConstraintType>; onClick: (axis: ConstraintAxis, side: ConstraintSide, shift: boolean) => void }) {
  const hs = isMixed(horizontal) ? [] : selectedSides(horizontal);
  const vs = isMixed(vertical) ? [] : selectedSides(vertical);
  // Figma's live widget: 88 × 57 on the field colour, a line in from each edge (10 long, 3 in), a cross in the middle
  // (14), the chosen ones 3 thick in blue.
  const lines: { axis: ConstraintAxis; side: ConstraintSide; d: string; hit: [number, number, number, number]; label: string }[] = [
    { axis: "vertical", side: "min", d: "M44 4.5V12.5", hit: [34, 0, 20, 17], label: "Top" },
    { axis: "vertical", side: "max", d: "M44 44.5V52.5", hit: [34, 40, 20, 17], label: "Bottom" },
    { axis: "horizontal", side: "min", d: "M4.5 28.5H12.5", hit: [0, 18, 22, 21], label: "Left" },
    { axis: "horizontal", side: "max", d: "M75.5 28.5H83.5", hit: [66, 18, 22, 21], label: "Right" },
    { axis: "horizontal", side: "center", d: "M37.5 28.5H50.5", hit: [32, 25, 24, 7], label: "Center horizontally" },
    { axis: "vertical", side: "center", d: "M44 22V35", hit: [40, 18, 8, 21], label: "Center vertically" },
  ];
  const on = (axis: ConstraintAxis, side: ConstraintSide) => (axis === "horizontal" ? hs : vs).includes(side);
  return (
    <svg data-ds-editor="ConstraintsWidget" className={styles.constraintWidget} viewBox="0 0 88 57" width="88" height="57" role="group" aria-label="Constraint widget">
      <rect className={styles.constraintBox} x="0" y="0" width="88" height="57" rx="5" />
      <rect className={styles.constraintInner} x="20.5" y="16.5" width="47" height="24" rx="2" />
      {lines.map((l) => (
        <g key={l.label} role="button" aria-label={l.label} aria-pressed={on(l.axis, l.side)} className={styles.constraintLine} data-on={on(l.axis, l.side) || undefined} onPointerDown={(e) => e.preventDefault()} onClick={(e) => onClick(l.axis, l.side, e.shiftKey)}>
          <rect x={l.hit[0]} y={l.hit[1]} width={l.hit[2]} height={l.hit[3]} fill="transparent" />
          <path d={l.d} />
        </g>
      ))}
    </svg>
  );
}
