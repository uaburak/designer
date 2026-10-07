/**
 * The Stroke section's own rows (UI3): position and weight, "Individual
 * strokes" for frames and rectangles (All / Top / Bottom / Left / Right /
 * Custom: the four side weights), and the "Stroke settings" popover — stroke
 * style (Solid / Dash) with dash and gap, cap (with the arrow ends for open
 * paths: lines and vectors), join and miter angle. Fields (docs/engine-build.md
 * E4): strokeAlign, strokeWeight, borderStrokeWeightsIndependent,
 * border{Top,Right,Bottom,Left}Weight, dashPattern, strokeCap, strokeJoin,
 * miterLimit.
 */
import { useState } from "react";
import { VariableField } from "./Variables";
import { MIXED, MenuButton, NumericInput, Popover, PropertyGrid, PropertyRow, Select, Icon, IconButton, type ChangeInfo, type MenuEntry } from "@/ds";
import type { NodeFields, StrokeAlign } from "@/engine/codec";
import { useEditor } from "../../controller";
import { fieldValue, mixed, mixedNumber, sameData } from "../../model/mixed";
import { exitToCanvas } from "./Sections";
import { fields, hasCorners, typeOf, useKeeps, type PanelNode } from "./shared";
import styles from "./Design.module.css";

export type StrokeSide = "ALL" | "TOP" | "BOTTOM" | "LEFT" | "RIGHT" | "CUSTOM";
const SIDES = ["Top", "Right", "Bottom", "Left"] as const;
type SideField = `border${(typeof SIDES)[number]}Weight`;
const sideField = (s: (typeof SIDES)[number]): SideField => `border${s}Weight`;

/** A stroke node's per-side view: which sides are on ("All" when not independent). */
export function strokeSideOf(n: PanelNode): StrokeSide {
  if (!n.borderStrokeWeightsIndependent) return "ALL";
  const w = SIDES.map((s) => n[sideField(s)] ?? n.strokeWeight ?? 1);
  const on = w.map((v) => v > 0);
  const count = on.filter(Boolean).length;
  if (count !== 1) return "CUSTOM";
  return (["TOP", "RIGHT", "BOTTOM", "LEFT"] as const)[on.indexOf(true)];
}

/** The fields that put a node's stroke on `side` (its current weight on that side, 0 on the others). */
export function strokeSideFields(n: PanelNode, side: StrokeSide): NodeFields {
  const weight = Math.max(n.strokeWeight ?? 1, ...SIDES.map((s) => n[sideField(s)] ?? 0));
  if (side === "ALL") return fields({ borderStrokeWeightsIndependent: false, strokeWeight: weight });
  if (side === "CUSTOM") return fields({ borderStrokeWeightsIndependent: true, strokeWeight: weight, ...Object.fromEntries(SIDES.map((s) => [sideField(s), n.borderStrokeWeightsIndependent ? (n[sideField(s)] ?? weight) : weight])) });
  const which = { TOP: "Top", RIGHT: "Right", BOTTOM: "Bottom", LEFT: "Left" }[side];
  return fields({ borderStrokeWeightsIndependent: true, strokeWeight: weight, ...Object.fromEntries(SIDES.map((s) => [sideField(s), s === which ? weight : 0])) });
}

const SIDE_ITEMS: { id: StrokeSide; label: string }[] = [
  { id: "ALL", label: "All" },
  { id: "TOP", label: "Top" },
  { id: "BOTTOM", label: "Bottom" },
  { id: "LEFT", label: "Left" },
  { id: "RIGHT", label: "Right" },
  { id: "CUSTOM", label: "Custom" },
];

