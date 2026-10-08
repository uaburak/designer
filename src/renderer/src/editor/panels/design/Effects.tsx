/**
 * Effects and Layout guide (UI3), and the effect / guide settings popovers.
 *
 * Effects: "+" adds a Drop shadow with Figma's defaults (X 0, Y 4, Blur 4,
 * Spread 0, #000000 25%); each row, top first: the effect's glyph (opens its
 * settings), the type dropdown (Drop shadow, Inner shadow, Layer blur,
 * Background blur), eye, minus. Settings: Position X / Y, Blur, Spread, the
 * colour, "Show behind transparent areas" (drop shadows) — blurs have Blur
 * only. Stored as `effects` (schema Effect: DROP_SHADOW, INNER_SHADOW,
 * FOREGROUND_BLUR = Layer blur, BACKGROUND_BLUR).
 *
 * Layout guide (frames): "+" adds Figma's "Grid 10px" (#FF0000 at 10%); each
 * row: the guide's glyph (settings), its name ("Grid 10px", "Columns 5",
 * "Rows 5"), eye, minus. Settings: Grid / Columns / Rows; a grid's size; for
 * columns and rows the count, the type (Stretch / Left / Center / Right for
 * columns, Top / Center / Bottom for rows), width (Auto when stretched),
 * margin or offset, gutter; the colour. Stored as `layoutGrids`.
 */
import { useState } from "react";
import { Checkbox, ColorInput, IconButton, NumericInput, PanelSection, Popover, SegmentedControl, Select, cx, type ChangeInfo, type IconName } from "@/ds";
import type { Guid } from "@/engine/codec";
import { useEditor, type EditorController } from "../../controller";
import { colorToHex, hexToColor, toPercent } from "../../model/color";
import { mixed, sameData } from "../../model/mixed";
import { fields, useKeeps, type Effect, type LayoutGrid, type PanelNode } from "./shared";
import styles from "./Design.module.css";
import { AppliedStyle, StylesButton, sharedStyle } from "./Styles";

// ---- Effects ---------------------------------------------------------------------------------------

export const EFFECT_TYPES: { value: Effect["type"]; label: string; icon: IconName }[] = [
  { value: "DROP_SHADOW", label: "Drop shadow", icon: "24.drop.shadow.mid.small" },
  { value: "INNER_SHADOW", label: "Inner shadow", icon: "24.inner.shadow.top.left.small" },
  { value: "FOREGROUND_BLUR", label: "Layer blur", icon: "24.layer.blur.small" },
  { value: "BACKGROUND_BLUR", label: "Background blur", icon: "24.background.blur.small" },
];

export const isShadow = (e: Effect) => e.type === "DROP_SHADOW" || e.type === "INNER_SHADOW";

/** Figma's new effect of a type: shadows 0 4 4 0 #000 25%, blurs radius 4. */
export function defaultEffect(type: Effect["type"] = "DROP_SHADOW"): Effect {
  if (type === "DROP_SHADOW" || type === "INNER_SHADOW")
    return { type, color: { r: 0, g: 0, b: 0, a: 0.25 }, offset: { x: 0, y: 4 }, radius: 4, spread: 0, visible: true, blendMode: "NORMAL", ...(type === "DROP_SHADOW" ? { showShadowBehindNode: false } : {}) };
  return { type, radius: 4, visible: true };
}

/** The effect as another type: a shadow keeps its numbers as a shadow, a blur keeps its radius. */
export function withEffectType(e: Effect, type: Effect["type"]): Effect {
  if (type === e.type) return e;
  const base = defaultEffect(type);
  if (isShadow(e) && (type === "DROP_SHADOW" || type === "INNER_SHADOW")) {
    const out: Effect = { ...e, type };
    if (type === "INNER_SHADOW") delete out.showShadowBehindNode;
    else out.showShadowBehindNode ??= false;
    return out;
  }
  return { ...base, radius: e.radius ?? base.radius, visible: e.visible ?? true };
}

function writeEffects(ed: EditorController, refs: readonly Guid[], effects: Effect[], label: string, info: ChangeInfo = { final: true, source: "pick" }) {
  ed.edit(label, info, () => void ed.engine.setProps(refs, fields({ effects })));
}

