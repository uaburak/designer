/**
 * The Stroke section's own rows (UI3): position and weight, "Individual
 * strokes" for frames and rectangles (All / Top / Bottom / Left / Right /
 * Custom: the four side weights), and the "Stroke settings" popover — stroke
 * style (Solid / Dash) with dash and gap, the dash cap (closed paths), join and
 * miter angle. Open paths (lines, open vectors) get Figma's "Start point" and
 * "End point" row under position and weight (live design/line.txt, arrow.txt):
 * each end's cap or arrowhead — None, Round, Square, Line arrow, Triangle arrow,
 * Reversed triangle, Circle arrow, Diamond arrow — written per end by the
 * engine's SET_END_CAPS (the network's end vertices' styles). Fields
 * (docs/engine-build.md E4): strokeAlign, strokeWeight,
 * borderStrokeWeightsIndependent, border{Top,Right,Bottom,Left}Weight,
 * dashPattern, strokeCap, strokeJoin, miterLimit.
 */
import { useState } from "react";
import { VariableField } from "./Variables";
import { MIXED, MenuButton, NumericInput, Popover, PropertyGrid, PropertyRow, SegmentedControl, Select, Icon, IconButton, TextInput, cx, type ChangeInfo, type IconName, type MenuEntry } from "@/ds";
import type { NodeFields, StrokeAlign, StrokeCap } from "@/engine/codec";
import { useEditor } from "../../controller";
import { runEngineCommand } from "../../engineCompat";
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

/**
 * What the first stroke added to a layer writes besides its paint: weight 1 and, on closed shapes, Inside — Figma
 * draws rectangles, ellipses, polygons, stars and frames with their strokes inside (live design/rectangle-with-stroke
 * after "Add stroke": "Inside"); lines and open vectors keep Center, text keeps its own alignment (unverified).
 */
export function firstStrokeFields(n: PanelNode, weight: number): NodeFields {
  const type = typeOf(n);
  const closed = type !== "LINE" && type !== "VECTOR" && type !== "TEXT";
  return { strokeWeight: weight, ...(closed && (n.strokeAlign ?? "CENTER") === "CENTER" ? { strokeAlign: "INSIDE" as StrokeAlign } : {}) };
}

/** Live (popovers/stroke-individual-strokes-menu.txt): each side with its glyph, Custom after a line. */
const SIDE_ITEMS: { id: StrokeSide; label: string; icon: IconName }[] = [
  { id: "ALL", label: "All", icon: "24.stroke.side-all" },
  { id: "TOP", label: "Top", icon: "24.stroke.side-top" },
  { id: "BOTTOM", label: "Bottom", icon: "24.stroke.side-bottom" },
  { id: "LEFT", label: "Left", icon: "24.stroke.side-left" },
  { id: "RIGHT", label: "Right", icon: "24.stroke.side-right" },
  { id: "CUSTOM", label: "Custom", icon: "24.strokes.individual" },
];