export function StrokeRows({ nodes, labels }: { nodes: PanelNode[]; labels: boolean }) {
  const ed = useEditor();
  const sidesKept = useKeeps("borderStrokeWeightsIndependent");
  const refs = nodes.map((n) => n.guid);
  const align = mixed(nodes.map((n) => n.strokeAlign ?? "INSIDE"));
  const perSide = sidesKept && nodes.every((n) => hasCorners(n));
  const stored = mixed(nodes.map(strokeSideOf));
  // "Custom" picked shows the four sides even when only one has a weight (kept for this selection).
  const key = refs.join(",");
  const [customFor, setCustomFor] = useState<string | null>(null);
  const side = customFor === key && stored !== "ALL" ? "CUSTOM" : stored;
  const single = side === "TOP" || side === "RIGHT" || side === "BOTTOM" || side === "LEFT" ? side : null;
  const singleField = single ? sideField(({ TOP: "Top", RIGHT: "Right", BOTTOM: "Bottom", LEFT: "Left" } as const)[single]) : null;
  const weight = mixedNumber(nodes.map((n) => (singleField ? (n[singleField] ?? 0) : (n.strokeWeight ?? 1))));
  const writeWeight = (v: number, info: ChangeInfo) =>
    ed.edit("Stroke weight", info, () => {
      for (const n of nodes) ed.engine.setProps([n.guid], singleField ? fields({ [singleField]: v, strokeWeight: v }) : { strokeWeight: v });
    });
  const sideMenu: MenuEntry[] = SIDE_ITEMS.map((s) => ({ id: s.id, label: s.label, checked: side === s.id }));
  return (
    <PropertyGrid labels={labels}>
      <PropertyRow
        label="Position and weight"
        action={
          perSide ? (
            <MenuButton label="Individual strokes" entries={sideMenu} className={styles.iconMenu} onSelect={(id) => {
                setCustomFor(id === "CUSTOM" ? key : null);
                ed.batch("Individual strokes", () => nodes.forEach((n) => ed.engine.setProps([n.guid], strokeSideFields(n, id as StrokeSide))));
              }}
            >
              <Icon name="24.strokes.individual" />
            </MenuButton>
          ) : undefined
        }
      >
        <Select
          label="Stroke position"
          value={align ?? "INSIDE"}
          options={[
            { value: "INSIDE", label: "Inside" },
            { value: "CENTER", label: "Center" },
            { value: "OUTSIDE", label: "Outside" },
          ]}
          onChange={(v) => ed.setProps(refs, { strokeAlign: v as StrokeAlign }, "Stroke position")}
        />
        <VariableField nodes={nodes} fields={["STROKE_WEIGHT"]} prefix="24.stroke-weight" disabled={side === "CUSTOM"}>
        <NumericInput
          label="Stroke weight"
          prefix="24.stroke-weight"
          min={0}
          value={side === "CUSTOM" ? MIXED : fieldValue(weight)}
          onChange={writeWeight}
          onCancel={() => ed.cancelEdit()}
          onStep={(d) => ed.batch("Stroke weight", () => nodes.forEach((n) => ed.engine.setProps([n.guid], { strokeWeight: Math.max(0, (n.strokeWeight ?? 1) + d) })))}
          onExit={exitToCanvas(ed)}
        />
        </VariableField>
      </PropertyRow>
      {perSide && side === "CUSTOM" && (
        <>
          {[
            ["Top", "Bottom"],
            ["Left", "Right"],
          ].map((pair) => (
            <PropertyRow key={pair[0]} label={`${pair[0]} and ${pair[1].toLowerCase()} stroke`}>
              {(pair as (typeof SIDES)[number][]).map((s) => (
                <VariableField key={s} nodes={nodes} fields={[`BORDER_${s.toUpperCase()}_WEIGHT` as "BORDER_TOP_WEIGHT"]} prefix={`24.al.padding-${s.toLowerCase()}` as "24.al.padding-top"}>
                <NumericInput
                  label={`${s} stroke`}
                  prefix={`24.al.padding-${s.toLowerCase()}` as "24.al.padding-top"}
                  min={0}
                  value={fieldValue(mixedNumber(nodes.map((n) => n[sideField(s)] ?? n.strokeWeight ?? 1)))}
                  onChange={(v, info) => ed.edit("Stroke weight", info, () => void ed.engine.setProps(refs, fields({ [sideField(s)]: v })))}
                  onCancel={() => ed.cancelEdit()}
                  onStep={(d) => ed.batch("Stroke weight", () => nodes.forEach((n) => ed.engine.setProps([n.guid], fields({ [sideField(s)]: Math.max(0, (n[sideField(s)] ?? n.strokeWeight ?? 1) + d) }))))}
                  onExit={exitToCanvas(ed)}
                />
                </VariableField>
              ))}
            </PropertyRow>
          ))}
        </>
      )}
    </PropertyGrid>
  );
}

// ---- Stroke settings --------------------------------------------------------------------------

/** Open paths (their ends take the arrow caps). */
export const isOpenPath = (n: PanelNode) => ["LINE", "VECTOR"].includes(typeOf(n));

/** Figma's cap list: the plain caps, then (open paths) the arrow ends, in its order. */
const CAPS: { value: string; label: string; open?: boolean }[] = [
  { value: "NONE", label: "None" },
  { value: "ROUND", label: "Round" },
  { value: "SQUARE", label: "Square" },
  { value: "ARROW_LINES", label: "Line arrow", open: true },
  { value: "ARROW_EQUILATERAL", label: "Triangle arrow", open: true },
  { value: "TRIANGLE_FILLED", label: "Reversed triangle", open: true },
  { value: "CIRCLE_FILLED", label: "Circle arrow", open: true },
  { value: "DIAMOND_FILLED", label: "Diamond arrow", open: true },
];

/** miterLimit ↔ Figma's "Miter angle" (the smallest angle that still gets a miter): angle = 2·asin(1 / limit). */
export const miterAngle = (limit: number) => (2 * Math.asin(1 / Math.max(1, limit)) * 180) / Math.PI;
export const miterLimitOf = (angleDeg: number) => 1 / Math.sin((Math.max(1, Math.min(180, angleDeg)) * Math.PI) / 360);