export function EffectsSection({ nodes }: { nodes: PanelNode[] }) {
  const ed = useEditor();
  const kept = useKeeps("effects");
  const refs = nodes.map((n) => n.guid);
  const shared = mixed(nodes.map((n) => n.effects ?? []), sameData);
  const isMixedList = shared !== undefined && typeof shared === "symbol";
  const effects = (shared === undefined || isMixedList ? [] : [...(shared as Effect[])]) as Effect[];
  const [open, setOpen] = useState<{ index: number; anchor: HTMLElement } | null>(null);
  const add = () => writeEffects(ed, refs, isMixedList ? [defaultEffect()] : [...effects, defaultEffect()], "Add effect");
  const empty = !isMixedList && effects.length === 0;
  const styled = sharedStyle(nodes, "effect");
  const hasStyle = !!styled && styled !== "mixed";
  return (
    <PanelSection title="Effects" empty={empty} actions={<><StylesButton nodes={nodes} slot="effect" />{!hasStyle && <IconButton icon="24.plus.small" label="Add effect" tone="secondary" disabled={!kept} onClick={add} />}</>}>
      {hasStyle && <AppliedStyle nodes={nodes} slot="effect" />}
      {!hasStyle && isMixedList && <div className={styles.note}>Click + to replace mixed effects</div>}
      {!hasStyle && effects
        .map((e, i) => ({ e, i }))
        .reverse()
        .map(({ e, i }) => {
          const type = EFFECT_TYPES.find((t) => t.value === e.type) ?? EFFECT_TYPES[0];
          const set = (next: Effect, label: string, info?: ChangeInfo) => writeEffects(ed, refs, effects.map((x, j) => (j === i ? next : x)), label, info);
          return (
            <div key={i} className={cx(styles.paintRow, e.visible === false && styles.rowHidden)} data-effect-row={e.type}>
              <div className={styles.effectField}>
                <IconButton icon={type.icon} label="Effect settings" aria-expanded={open?.index === i} onClick={(ev) => setOpen(open?.index === i ? null : { index: i, anchor: ev.currentTarget })} />
                <Select label="Effect type" variant="ghost" value={e.type} options={EFFECT_TYPES.map((t) => ({ value: t.value, label: t.label }))} onChange={(v) => set(withEffectType(e, v as Effect["type"]), "Effect type")} />
              </div>
              <IconButton icon={e.visible === false ? "24.hidden.small" : "24.eye.small"} label={e.visible === false ? "Show effect" : "Hide effect"} tone="secondary" onClick={() => set({ ...e, visible: e.visible === false }, e.visible === false ? "Show effect" : "Hide effect")} />
              <IconButton icon="24.minus.small" label="Remove effect" tone="secondary" onClick={() => writeEffects(ed, refs, effects.filter((_, j) => j !== i), "Remove effect")} />
            </div>
          );
        })}
      {open && effects[open.index] && (
        <EffectSettings
          effect={effects[open.index]}
          anchor={open.anchor}
          onClose={() => setOpen(null)}
          onChange={(next, info) => writeEffects(ed, refs, effects.map((x, j) => (j === open.index ? next : x)), "Effect", info)}
          onCancel={() => ed.cancelEdit()}
        />
      )}
    </PanelSection>
  );
}

/** The effect's settings popover, titled with its type. */
export function EffectSettings({ effect, anchor, onChange, onCancel, onClose }: { effect: Effect; anchor: HTMLElement; onChange: (next: Effect, info: ChangeInfo) => void; onCancel: () => void; onClose: () => void }) {
  const title = EFFECT_TYPES.find((t) => t.value === effect.type)?.label ?? "Effect";
  const color = effect.color ?? { r: 0, g: 0, b: 0, a: 0.25 };
  return (
    <Popover anchor={anchor} title={title} width={240} onClose={onClose} label={title}>
      <div className={styles.settings} data-effect-settings="">
        {isShadow(effect) && (
          <>
            <span className={styles.settingsLabel}>Position</span>
            <div className={styles.pair}>
              <NumericInput label="X" prefix="X" value={effect.offset?.x ?? 0} onChange={(v, info) => onChange({ ...effect, offset: { x: v, y: effect.offset?.y ?? 0 } }, info)} onCancel={onCancel} />
              <NumericInput label="Y" prefix="Y" value={effect.offset?.y ?? 0} onChange={(v, info) => onChange({ ...effect, offset: { x: effect.offset?.x ?? 0, y: v } }, info)} onCancel={onCancel} />
            </div>
          </>
        )}
        <span className={styles.settingsLabel}>Blur</span>
        <NumericInput label="Blur" min={0} value={effect.radius ?? 0} onChange={(v, info) => onChange({ ...effect, radius: v }, info)} onCancel={onCancel} />
        {isShadow(effect) && (
          <>
            <span className={styles.settingsLabel}>Spread</span>
            <NumericInput label="Spread" value={effect.spread ?? 0} onChange={(v, info) => onChange({ ...effect, spread: v }, info)} onCancel={onCancel} />
            <span className={styles.settingsLabel}>Color</span>
            <ColorInput
              label="Shadow color"
              color={colorToHex(color)}
              opacity={toPercent(color.a ?? 1)}
              onColor={(hex, info) => onChange({ ...effect, color: hexToColor(hex, color.a ?? 1) }, info)}
              onOpacity={(o, info) => onChange({ ...effect, color: { ...color, a: o / 100 } }, info)}
            />
          </>
        )}
        {effect.type === "DROP_SHADOW" && (
          <div className={styles.settingsWide}>
            <Checkbox label="Show behind transparent areas" checked={effect.showShadowBehindNode === true} onChange={(on) => onChange({ ...effect, showShadowBehindNode: on }, { final: true, source: "pick" })} />
          </div>
        )}
      </div>
    </Popover>
  );
}

