/**
 * Fill and Stroke (UI3): the paints top first, each a colour row (swatch →
 * the DS ColorPicker, hex, opacity) with its eye and minus; "+" adds one;
 * different paint lists read "Click + to replace mixed fills". Stroke adds
 * its position and weight. A picker drag previews in one open transaction
 * and commits on release.
 */
import { useState } from "react";
import { ColorInput, ColorPicker, IconButton, NumericInput, PanelSection, PropertyGrid, PropertyRow, Select, cx, isMixed, type ChangeInfo, type ColorModel, type PickerPaint } from "@/ds";
import type { Color, Guid, Paint, StrokeAlign } from "@/engine/codec";
import { useEditor, type EditorController } from "../../controller";
import { colorToHex, hexToColor, toPercent } from "../../model/color";
import { mixed, mixedNumber, mixedPaints, fieldValue } from "../../model/mixed";
import { useUI } from "../../hooks";
import { exitToCanvas } from "./Sections";
import { isFrameNode, type PanelNode } from "./shared";
import styles from "./Design.module.css";

type PaintField = "fillPaints" | "strokePaints";

/** What the open picker edits. */
export type PickerTarget = { kind: "paint"; field: PaintField; index: number; anchor: DOMRect } | { kind: "page"; page: Guid; anchor: DOMRect };

function writePaints(ed: EditorController, refs: readonly Guid[], field: PaintField, paints: Paint[], label: string, info: ChangeInfo) {
  ed.edit(label, info, () => {
    ed.engine.setProps(refs, { [field]: paints });
  });
}

/** Figma's first paint: white in a frame's fill, #D9D9D9 in a shape's, black for a stroke; then 20% black. */
function newPaint(field: PaintField, nodes: PanelNode[], existing: number): Paint {
  if (existing > 0) return { type: "SOLID", color: hexToColor("#000000"), opacity: 0.2, visible: true };
  if (field === "strokePaints") return { type: "SOLID", color: hexToColor("#000000"), opacity: 1, visible: true };
  return { type: "SOLID", color: hexToColor(nodes.every(isFrameNode) ? "#ffffff" : "#d9d9d9"), opacity: 1, visible: true };
}

export function PaintsSection({ title, field, nodes, onPick }: { title: "Fill" | "Stroke"; field: PaintField; nodes: PanelNode[]; onPick: (t: PickerTarget) => void }) {
  const ed = useEditor();
  const labels = useUI((s) => s.propertyLabels);
  const refs = nodes.map((n) => n.guid);
  const shared = mixedPaints(nodes.map((n) => n[field] ?? []));
  const paints = shared === undefined || isMixed(shared) ? [] : [...shared];
  const word = title === "Fill" ? "fill" : "stroke";
  const label = title === "Fill" ? "Fill" : "Stroke";
  const add = () => {
    const next = isMixed(shared) ? [newPaint(field, nodes, 0)] : [...paints, newPaint(field, nodes, paints.length)];
    const extra = field === "strokePaints" && !paints.length ? { strokeWeight: nodes[0]?.strokeWeight || 1 } : {};
    ed.setProps(refs, { [field]: next, ...extra }, `Add ${word}`);
  };
  const empty = !isMixed(shared) && paints.length === 0;
  return (
    <PanelSection
      title={title}
      empty={empty}
      actions={
        <>
          {!empty && <IconButton icon="24.styles" label={`${label} styles`} tone="secondary" disabled />}
          <IconButton icon="24.plus.small" label={`Add ${word}`} tone="secondary" onClick={add} />
        </>
      }
    >
      {isMixed(shared) && <div className={styles.note}>Click + to replace mixed {word}s</div>}
      {/* Top paint first: the list's last entry is drawn on top */}
      {paints
        .map((p, i) => ({ p, i }))
        .reverse()
        .map(({ p, i }) => (
          <div key={i} className={styles.paintRow}>
            <ColorInput
              className={cx(styles.paintField, p.visible === false && styles.paintHidden)}
              label={label}
              color={colorToHex(p.color ?? { r: 0, g: 0, b: 0 })}
              opacity={toPercent(p.opacity ?? 1)}
              onColor={(hex, info) => writePaints(ed, refs, field, paints.map((q, j) => (j === i ? { ...q, color: hexToColor(hex, 1) } : q)), `${label} colour`, info)}
              onOpacity={(o, info) => writePaints(ed, refs, field, paints.map((q, j) => (j === i ? { ...q, opacity: o / 100 } : q)), `${label} opacity`, info)}
              onSwatchClick={(anchor) => onPick({ kind: "paint", field, index: i, anchor })}
            />
            <IconButton
              icon={p.visible === false ? "24.hidden.small" : "24.eye.small"}
              label={p.visible === false ? `Show ${word}` : `Hide ${word}`}
              tone="secondary"
              onClick={() => ed.setProps(refs, { [field]: paints.map((q, j) => (j === i ? { ...q, visible: q.visible === false } : q)) }, p.visible === false ? `Show ${word}` : `Hide ${word}`)}
            />
            <IconButton icon="24.minus.small" label={`Remove ${word}`} tone="secondary" onClick={() => ed.setProps(refs, { [field]: paints.filter((_, j) => j !== i) }, `Remove ${word}`)} />
          </div>
        ))}
      {field === "strokePaints" && (isMixed(shared) || paints.length > 0) && <StrokeRows nodes={nodes} labels={labels} />}
    </PanelSection>
  );
}