/** The dash pattern as Figma's two fields (the first dash and gap; a gap missing = the dash). */
export function dashOf(pattern: readonly number[] | undefined): { dashed: boolean; dash: number; gap: number } {
  if (!pattern?.length) return { dashed: false, dash: 2, gap: 2 };
  return { dashed: true, dash: pattern[0], gap: pattern[1] ?? pattern[0] };
}

export function StrokeSettingsButton({ nodes }: { nodes: PanelNode[] }) {
  const kept = useKeeps("dashPattern");
  const [anchor, setAnchor] = useState<HTMLElement | null>(null);
  return (
    <>
      <IconButton icon="24.adjust.small" label="Stroke settings" tone="secondary" disabled={!kept} aria-expanded={!!anchor} onClick={(e) => setAnchor(anchor ? null : e.currentTarget)} />
      {anchor && <StrokeSettings nodes={nodes} anchor={anchor} onClose={() => setAnchor(null)} />}
    </>
  );
}

function StrokeSettings({ nodes, anchor, onClose }: { nodes: PanelNode[]; anchor: HTMLElement; onClose: () => void }) {
  const ed = useEditor();
  const refs = nodes.map((n) => n.guid);
  const dashes = mixed(nodes.map((n) => n.dashPattern ?? []), sameData);
  const d = dashOf(dashes === undefined || dashes === MIXED ? undefined : (dashes as number[]));
  const style = mixed(nodes.map((n) => ((n.dashPattern ?? []).length ? "DASH" : "SOLID")));
  const cap = mixed(nodes.map((n) => n.strokeCap ?? "NONE"));
  const join = mixed(nodes.map((n) => n.strokeJoin ?? "MITER"));
  const angle = mixedNumber(nodes.map((n) => Math.round(miterAngle(n.miterLimit ?? 4) * 100) / 100));
  const open = nodes.every(isOpenPath);
  const set = (label: string, f: NodeFields) => ed.setProps(refs, f, label);
  const setDash = (dash: number, gap: number, info: ChangeInfo) => ed.edit("Dash", info, () => void ed.engine.setProps(refs, fields({ dashPattern: [dash, gap] })));
  return (
    <Popover anchor={anchor} title="Stroke settings" width={240} onClose={onClose} label="Stroke settings">
      <div className={styles.settings}>
        <span className={styles.settingsLabel}>Stroke style</span>
        <Select
          label="Stroke style"
          value={style === MIXED || style === undefined ? "" : style}
          placeholder="Mixed"
          options={[
            { value: "SOLID", label: "Solid" },
            { value: "DASH", label: "Dash" },
          ]}
          onChange={(v) => set("Stroke style", fields({ dashPattern: v === "DASH" ? [d.dash, d.gap] : [] }))}
        />
        {style === "DASH" && (
          <>
            <span className={styles.settingsLabel}>Dash</span>
            <NumericInput label="Dash" min={0} value={d.dash} onChange={(v, info) => setDash(v, d.gap, info)} onCancel={() => ed.cancelEdit()} />
            <span className={styles.settingsLabel}>Gap</span>
            <NumericInput label="Gap" min={0} value={d.gap} onChange={(v, info) => setDash(d.dash, v, info)} onCancel={() => ed.cancelEdit()} />
          </>
        )}
        <span className={styles.settingsLabel}>{open ? "Cap" : "Dash cap"}</span>
        <Select
          label={open ? "Cap" : "Dash cap"}
          value={cap === MIXED || cap === undefined ? "" : cap}
          placeholder="Mixed"
          options={CAPS.filter((c) => open || !c.open)}
          onChange={(v) => set("Stroke cap", fields({ strokeCap: v as PanelNode["strokeCap"] }))}
        />
        <span className={styles.settingsLabel}>Join</span>
        <Select
          label="Join"
          value={join === MIXED || join === undefined ? "" : join}
          placeholder="Mixed"
          options={[
            { value: "MITER", label: "Miter" },
            { value: "BEVEL", label: "Bevel" },
            { value: "ROUND", label: "Round" },
          ]}
          onChange={(v) => set("Stroke join", fields({ strokeJoin: v as PanelNode["strokeJoin"] }))}
        />
        {join === "MITER" && (
          <>
            <span className={styles.settingsLabel}>Miter angle</span>
            <NumericInput
              label="Miter angle"
              unit="°"
              min={1}
              max={180}
              value={fieldValue(angle)}
              onChange={(v, info) => ed.edit("Miter angle", info, () => void ed.engine.setProps(refs, fields({ miterLimit: miterLimitOf(v) })))}
              onStep={(dv) => ed.batch("Miter angle", () => nodes.forEach((n) => ed.engine.setProps([n.guid], fields({ miterLimit: miterLimitOf(miterAngle(n.miterLimit ?? 4) + dv) }))))}
              onCancel={() => ed.cancelEdit()}
            />
          </>
        )}
      </div>
    </Popover>
  );
}