// ---- Layout guide ------------------------------------------------------------------------------------

/** Figma's guide colour: #FF0000 at 10%. */
const GUIDE_RED = { r: 1, g: 0, b: 0, a: 0.1 };

export type GuideKind = "GRID" | "COLUMNS" | "ROWS";

export const guideKind = (g: LayoutGrid): GuideKind => (g.pattern === "GRID" ? "GRID" : g.axis === "Y" ? "ROWS" : "COLUMNS");

/** Figma's new guide of a kind: Grid 10px; Columns / Rows 5, stretch, margin 0, gutter 20. */
export function defaultGuide(kind: GuideKind = "GRID"): LayoutGrid {
  if (kind === "GRID") return { pattern: "GRID", sectionSize: 10, color: GUIDE_RED, visible: true, axis: "X", type: "STRETCH" };
  return { pattern: "STRIPES", axis: kind === "ROWS" ? "Y" : "X", numSections: 5, type: "STRETCH", offset: 0, gutterSize: 20, sectionSize: 10, color: GUIDE_RED, visible: true };
}

/** The row's name: "Grid 10px", "Columns 5", "Rows 5" (Figma; "Columns 5 (Auto)" isn't shown). */
export function guideLabel(g: LayoutGrid): string {
  const kind = guideKind(g);
  if (kind === "GRID") return `Grid ${Math.round((g.sectionSize ?? 10) * 100) / 100}px`;
  return `${kind === "ROWS" ? "Rows" : "Columns"} ${g.numSections ?? 5}`;
}

export const GUIDE_ICON: Record<GuideKind, IconName> = { GRID: "24.grid", COLUMNS: "24.grid-column", ROWS: "24.grid-row" };

export function LayoutGuideSection({ nodes }: { nodes: PanelNode[] }) {
  const ed = useEditor();
  const kept = useKeeps("layoutGrids");
  const refs = nodes.map((n) => n.guid);
  const shared = mixed(nodes.map((n) => n.layoutGrids ?? []), sameData);
  const isMixedList = shared !== undefined && typeof shared === "symbol";
  const grids = (shared === undefined || isMixedList ? [] : [...(shared as LayoutGrid[])]) as LayoutGrid[];
  const [open, setOpen] = useState<{ index: number; anchor: HTMLElement } | null>(null);
  const write = (next: LayoutGrid[], label: string, info: ChangeInfo = { final: true, source: "pick" }) => ed.edit(label, info, () => void ed.engine.setProps(refs, fields({ layoutGrids: next })));
  const empty = !isMixedList && grids.length === 0;
  const styled = sharedStyle(nodes, "grid");
  const hasStyle = !!styled && styled !== "mixed";
  return (
    <PanelSection title="Layout guide" empty={empty} actions={<><StylesButton nodes={nodes} slot="grid" />{!hasStyle && <IconButton icon="24.plus.small" label="Add layout guide" tone="secondary" disabled={!kept} onClick={() => write(isMixedList ? [defaultGuide()] : [...grids, defaultGuide()], "Add layout guide")} />}</>}>
      {hasStyle && <AppliedStyle nodes={nodes} slot="grid" />}
      {!hasStyle && grids
        .map((g, i) => ({ g, i }))
        .reverse()
        .map(({ g, i }) => (
          <div key={i} className={cx(styles.paintRow, g.visible === false && styles.rowHidden)} data-guide-row={guideKind(g)}>
            <div className={styles.effectField}>
              <IconButton icon={GUIDE_ICON[guideKind(g)]} label="Layout guide settings" aria-expanded={open?.index === i} onClick={(ev) => setOpen(open?.index === i ? null : { index: i, anchor: ev.currentTarget })} />
              <span className={styles.effectLabel}>{guideLabel(g)}</span>
            </div>
            <IconButton icon={g.visible === false ? "24.hidden.small" : "24.eye.small"} label={g.visible === false ? "Show layout guide" : "Hide layout guide"} tone="secondary" onClick={() => write(grids.map((x, j) => (j === i ? { ...x, visible: x.visible === false } : x)), "Layout guide")} />
            <IconButton icon="24.minus.small" label="Remove layout guide" tone="secondary" onClick={() => write(grids.filter((_, j) => j !== i), "Remove layout guide")} />
          </div>
        ))}
      {open && grids[open.index] && (
        <GuideSettings grid={grids[open.index]} anchor={open.anchor} onClose={() => setOpen(null)} onCancel={() => ed.cancelEdit()} onChange={(next, info) => write(grids.map((x, j) => (j === open.index ? next : x)), "Layout guide", info)} />
      )}
    </PanelSection>
  );
}