export function StrokeRows({ nodes, labels }: { nodes: PanelNode[]; labels: boolean }) {
  const ed = useEditor();
  const sidesKept = useKeeps("borderStrokeWeightsIndependent");
  const refs = nodes.map((n) => n.guid);
  const align = mixed(nodes.map((n) => n.strokeAlign ?? "INSIDE"));
  // Rectangles and frames; a section has none (Figma's live panel).
  const perSide = sidesKept && nodes.every((n) => hasCorners(n) && typeOf(n) !== "SECTION");
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
  const sideMenu: MenuEntry[] = SIDE_ITEMS.flatMap((s): MenuEntry[] => [...(s.id === "CUSTOM" ? ["-" as const] : []), { id: s.id, label: s.label, icon: s.icon, checked: side === s.id }]);
  return (
    <PropertyGrid labels={labels}>
      <PropertyRow
        // Figma's live panel: "Position" (76) and "Weight" (72), "Advanced stroke settings" at 180, Individual strokes at 208.
        labels={["Position", "Weight"]}
        columns="minmax(0, 76fr) minmax(0, 72fr)"
        action2={<StrokeSettingsButton nodes={nodes} />}
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
          // Live: an outlined dropdown on the panel's colour (#2c2c2c), its value 9 in
          variant="outlined"
          className={styles.outlinedSelect}
          label="Stroke align"
          value={align ?? "INSIDE"}
          // Live order (popovers/stroke-position-menu.txt): Center, Inside, Outside.
          options={[
            { value: "CENTER", label: "Center" },
            { value: "INSIDE", label: "Inside" },
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
          // A single side's weight steps that side (as typing writes it: writeWeight), not strokeWeight alone.
          onStep={(d) =>
            ed.batch("Stroke weight", () =>
              nodes.forEach((n) => {
                const v = Math.max(0, (singleField ? (n[singleField] ?? 0) : (n.strokeWeight ?? 1)) + d);
                ed.engine.setProps([n.guid], singleField ? fields({ [singleField]: v, strokeWeight: v }) : { strokeWeight: v });
              })
            )
          }
          onExpression={(each, info) =>
            ed.edit("Stroke weight", info, () =>
              nodes.forEach((n) => {
                const v = Math.max(0, each(singleField ? (n[singleField] ?? 0) : (n.strokeWeight ?? 1)));
                ed.engine.setProps([n.guid], singleField ? fields({ [singleField]: v, strokeWeight: v }) : { strokeWeight: v });
              })
            )
          }
          onExit={exitToCanvas(ed)}
        />
        </VariableField>
      </PropertyRow>
      <EndPointsRow nodes={nodes} />
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

// ---- End points ---------------------------------------------------------------------------------

/** Figma's end points: the caps, then the arrowheads, each with its glyph (drawn for the end; the start mirrors it). */
export const END_POINTS: { value: StrokeCap; label: string; icon: IconName }[] = [
  { value: "NONE", label: "None", icon: "24.endpoint.none" },
  { value: "ROUND", label: "Round", icon: "24.endpoint.round" },
  { value: "SQUARE", label: "Square", icon: "24.endpoint.square" },
  { value: "ARROW_LINES", label: "Line arrow", icon: "24.endpoint.line-arrow" },
  { value: "ARROW_EQUILATERAL", label: "Triangle arrow", icon: "24.endpoint.triangle-arrow" },
  { value: "TRIANGLE_FILLED", label: "Reversed triangle", icon: "24.endpoint.reversed-triangle" },
  { value: "CIRCLE_FILLED", label: "Circle arrow", icon: "24.endpoint.circle-arrow" },
  { value: "DIAMOND_FILLED", label: "Diamond arrow", icon: "24.endpoint.diamond-arrow" },
];

/**
 * Start point / End point (open paths only), as live (design/line.txt, arrow.txt): "Start point" and "End point"
 * captions over two outlined dropdowns in the Position / Weight columns (76 and 72), each showing its end of the line
 * — a 200 wide preview clipped to the button, the cap at the start's left or the end's right — and a chevron.
 */
function EndPointsRow({ nodes }: { nodes: PanelNode[] }) {
  const ed = useEditor();
  const ends = nodes.every(isOpenPath) ? nodes.map((n) => ed.engine.endCaps(n.guid)) : [];
  if (!ends.length || ends.some((e) => !e)) return null;
  const start = mixed(ends.map((e) => e!.start));
  const end = mixed(ends.map((e) => e!.end));
  const entries = (value: StrokeCap | typeof MIXED | undefined): MenuEntry[] => [
    ...END_POINTS.slice(0, 3).map((p) => ({ id: p.value, label: p.label, icon: p.icon, checked: value === p.value })),
    "-",
    ...END_POINTS.slice(3).map((p) => ({ id: p.value, label: p.label, icon: p.icon, checked: value === p.value })),
  ];
  const write = (which: "start" | "end", v: string) => runEngineCommand(ed.engine, "SET_END_CAPS", { [which]: v });
  return (
    <PropertyRow labels={["Start point", "End point"]} columns="minmax(0, 76fr) minmax(0, 72fr)" action2={null} data-end-points="">
      <MenuButton label="Start point" entries={entries(start)} className={styles.endPoint} onSelect={(id) => write("start", id)}>
        <EndPointPreview value={start} side="start" />
        <Icon name="16.chevron.down" className={styles.endPointChevron} />
      </MenuButton>
      <MenuButton label="End point" entries={entries(end)} className={styles.endPoint} onSelect={(id) => write("end", id)}>
        <EndPointPreview value={end} side="end" />
        <Icon name="16.chevron.down" className={styles.endPointChevron} />
      </MenuButton>
    </PropertyRow>
  );
}

/** One end of the line as live draws it: the stem (3 thick under the plain caps, 1 under arrowheads) and the cap. */
function EndPointPreview({ value, side }: { value: StrokeCap | typeof MIXED | undefined; side: "start" | "end" }) {
  const point = END_POINTS.find((p) => p.value === value) ?? END_POINTS[0];
  const plain = point.value === "NONE" || point.value === "ROUND" || point.value === "SQUARE";
  return (
    <span className={styles.endPointClip}>
      <span role="img" aria-label={value === MIXED ? "Mixed" : point.label} className={cx(styles.endPointLine, side === "start" && styles.endPointStart)} data-value={value === MIXED ? "MIXED" : (value ?? "NONE")}>
        <span className={cx(styles.endPointStem, plain && styles.endPointStemThick)} />
        <Icon name={point.icon} />
      </span>
    </span>
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
      <IconButton icon="24.adjust.small" label="Advanced stroke settings" tone="secondary" disabled={!kept} aria-expanded={!!anchor} onClick={(e) => setAnchor(anchor ? null : e.currentTarget)} />
      {anchor && <StrokeSettings nodes={nodes} anchor={anchor} onClose={() => setAnchor(null)} />}
    </>
  );
}

/** Figma's stroke styles: Solid, Dashed (one dash and gap), Custom (any longer dash list). */
export function strokeStyleOf(pattern: readonly number[] | undefined): "SOLID" | "DASHED" | "CUSTOM" {
  if (!pattern?.length) return "SOLID";
  return pattern.length <= 2 ? "DASHED" : "CUSTOM";
}

/** "Dashes" typed for a Custom style: numbers apart by commas or spaces (dash, gap, dash, gap…); null when not. */
export function parseDashes(raw: string): number[] | null {
  const parts = raw.trim().split(/[\s,]+/).filter(Boolean).map(Number);
  if (!parts.length || parts.some((n) => !Number.isFinite(n) || n < 0)) return null;
  return parts.map((n) => Math.round(n * 100) / 100);
}

/**
 * The stroke settings popover as Figma's live one (popovers/stroke-advanced-settings.txt, 240 wide): Stroke Type
 * (Basic; Dynamic and Brush not built), Style (Solid / Dashed / Custom, 128), the dash fields, Join (Miter / Bevel /
 * Round as segments, 128), Miter angle — and, for open paths or dashes, the cap.
 */
function StrokeSettings({ nodes, anchor, onClose }: { nodes: PanelNode[]; anchor: HTMLElement; onClose: () => void }) {
  const ed = useEditor();
  const refs = nodes.map((n) => n.guid);
  const dashes = mixed(nodes.map((n) => n.dashPattern ?? []), sameData);
  const pattern = dashes === undefined || dashes === MIXED ? undefined : (dashes as number[]);
  const d = dashOf(pattern);
  const style = mixed(nodes.map((n) => strokeStyleOf(n.dashPattern)));
  const cap = mixed(nodes.map((n) => n.strokeCap ?? "NONE"));
  const join = mixed(nodes.map((n) => n.strokeJoin ?? "MITER"));
  const angle = mixedNumber(nodes.map((n) => Math.round(miterAngle(n.miterLimit ?? 4) * 100) / 100));
  const open = nodes.every(isOpenPath);
  const set = (label: string, f: NodeFields) => ed.setProps(refs, f, label);
  const setDash = (dash: number, gap: number, info: ChangeInfo) => ed.edit("Dash", info, () => void ed.engine.setProps(refs, fields({ dashPattern: [dash, gap] })));
  const pickStyle = (v: string) => {
    if (v === "SOLID") set("Stroke style", fields({ dashPattern: [] }));
    else if (v === "DASHED") set("Stroke style", fields({ dashPattern: [d.dash, d.gap] }));
    else set("Stroke style", fields({ dashPattern: pattern && pattern.length > 2 ? pattern : [d.dash, d.gap, d.dash, d.gap * 2] }));
  };
  return (
    <Popover anchor={anchor} title="Stroke settings" width={240} onClose={onClose} label="Stroke settings">
      <div className={`${styles.settings} ${styles.settingsEnd} ${styles.strokeSettings}`}>
        <div className={cx(styles.settingsWide, styles.strokeType)}>
          <SegmentedControl
            label="Stroke Type"
            fullWidth
            value="BASIC"
            options={[
              { value: "BASIC", label: "Basic" },
              { value: "DYNAMIC", label: "Dynamic", disabled: true },
              { value: "BRUSH", label: "Brush", disabled: true },
            ]}
            onChange={() => undefined}
          />
        </div>
        {/* (keeps the grid's label / control parity after the full-width row) */}
        <span style={{ display: "none" }} />
        <span className={styles.settingsLabel}>Style</span>
        <Select
          label="Style"
          variant="ghost"
          prefix={style === "DASHED" ? "24.stroke.dashed" : style === "CUSTOM" ? "24.stroke.custom" : "24.stroke.solid"}
          width={128}
          value={style === MIXED || style === undefined ? "" : style}
          placeholder="Mixed"
          options={[
            { value: "SOLID", label: "Solid" },
            { value: "DASHED", label: "Dashed" },
            { value: "CUSTOM", label: "Custom" },
          ]}
          onChange={pickStyle}
        />
        {style === "DASHED" && (
          <>
            <span className={styles.settingsLabel}>Dash</span>
            <NumericInput className={styles.settingsWideField} scrubHandle="previous" label="Dash" min={0} value={d.dash} onChange={(v, info) => setDash(v, d.gap, info)} onCancel={() => ed.cancelEdit()} />
            <span className={styles.settingsLabel}>Gap</span>
            <NumericInput className={styles.settingsWideField} scrubHandle="previous" label="Gap" min={0} value={d.gap} onChange={(v, info) => setDash(d.dash, v, info)} onCancel={() => ed.cancelEdit()} />
          </>
        )}
        {style === "CUSTOM" && (
          <>
            <span className={styles.settingsLabel}>Dashes</span>
            <TextInput
              className={styles.settingsWideField}
              label="Dashes"
              value={(pattern ?? []).join(", ")}
              onCommit={(raw) => {
                const list = parseDashes(raw);
                if (list) set("Dashes", fields({ dashPattern: list }));
              }}
            />
          </>
        )}
        {!open && (style === "DASHED" || style === "CUSTOM") && (
          <>
            <span className={styles.settingsLabel}>Dash cap</span>
            <Select
              label="Dash cap"
              width={128}
              value={cap === MIXED || cap === undefined ? "" : cap}
              placeholder="Mixed"
              options={CAPS.filter((c) => !c.open)}
              onChange={(v) => set("Stroke cap", fields({ strokeCap: v as PanelNode["strokeCap"] }))}
            />
          </>
        )}
        {/* Live: Width profile — "Uniform" (variable-width profiles aren't drawn here: the only choice) and Flip width points */}
        <span className={styles.settingsLabel}>Width profile</span>
        <span className={styles.widthProfile}>
          <Select label="Width profile" variant="ghost" width={96} value="UNIFORM" options={[{ value: "UNIFORM", label: "Uniform" }]} onChange={() => undefined} />
          <IconButton icon="24.flip.horizontal.small" label="Flip width points" disabled />
        </span>
        <span className={styles.settingsLabel}>Join</span>
        <SegmentedControl
          label="Join"
          className={styles.settingsWideField}
          fullWidth
          value={join === MIXED || join === undefined ? "" : join}
          options={[
            { value: "MITER", icon: "24.join.miter", tooltip: "Miter" },
            { value: "BEVEL", icon: "24.join.bevel", tooltip: "Bevel" },
            { value: "ROUND", icon: "24.join.round", tooltip: "Round" },
          ]}
          onChange={(v) => set("Stroke join", fields({ strokeJoin: v as PanelNode["strokeJoin"] }))}
        />
        {join === "MITER" && (
          <>
            <span className={styles.settingsLabel}>Miter angle</span>
            <NumericInput
              className={styles.settingsWideField}
              scrubHandle="previous"
              label="Miter angle"
              prefix="24.radius.top.left"
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