function StrokeRows({ nodes, labels }: { nodes: PanelNode[]; labels: boolean }) {
  const ed = useEditor();
  const refs = nodes.map((n) => n.guid);
  const align = mixed(nodes.map((n) => n.strokeAlign ?? "INSIDE"));
  const weight = mixedNumber(nodes.map((n) => n.strokeWeight ?? 1));
  return (
    <PropertyGrid labels={labels}>
      <PropertyRow label="Position and weight">
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
        <NumericInput
          label="Stroke weight"
          prefix="24.stroke-weight"
          min={0}
          value={fieldValue(weight)}
          onChange={(v, info) => ed.edit("Stroke weight", info, () => void ed.engine.setProps(refs, { strokeWeight: v }))}
          onCancel={() => ed.cancelEdit()}
          onStep={(d) => ed.batch("Stroke weight", () => nodes.forEach((n) => ed.engine.setProps([n.guid], { strokeWeight: Math.max(0, (n.strokeWeight ?? 1) + d) })))}
          onExit={exitToCanvas(ed)}
        />
      </PropertyRow>
    </PropertyGrid>
  );
}

/** A solid paint ↔ the picker's paint (Figma's names on both sides; the engine draws SOLID only so far). */
export const toPicker = (p: Paint): PickerPaint => ({ type: "SOLID", color: { ...(p.color ?? { r: 0, g: 0, b: 0, a: 1 }), a: 1 }, opacity: p.opacity ?? 1 });
export const fromPicker = (base: Paint, next: PickerPaint): Paint => ({ ...base, type: "SOLID", color: next.color ? { ...next.color, a: 1 } : base.color, opacity: next.opacity ?? base.opacity });

/** The one colour picker of the Design panel, for a paint of the selection or the page's background. */
export function PaintPicker({ target, nodes, pageColor, onClose }: { target: PickerTarget; nodes: PanelNode[]; pageColor: Color | null; onClose: () => void }) {
  const ed = useEditor();
  const [model, setModel] = useState<ColorModel>("hex");
  if (target.kind === "page") {
    const color = pageColor ?? hexToColor("#f5f5f5");
    return (
      <ColorPicker
        value={{ type: "SOLID", color: { ...color, a: 1 }, opacity: color.a ?? 1 }}
        paintTypes={["SOLID"]}
        anchor={target.anchor}
        colorModel={model}
        onColorModelChange={setModel}
        onChange={(next, info) => ed.edit("Page colour", info, () => void ed.engine.setProps([target.page], { backgroundColor: { ...(next.color ?? color), a: next.opacity ?? 1 } }))}
        onCancel={() => ed.cancelEdit()}
        onClose={onClose}
      />
    );
  }
  const refs = nodes.map((n) => n.guid);
  const shared = mixedPaints(nodes.map((n) => n[target.field] ?? []));
  const paints = shared === undefined || isMixed(shared) ? null : [...shared];
  const paint = paints?.[target.index];
  if (!paints || !paint) return null;
  return (
    <ColorPicker
      value={toPicker(paint)}
      paintTypes={["SOLID"]}
      anchor={target.anchor}
      colorModel={model}
      onColorModelChange={setModel}
      onChange={(next, info) => writePaints(ed, refs, target.field, paints.map((q, j) => (j === target.index ? fromPicker(q, next) : q)), target.field === "fillPaints" ? "Fill colour" : "Stroke colour", info)}
      onCancel={() => ed.cancelEdit()}
      onClose={onClose}
    />
  );
}
