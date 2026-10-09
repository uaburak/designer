/**
 * The Design panel in vector edit mode (live design/vector-edit-mode.txt, vector-edit-point-selected.txt): the title
 * "Vector" with no header buttons, then one block — Alignment (the six buttons and More actions), Position (the
 * selected points' X / Y; disabled and empty with none selected), Mirroring (No mirroring / Mirror angle / Mirror
 * angle and length as three glyphs), Corner radius — and Fill and Stroke only (no Layout, Appearance, Effects or
 * Export). X / Y and the radius write VECTOR_SET_POINTS, the mirroring VECTOR_SET_MIRRORING (one undo step each).
 * Aligning points needs an engine command the build doesn't have yet: the buttons are live's (enabled), their click
 * runs it when there is one (docs/editor.md "Needed").
 */
import { Icon, IconButton, MIXED, MenuButton, NumericInput, PropertyGrid, PropertyRow, SegmentedControl, type ChangeInfo, type IconName } from "@/ds";
import { useEditor } from "../../controller";
import { useUI } from "../../hooks";
import { useStoreSlice } from "../../uiStore";
import { command, shortcutOf } from "../../commands";
import { hasCommand, runEngineCommand } from "../../engineCompat";
import { pointsSummary, type Mirroring } from "../../vectorEdit";
import styles from "./Design.module.css";

export const MIRRORING_OPTIONS: { value: Mirroring; label: string; icon: IconName }[] = [
  { value: "NONE", label: "No mirroring", icon: "24.vector.mirror-none" },
  { value: "ANGLE", label: "Mirror angle", icon: "24.vector.mirror-angle" },
  { value: "ANGLE_AND_LENGTH", label: "Mirror angle and length", icon: "24.vector.mirror-angle-length" },
];

const ALIGN = [
  ["arrange.align-left", "24.layout-align-left", "ALIGN_LEFT"],
  ["arrange.align-horizontal-center", "24.layout-align-horizontal-center", "ALIGN_HORIZONTAL_CENTER"],
  ["arrange.align-right", "24.layout-align-right", "ALIGN_RIGHT"],
  ["arrange.align-top", "24.layout-align-top", "ALIGN_TOP"],
  ["arrange.align-vertical-center", "24.layout-align-vertical-center", "ALIGN_VERTICAL_CENTER"],
  ["arrange.align-bottom", "24.layout-align-bottom", "ALIGN_BOTTOM"],
] as const;

/** The selected points' alignment, when the engine has it (VECTOR_ALIGN_POINTS { align }); unverified beyond live's enabled buttons. */
const POINT_ALIGN = "VECTOR_ALIGN_POINTS";

export function VectorEditPanel() {
  const ed = useEditor();
  const labels = useUI((s) => s.propertyLabels);
  const state = useStoreSlice(ed.vector.state, (s) => s);
  const sum = pointsSummary(state.points);
  const some = state.selectedVertices.length > 0;
  // Live: with no point picked, No mirroring shows chosen.
  const mirroring = state.mirroring === "MIXED" ? MIXED : (state.mirroring ?? "NONE");
  const setPoints = (args: { x?: number; y?: number; cornerRadius?: number }, info: ChangeInfo) => {
    if (info.final !== false && ed.vector.canSetPoints) ed.vector.setPoints(args);
  };
  const alignButton = (i: number) => {
    const [id, icon, how] = ALIGN[i];
    const c = command(id);
    return <IconButton key={id} icon={icon} label={c.label} shortcut={shortcutOf(c)} className={styles.groupButton} onClick={() => hasCommand(POINT_ALIGN) && some && runEngineCommand(ed.engine, POINT_ALIGN, { align: how })} />;
  };
  const more = ["arrange.distribute-horizontal", "arrange.distribute-vertical", "arrange.tidy-up"].map((id) => ({ id, label: command(id).label, shortcut: shortcutOf(command(id)), disabled: true }));
  return (
    <section className={styles.vectorEdit} aria-label="Vector" data-vector-points="">
      <div className={styles.vectorEditTitle}>
        <span className={styles.typeLabel}>Vector</span>
      </div>
      <PropertyGrid labels={labels}>
        <PropertyRow
          label="Alignment"
          action={
            <MenuButton label="More actions" tooltip entries={more} className={styles.iconMenu} onSelect={() => undefined}>
              <Icon name="24.more" />
            </MenuButton>
          }
        >
          <div className={styles.buttonGroup}>{[0, 1, 2].map(alignButton)}</div>
          <div className={styles.buttonGroup}>{[3, 4, 5].map(alignButton)}</div>
        </PropertyRow>
        <PropertyRow label="Position">
          <NumericInput label="X-position" prefix="X" prefixTone="primary" disabled={!sum} className={styles.plainDisabled} value={sum ? Math.round(sum.x * 100) / 100 : null} onChange={(v, info) => setPoints({ x: v }, info)} onCancel={() => ed.cancelEdit()} />
          <NumericInput label="Y-position" prefix="Y" prefixTone="primary" disabled={!sum} className={styles.plainDisabled} value={sum ? Math.round(sum.y * 100) / 100 : null} onChange={(v, info) => setPoints({ y: v }, info)} onCancel={() => ed.cancelEdit()} />
        </PropertyRow>
        <PropertyRow span={2} label="Mirroring">
          <div className={styles.vectorMirroring}>
          <span className={styles.vectorLegend}>Mirroring</span>
          <SegmentedControl
            label="Mirroring"
            fullWidth
            value={mirroring}
            options={MIRRORING_OPTIONS.map((o) => ({ value: o.value, icon: o.icon, tooltip: o.label }))}
            onChange={(v) => some && ed.vector.canSetMirroring && ed.vector.setMirroring(v as Mirroring)}
          />
          </div>
        </PropertyRow>
        <PropertyRow label="Corner radius">
          <NumericInput label="Corner radius" prefix="24.corners" min={0} value={sum ? (sum.radius ?? MIXED) : 0} onChange={(v, info) => setPoints({ cornerRadius: v }, info)} onCancel={() => ed.cancelEdit()} />
          <span />
        </PropertyRow>
      </PropertyGrid>
    </section>
  );
}