export function GuideSettings({ grid, anchor, onChange, onCancel, onClose }: { grid: LayoutGrid; anchor: HTMLElement; onChange: (next: LayoutGrid, info: ChangeInfo) => void; onCancel: () => void; onClose: () => void }) {
  const kind = guideKind(grid);
  const color = grid.color ?? GUIDE_RED;
  const pick: ChangeInfo = { final: true, source: "pick" };
  const typeOptions =
    kind === "ROWS"
      ? [
          { value: "STRETCH", label: "Stretch" },
          { value: "MIN", label: "Top" },
          { value: "CENTER", label: "Center" },
          { value: "MAX", label: "Bottom" },
        ]
      : [
          { value: "STRETCH", label: "Stretch" },
          { value: "MIN", label: "Left" },
          { value: "CENTER", label: "Center" },
          { value: "MAX", label: "Right" },
        ];
  const stretch = (grid.type ?? "STRETCH") === "STRETCH";
  return (
    <Popover anchor={anchor} title="Layout guide" width={240} onClose={onClose} label="Layout guide">
      <div className={styles.settings} data-guide-settings="">
        <div className={styles.settingsWide}>
          <SegmentedControl
            label="Layout guide type"
            fullWidth
            value={kind}
            options={[
              { value: "GRID", label: "Grid" },
              { value: "COLUMNS", label: "Columns" },
              { value: "ROWS", label: "Rows" },
            ]}
            onChange={(k) => onChange({ ...defaultGuide(k as GuideKind), color: grid.color ?? GUIDE_RED, visible: grid.visible ?? true }, pick)}
          />
        </div>
        {kind === "GRID" ? (
          <>
            <span className={styles.settingsLabel}>Size</span>
            <NumericInput label="Size" min={1} value={grid.sectionSize ?? 10} onChange={(v, info) => onChange({ ...grid, sectionSize: v }, info)} onCancel={onCancel} />
          </>
        ) : (
          <>
            <span className={styles.settingsLabel}>Count</span>
            <NumericInput label="Count" min={1} precision={0} value={grid.numSections ?? 5} onChange={(v, info) => onChange({ ...grid, numSections: Math.round(v) }, info)} onCancel={onCancel} />
            <span className={styles.settingsLabel}>Type</span>
            <Select label="Type" value={grid.type ?? "STRETCH"} options={typeOptions} onChange={(v) => onChange({ ...grid, type: v as LayoutGrid["type"] }, pick)} />
            <span className={styles.settingsLabel}>{kind === "ROWS" ? "Height" : "Width"}</span>
            <NumericInput label={kind === "ROWS" ? "Height" : "Width"} min={1} value={stretch ? null : (grid.sectionSize ?? 10)} valueLabel={stretch ? "Auto" : undefined} disabled={stretch} onChange={(v, info) => onChange({ ...grid, sectionSize: v }, info)} onCancel={onCancel} />
            <span className={styles.settingsLabel}>{stretch ? "Margin" : "Offset"}</span>
            <NumericInput label={stretch ? "Margin" : "Offset"} min={0} value={grid.offset ?? 0} onChange={(v, info) => onChange({ ...grid, offset: v }, info)} onCancel={onCancel} />
            <span className={styles.settingsLabel}>Gutter</span>
            <NumericInput label="Gutter" min={0} value={grid.gutterSize ?? 20} onChange={(v, info) => onChange({ ...grid, gutterSize: v }, info)} onCancel={onCancel} />
          </>
        )}
        <span className={styles.settingsLabel}>Color</span>
        <ColorInput
          label="Layout guide color"
          color={colorToHex(color)}
          opacity={toPercent(color.a ?? 0.1)}
          onColor={(hex, info) => onChange({ ...grid, color: hexToColor(hex, color.a ?? 0.1) }, info)}
          onOpacity={(o, info) => onChange({ ...grid, color: { ...color, a: o / 100 } }, info)}
        />
      </div>
    </Popover>
  );
}
