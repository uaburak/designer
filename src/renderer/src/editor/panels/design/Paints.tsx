/**
 * Fill and Stroke (UI3): the paints top first, each a row — swatch (colour,
 * gradient or image) → the DS ColorPicker; the hex for a solid, the type's
 * name ("Linear", "Radial", "Angular", "Diamond", "Image") otherwise; opacity
 * — with its eye and minus; "+" adds one; different paint lists read "Click +
 * to replace mixed fills". Stroke adds position, weight, individual strokes
 * (frames, rectangles) and the stroke settings popover (Stroke.tsx).
 *
 * The picker edits every paint type (model/paints.ts maps it to the schema's
 * Paint 1:1). While it shows a gradient on one layer, the engine's on-canvas
 * gradient handles are on (E5 `startPaintEdit`), the picker's stop and the
 * canvas's stop follow each other. An image paint gets Choose image…,
 * Rotate 90° and the adjustment sliders. A picker drag previews in one open
 * transaction and commits on release.
 */
import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { ColorInput, ColorPicker, IconButton, isMixed, PanelSection, cx, type ChangeInfo, type ColorModel, type PickerPaint } from "@/ds";
import type { Color, Guid, Paint } from "@/engine/codec";
import { useEditor, type EditorController } from "../../controller";
import { colorToHex, hexToColor, toPercent } from "../../model/color";
import { mixedPaints } from "../../model/mixed";
import { fromPicker, hashBytes, IMAGE_ADJUSTMENTS, isGradientType, paintImageHash, paintLabel, paintSwatch, rotated90, toPicker, withAdjustment, type FullPaint } from "../../model/paints";
import { regradient, type PaintUse } from "../../model/selectionColors";
import { pickImageFiles } from "../../canvas/ImagePlacer";
import { startGradientEdit } from "../../vectorEdit";
import { useUI } from "../../hooks";
import { pageColors, writeSelectionColor } from "./SelectionColors";
import { StrokeRows, StrokeSettingsButton } from "./Stroke";
import { isFrameNode, type PanelNode } from "./shared";
import styles from "./Design.module.css";

type PaintField = "fillPaints" | "strokePaints";

/** What the open picker edits. */
export type PickerTarget =
  | { kind: "paint"; field: PaintField; index: number; anchor: DOMRect }
  | { kind: "page"; page: Guid; anchor: DOMRect }
  /** A Selection colors row: every paint that used the colour (or gradient) when the picker opened */
  | { kind: "colors"; uses: PaintUse[]; anchor: DOMRect };

function writePaints(ed: EditorController, refs: readonly Guid[], field: PaintField, paints: Paint[], label: string, info: ChangeInfo) {
  ed.edit(label, info, () => {
    ed.engine.setProps(refs, { [field]: paints });
  });
}

/** Figma's first paint: white in a frame's fill, #D9D9D9 in a shape's, black for a stroke; then 20% black. */
export function newPaint(field: PaintField, nodes: readonly { type?: string; resizeToFit?: boolean }[], existing: number): Paint {
  if (existing > 0) return { type: "SOLID", color: hexToColor("#000000"), opacity: 0.2, visible: true };
  if (field === "strokePaints") return { type: "SOLID", color: hexToColor("#000000"), opacity: 1, visible: true };
  return { type: "SOLID", color: hexToColor(nodes.every((n) => isFrameNode(n as PanelNode)) ? "#ffffff" : "#d9d9d9"), opacity: 1, visible: true };
}

/** Re-renders when image URLs arrive (swatches, the picker's preview). */
function useImageUrls(ed: EditorController): void {
  useSyncExternalStore(ed.images.subscribe, ed.images.getVersion);
}

/** One paint row: swatch + hex (or the type's name) + opacity. */
export function PaintRow({ paint, label, onColor, onOpacity, onPick, className }: { paint: FullPaint; label: string; onColor: (hex: string, info: ChangeInfo) => void; onOpacity: (o: number, info: ChangeInfo) => void; onPick: (anchor: DOMRect) => void; className?: string }) {
  const ed = useEditor();
  useImageUrls(ed);
  const solid = paint.type === "SOLID";
  const url = ed.images.urlOf(paintImageHash(paint));
  return (
    <ColorInput
      className={className}
      label={label}
      color={solid ? colorToHex(paint.color ?? { r: 0, g: 0, b: 0 }) : paintSwatch(paint, url)}
      valueLabel={solid ? undefined : paintLabel(paint)}
      opacity={toPercent(paint.opacity ?? 1)}
      onColor={onColor}
      onOpacity={onOpacity}
      onSwatchClick={onPick}
    />
  );
}

