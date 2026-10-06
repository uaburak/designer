/**
 * In vector edit mode (E4), the selected points: X / Y, the point's corner
 * radius, and the handles' mirroring (No mirroring / Mirror angle / Mirror
 * angle and length → `VECTOR_SET_MIRRORING`). The engine publishes the
 * selection (`VECTOR_EDIT`: vertex indices, the mirroring) but not the points'
 * positions or radii yet, so X / Y and the radius show disabled until it does
 * (docs/editor.md "Needed").
 */
import { MIXED, NumericInput, PanelSection, PropertyGrid, PropertyRow, Select } from "@/ds";
import { useEditor } from "../../controller";
import { useUI } from "../../hooks";
import { useStoreSlice } from "../../uiStore";
import type { Mirroring } from "../../vectorEdit";

export const MIRRORING_OPTIONS: { value: Mirroring; label: string }[] = [
  { value: "NONE", label: "No mirroring" },
  { value: "ANGLE", label: "Mirror angle" },
  { value: "ANGLE_AND_LENGTH", label: "Mirror angle and length" },
];

export function VectorPointSection() {
  const ed = useEditor();
  const labels = useUI((s) => s.propertyLabels);
  const state = useStoreSlice(ed.vector.state, (s) => s);
  const points = state.selectedVertices.length;
  const mirroring = state.mirroring === "MIXED" ? MIXED : (state.mirroring ?? "NONE");
  return (
    <PanelSection title={points === 1 ? "Point" : points > 1 ? `${points} points` : "Points"} data-vector-points="">
      <PropertyGrid labels={labels}>
        <PropertyRow label="Point position">
          <NumericInput label="Point X" prefix="X" value={null} disabled onChange={() => {}} />
          <NumericInput label="Point Y" prefix="Y" value={null} disabled onChange={() => {}} />
        </PropertyRow>
        <PropertyRow label="Corner radius and mirroring">
          <NumericInput label="Point corner radius" prefix="24.corners" value={null} disabled onChange={() => {}} />
          <span />
        </PropertyRow>
        <PropertyRow span={2} label="Mirroring">
          <Select label="Mirroring" value={mirroring} placeholder="Mixed" disabled={!ed.vector.canSetMirroring} options={MIRRORING_OPTIONS} onChange={(v) => ed.vector.setMirroring(v as Mirroring)} />
        </PropertyRow>
      </PropertyGrid>
    </PanelSection>
  );
}