export function PaintsSection({ title, field, nodes, onPick }: { title: "Fill" | "Stroke"; field: PaintField; nodes: PanelNode[]; onPick: (t: PickerTarget) => void }) {
  const ed = useEditor();
  const labels = useUI((s) => s.propertyLabels);
  const refs = nodes.map((n) => n.guid);
  const shared = mixedPaints(nodes.map((n) => n[field] ?? []));
  const paints = (shared === undefined || isMixed(shared) ? [] : [...shared]) as FullPaint[];
  const word = title === "Fill" ? "fill" : "stroke";
  const label = title === "Fill" ? "Fill" : "Stroke";
  const add = () => {
    const next = isMixed(shared) ? [newPaint(field, nodes, 0)] : [...paints, newPaint(field, nodes, paints.length)];
    const extra = field === "strokePaints" && !paints.length ? { strokeWeight: nodes[0]?.strokeWeight || 1 } : {};
    ed.setProps(refs, { [field]: next, ...extra }, `Add ${word}`);
  };
  const empty = !isMixed(shared) && paints.length === 0;
  const stroked = field === "strokePaints" && (isMixed(shared) || paints.length > 0);
  return (
    <PanelSection
      title={title}
      empty={empty}
      actions={
        <>
          {!empty && <IconButton icon="24.styles" label={`${label} styles`} tone="secondary" disabled />}
          {stroked && <StrokeSettingsButton nodes={nodes} />}
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
          <div key={i} className={styles.paintRow} data-paint-row={p.type}>
            <PaintRow
              className={cx(styles.paintField, p.visible === false && styles.paintHidden)}
              paint={p}
              label={label}
              onColor={(hex, info) => writePaints(ed, refs, field, paints.map((q, j) => (j === i ? { ...q, color: hexToColor(hex, 1) } : q)), `${label} colour`, info)}
              onOpacity={(o, info) => writePaints(ed, refs, field, paints.map((q, j) => (j === i ? { ...q, opacity: o / 100 } : q)), `${label} opacity`, info)}
              onPick={(anchor) => onPick({ kind: "paint", field, index: i, anchor })}
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
      {stroked && <StrokeRows nodes={nodes} labels={labels} />}
    </PanelSection>
  );
}

/** "Choose image…": a new image into the paint (its scale mode and adjustments kept). */
async function chooseImageFor(ed: EditorController, apply: (p: Pick<FullPaint, "image" | "originalImageWidth" | "originalImageHeight">) => void): Promise<void> {
  const files = await pickImageFiles(false);
  if (!files.length || ed.engine.destroyed) return;
  const [img] = await ed.images.import(files);
  if (!img) return;
  apply({ image: { hash: hashBytes(img.hash), name: img.name }, originalImageWidth: img.width, originalImageHeight: img.height });
}

/** Under the image's scale mode: Rotate 90° and Figma's adjustment sliders (−100…100, 0 in the middle). */
function ImageControls({ paint, onChange }: { paint: FullPaint; onChange: (next: FullPaint, info: ChangeInfo) => void }) {
  return (
    <div className={styles.imageControls}>
      <div className={styles.imageRotate}>
        <IconButton icon="24.rotate" label="Rotate 90°" onClick={() => onChange(rotated90(paint), { final: true, source: "pick" })} />
      </div>
      {IMAGE_ADJUSTMENTS.map(({ field, label }) => (
        <AdjustmentSlider key={field} label={label} value={Math.round((paint.paintFilter?.[field] ?? 0) * 100)} onChange={(v, info) => onChange(withAdjustment(paint, field, v), info)} />
      ))}
    </div>
  );
}

/** One adjustment: its name, a slider from −100 to 100 (a drag is one undo step), double-click resets. */
function AdjustmentSlider({ label, value, onChange }: { label: string; value: number; onChange: (v: number, info: ChangeInfo) => void }) {
  const dragging = useRef(false);
  return (
    <label className={styles.adjustment}>
      <span className={styles.adjustmentLabel}>{label}</span>
      <input
        type="range"
        aria-label={label}
        className={styles.slider}
        min={-100}
        max={100}
        step={1}
        value={value}
        style={{ ["--fill" as string]: `${(value + 100) / 2}%` }}
        onPointerDown={() => (dragging.current = true)}
        onChange={(e) => onChange(Number(e.currentTarget.value), { final: !dragging.current, source: dragging.current ? "drag" : "step" })}
        onPointerUp={(e) => {
          dragging.current = false;
          onChange(Number(e.currentTarget.value), { final: true, source: "drag" });
        }}
        onDoubleClick={() => onChange(0, { final: true, source: "pick" })}
      />
    </label>
  );
}

/**
 * The picker's gradient stop, shared with the engine's on-canvas handles: the handles are on while the picker
 * shows a gradient of one layer; a stop picked on either side selects it on the other.
 */
function useGradientHandles(ed: EditorController, refs: readonly Guid[], field: PaintField | null, index: number, gradient: boolean): [number, (i: number) => void] {
  const [stop, setStop] = useState(0);
  const handles = useRef<ReturnType<typeof startGradientEdit>>(null);
  const ref = refs.length === 1 ? refs[0] : null;
  useEffect(() => {
    if (!gradient || !ref || !field) return;
    const h = startGradientEdit(ed.engine, ref, field, index);
    handles.current = h;
    const off = ed.engine.onAny((e) => {
      const ev = e as unknown as { type: string; active?: boolean; stop?: number };
      if (ev.type === "PAINT_EDIT" && ev.active && typeof ev.stop === "number") setStop(ev.stop);
    });
    return () => {
      off();
      handles.current = null;
      h?.end();
    };
  }, [ed, ref, field, index, gradient]);
  return [
    stop,
    (i: number) => {
      setStop(i);
      handles.current?.setStop(i);
    },
  ];
}

/** The one colour picker of the Design panel, for a paint of the selection, a Selection colors row, or the page. */
export function PaintPicker({ target, nodes, pageColor, onClose }: { target: PickerTarget; nodes: PanelNode[]; pageColor: Color | null; onClose: () => void }) {
  const ed = useEditor();
  const [model, setModel] = useState<ColorModel>("hex");
  useImageUrls(ed);
  // "On this page": read once when the picker opens.
  const documentColors = useMemo(() => pageColors(ed), [ed]);
  const refs = nodes.map((n) => n.guid);
  const field = target.kind === "paint" ? target.field : null;
  const index = target.kind === "paint" ? target.index : 0;
  const shared = field ? mixedPaints(nodes.map((n) => n[field] ?? [])) : undefined;
  const paints = (shared === undefined || isMixed(shared) ? null : [...shared]) as FullPaint[] | null;
  const paint = paints?.[index];
  const [stop, setStop] = useGradientHandles(ed, refs, field, index, !!paint && isGradientType(paint.type));

  if (target.kind === "page") {
    const color = pageColor ?? hexToColor("#f5f5f5");
    return (
      <ColorPicker
        value={{ type: "SOLID", color: { ...color, a: 1 }, opacity: color.a ?? 1 }}
        paintTypes={["SOLID"]}
        documentColors={documentColors}
        anchor={target.anchor}
        colorModel={model}
        onColorModelChange={setModel}
        onChange={(next, info) => ed.edit("Page colour", info, () => void ed.engine.setProps([target.page], { backgroundColor: { ...(next.color ?? color), a: next.opacity ?? 1 } }))}
        onCancel={() => ed.cancelEdit()}
        onClose={onClose}
      />
    );
  }
  if (target.kind === "colors") {
    const first = target.uses[0];
    const node = first ? ed.engine.readNode(first.guid) : null;
    const used = node && first ? (node[first.field]?.[first.index] as FullPaint | undefined) : undefined;
    if (!used) return null;
    const gradient = isGradientType(used.type);
    return (
      <ColorPicker
        value={toPicker(used)}
        paintTypes={gradient ? ["GRADIENT_LINEAR", "GRADIENT_RADIAL", "GRADIENT_ANGULAR", "GRADIENT_DIAMOND"] : ["SOLID"]}
        documentColors={documentColors}
        anchor={target.anchor}
        colorModel={model}
        onColorModelChange={setModel}
        onChange={(next, info) => (gradient ? writeGradientUses(ed, target.uses, next, info) : writeSelectionColor(ed, target.uses, { color: next.color, opacity: next.opacity }, info))}
        onCancel={() => ed.cancelEdit()}
        onClose={onClose}
      />
    );
  }
  if (!paints || !paint || !field) return null;
  const write = (next: FullPaint, info: ChangeInfo, label: string) => writePaints(ed, refs, field, paints.map((q, j) => (j === index ? next : q)), label, info);
  const label = field === "fillPaints" ? "Fill" : "Stroke";
  return (
    <ColorPicker
      value={toPicker(paint)}
      documentColors={documentColors}
      anchor={target.anchor}
      colorModel={model}
      onColorModelChange={setModel}
      stop={stop}
      onStopChange={setStop}
      imageUrl={ed.images.urlOf(paintImageHash(paint))}
      onChooseImage={ed.images.store ? () => void chooseImageFor(ed, (img) => write({ ...paint, ...img }, { final: true, source: "pick" }, "Choose image")) : undefined}
      imageControls={paint.type === "IMAGE" ? <ImageControls paint={paint} onChange={(next, info) => write(next, info, "Image adjustments")} /> : undefined}
      onChange={(next: PickerPaint, info) => {
        let out = fromPicker(paint, next);
        // A new image fill without an image yet: Figma asks for one (the picker's "Choose image…").
        if (next.type === "IMAGE" && paint.type !== "IMAGE" && !out.image) out = { ...out, opacity: 1 };
        write(out, info, `${label} colour`);
      }}
      onCancel={() => ed.cancelEdit()}
      onClose={onClose}
    />
  );
}

/** A gradient row of Selection colors edited: every use takes the new stops (each keeps its own handles). */
function writeGradientUses(ed: EditorController, uses: readonly PaintUse[], next: PickerPaint, info: ChangeInfo) {
  ed.edit("Selection colors", info, () => {
    const ids = [...new Set(uses.map((u) => u.guid))];
    const fresh = new Map(ed.engine.readNodes(ids).map((n) => [n.guid, n]));
    for (const [guid, f] of regradient(fresh, uses, { type: next.type, stops: next.stops, opacity: next.opacity, blendMode: next.blendMode })) ed.engine.setProps([guid], f);
  });
}
