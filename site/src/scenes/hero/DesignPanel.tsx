// The Design panel of the hero's editor, drawn with the app's ds components and reading and writing the live engine:
// Position, Layout (auto layout's flow, sizes, alignment, gap and padding), Appearance, Fill, Stroke, Effects, Export —
// Figma UI3's sections, in its words. (The app's own DesignPanel needs the whole EditorController; this is the same
// panel's shape over the engine's flat API.)
import { useState } from "react";
import { AlignmentMatrix, type Alignment, type AxisAlign, type PrimaryAlign } from "@/ds/components/AlignmentMatrix";
import { IconButton, ToggleIconButton } from "@/ds/components/Button";
import { ColorInput } from "@/ds/components/ColorInput";
import { ColorPicker } from "@/ds/components/ColorPicker";
import { NumericInput } from "@/ds/components/NumericInput";
import { PanelSection } from "@/ds/components/PanelSection";
import { PropertyGrid, PropertyRow } from "@/ds/components/PropertyGrid";
import { SegmentedControl } from "@/ds/components/SegmentedControl";
import { MIXED, type ChangeInfo } from "@/ds/types";
import { hexToRgba, rgbToHex } from "@/ds/util/color";
import type { Color, NodeChange, Paint } from "@/engine/codec";
import type { EngineStore } from "@/engine/EngineStore";
import { useNode, useSelection } from "@/engine/hooks";
import { write } from "../engine/write";

const round = (n: number) => Math.round(n * 100) / 100;
export const hexOf = (c: Color | undefined) => (c ? rgbToHex(c) : "#000000");
export const colorOf = (hex: string): Color => {
  const c = hexToRgba(hex) ?? { r: 0, g: 0, b: 0, a: 1 };
  return { r: c.r, g: c.g, b: c.b, a: 1 };
};

const TYPE_TITLE: Record<string, string> = { FRAME: "Frame", TEXT: "Text", ELLIPSE: "Ellipse", ROUNDED_RECTANGLE: "Rectangle", RECTANGLE: "Rectangle", LINE: "Line", VECTOR: "Vector", STAR: "Star", REGULAR_POLYGON: "Polygon" };

export function DesignPanel({ store, pageColor }: { store: EngineStore | null; pageColor: string }) {
  if (!store) return <PageSection color={pageColor} />;
  return <LiveDesign store={store} pageColor={pageColor} />;
}

function PageSection({ color, onColor }: { color: string; onColor?: (hex: string) => void }) {
  return (
    <>
      <PanelSection title="Page">
        <PropertyGrid>
          <PropertyRow span={2} action={<IconButton icon="24.eye.small" label="Hide fill" tone="secondary" />}>
            <ColorInput label="Background" color={color} opacity={100} onColor={(hex) => onColor?.(hex)} onOpacity={() => {}} />
          </PropertyRow>
        </PropertyGrid>
      </PanelSection>
      <PanelSection title="Local variables" empty actions={<IconButton icon="24.plus.small" label="Create variable" tone="secondary" />} />
      <PanelSection title="Styles" empty actions={<IconButton icon="24.plus.small" label="Create style" tone="secondary" />} />
      <PanelSection title="Export" empty actions={<IconButton icon="24.plus.small" label="Add export settings" tone="secondary" />} />
    </>
  );
}

function LiveDesign({ store, pageColor }: { store: EngineStore; pageColor: string }) {
  const selection = useSelection(store);
  const first = selection.refs[0] ?? null;
  const node = useNode(store, first);
  if (!first || !node) return <PageSection color={pageColor} />;
  if (selection.refs.length > 1) return <MultiSection count={selection.refs.length} />;
  return <NodeSections store={store} node={node} />;
}

function MultiSection({ count }: { count: number }) {
  return (
    <>
      <PanelSection title="Position">
        <PropertyGrid>
          <PropertyRow>
            <NumericInput label="X-position" prefix="X" prefixTone="primary" value={MIXED} onChange={() => {}} />
            <NumericInput label="Y-position" prefix="Y" prefixTone="primary" value={MIXED} onChange={() => {}} />
          </PropertyRow>
        </PropertyGrid>
      </PanelSection>
      <PanelSection title={`${count} layers`} empty />
    </>
  );
}

function NodeSections({ store, node }: { store: EngineStore; node: NodeChange }) {
  const engine = store.engine;
  const refs = [node.guid];
  const set = (fields: Parameters<typeof write>[2], label: string, info?: ChangeInfo) => write(engine, refs, fields, label, info);
  const t = node.transform ?? { m00: 1, m01: 0, m02: 0, m10: 0, m11: 1, m12: 0 };
  const size = node.size ?? { x: 0, y: 0 };
  const rotation = round((-Math.atan2(t.m10, t.m00) * 180) / Math.PI);
  const isFrame = node.type === "FRAME";
  const auto = node.stackMode === "HORIZONTAL" || node.stackMode === "VERTICAL" ? node.stackMode : null;

  const setRotation = (deg: number, info: ChangeInfo) => {
    const r = (-deg * Math.PI) / 180;
    const cos = Math.cos(r);
    const sin = Math.sin(r);
    const cx = t.m00 * (size.x / 2) + t.m01 * (size.y / 2) + t.m02;
    const cy = t.m10 * (size.x / 2) + t.m11 * (size.y / 2) + t.m12;
    set({ transform: { m00: cos, m01: -sin, m10: sin, m11: cos, m02: cx - (cos * size.x) / 2 + (sin * size.y) / 2, m12: cy - (sin * size.x) / 2 - (cos * size.y) / 2 } }, "Rotation", info);
  };

  // Hug / Fixed for an auto layout frame's W and H; typing a size fixes it (as Figma does)
  const hugging = (axis: "x" | "y") => {
    if (!auto) return false;
    const primary = (auto === "HORIZONTAL") === (axis === "x");
    const sizing = primary ? node.stackPrimarySizing : node.stackCounterSizing;
    return sizing === undefined || sizing === "RESIZE_TO_FIT_WITH_IMPLICIT_SIZE" || sizing === "RESIZE_TO_FIT";
  };
  const fixing = (axis: "x" | "y") => {
    if (!hugging(axis)) return {};
    const primary = (auto === "HORIZONTAL") === (axis === "x");
    return primary ? { stackPrimarySizing: "FIXED" as const } : { stackCounterSizing: "FIXED" as const };
  };
  const setSize = (axis: "x" | "y", v: number, info: ChangeInfo) => set({ ...fixing(axis), size: axis === "x" ? { x: Math.max(0.01, v), y: size.y } : { x: size.x, y: Math.max(0.01, v) } }, axis === "x" ? "Width" : "Height", info);

  const fills = (node.fillPaints ?? []) as Paint[];
  const strokes = (node.strokePaints ?? []) as Paint[];
  const radius = node.cornerRadius ?? 0;
  const hasRadius = node.type === "FRAME" || node.type === "ROUNDED_RECTANGLE" || node.type === "RECTANGLE";

  return (
    <>
      <PanelSection title={TYPE_TITLE[node.type ?? ""] ?? "Layer"} pad="none" />
      <PanelSection title="Position">
        <PropertyGrid labels>
          <PropertyRow label="Position">
            <NumericInput label="X-position" prefix="X" prefixTone="primary" value={round(t.m02)} onChange={(v, info) => set({ transform: { ...t, m02: v } }, "X", info)} />
            <NumericInput label="Y-position" prefix="Y" prefixTone="primary" value={round(t.m12)} onChange={(v, info) => set({ transform: { ...t, m12: v } }, "Y", info)} />
          </PropertyRow>
          <PropertyRow label="Rotation">
            <NumericInput label="Rotation" prefix="24.rotation" unit="°" min={-360} max={360} value={rotation} onChange={setRotation} />
          </PropertyRow>
        </PropertyGrid>
      </PanelSection>
      <PanelSection title={auto ? "Auto layout" : "Layout"}>
        <PropertyGrid labels>
          {isFrame && (
            <PropertyRow label="Flow" span={2}>
              <SegmentedControl
                label="Layout"
                fullWidth
                value={auto ?? "NONE"}
                options={[
                  { value: "NONE", icon: "24.layout.freeform", tooltip: "Freeform" },
                  { value: "VERTICAL", icon: "24.layout.vertical", tooltip: "Vertical" },
                  { value: "HORIZONTAL", icon: "24.layout.horizontal", tooltip: "Horizontal" },
                  { value: "GRID", icon: "24.layout.grid", tooltip: "Grid", disabled: true },
                ]}
                onChange={(v) => set(v === "NONE" ? { stackMode: "NONE" } : { stackMode: v as "HORIZONTAL" | "VERTICAL", stackSpacing: node.stackSpacing ?? 10 }, "Auto layout")}
              />
            </PropertyRow>
          )}
          <PropertyRow label="Dimensions" action={<ToggleIconButton icon="24.constrain-proportions" label="Constrain proportions" tone="secondary" pressed={false} onPressedChange={() => {}} />}>
            <NumericInput label="Width" prefix="W" value={round(size.x)} min={0.01} modeLabel={hugging("x") ? "Hug" : node.stackChildPrimaryGrow ? "Fill" : undefined} dimValue={hugging("x")} onChange={(v, info) => setSize("x", v, info)} />
            <NumericInput label="Height" prefix="H" value={round(size.y)} min={0.01} modeLabel={hugging("y") ? "Hug" : undefined} dimValue={hugging("y")} onChange={(v, info) => setSize("y", v, info)} />
          </PropertyRow>
          {auto && (
            <>
              <PropertyRow labels={["Alignment", "Gap"]}>
                <AlignmentMatrix
                  direction={auto === "HORIZONTAL" ? "horizontal" : "vertical"}
                  value={{ primary: (node.stackPrimaryAlignItems === "SPACE_BETWEEN" ? "SPACE_BETWEEN" : node.stackPrimaryAlignItems ?? "MIN") as PrimaryAlign, counter: ((node.stackCounterAlignItems as AxisAlign | undefined) ?? "MIN") as AxisAlign }}
                  onChange={(a: Alignment) => set({ stackPrimaryAlignItems: a.primary, stackCounterAlignItems: a.counter }, "Alignment")}
                />
                <NumericInput
                  label="Gap"
                  prefix={auto === "HORIZONTAL" ? "24.al.spacing-horizontal" : "24.al.spacing-vertical"}
                  value={node.stackSpacing ?? 0}
                  min={0}
                  data-field="gap"
                  valueLabel={node.stackPrimaryAlignItems === "SPACE_BETWEEN" ? "Auto" : undefined}
                  onChange={(v, info) => set({ stackSpacing: v, ...(node.stackPrimaryAlignItems === "SPACE_BETWEEN" ? { stackPrimaryAlignItems: "MIN" } : {}) }, "Gap", info)}
                  onFocusChange={(f) => engine.setSpacingHighlight(f ? 1 : 0)}
                />
              </PropertyRow>
              <PropertyRow label="Padding">
                <NumericInput label="Horizontal padding" prefix="24.al.padding-horizontal" min={0} value={node.stackHorizontalPadding ?? 0} onChange={(v, info) => set({ stackHorizontalPadding: v, stackPaddingRight: v }, "Padding", info)} onFocusChange={(f) => engine.setSpacingHighlight(f ? 2 : 0)} />
                <NumericInput label="Vertical padding" prefix="24.al.padding-vertical" min={0} value={node.stackVerticalPadding ?? 0} onChange={(v, info) => set({ stackVerticalPadding: v, stackPaddingBottom: v }, "Padding", info)} onFocusChange={(f) => engine.setSpacingHighlight(f ? 2 : 0)} />
              </PropertyRow>
            </>
          )}
        </PropertyGrid>
      </PanelSection>
      <PanelSection title="Appearance">
        <PropertyGrid labels>
          <PropertyRow labels={["Opacity", hasRadius ? "Corner radius" : undefined]}>
            <NumericInput label="Opacity" prefix="24.opacity" unit="%" precision={0} min={0} max={100} value={Math.round((node.opacity ?? 1) * 100)} onChange={(v, info) => set({ opacity: v / 100 }, "Opacity", info)} />
            {hasRadius ? (
              <NumericInput
                label="Corner radius"
                prefix="24.corners"
                min={0}
                value={round(radius)}
                onChange={(v, info) => set({ cornerRadius: v, rectangleTopLeftCornerRadius: v, rectangleTopRightCornerRadius: v, rectangleBottomLeftCornerRadius: v, rectangleBottomRightCornerRadius: v }, "Corner radius", info)}
              />
            ) : (
              <span />
            )}
          </PropertyRow>
        </PropertyGrid>
      </PanelSection>
      <Paints title="Fill" field="fillPaints" paints={fills} set={set} />
      <Paints title="Stroke" field="strokePaints" paints={strokes} set={set} />
      <PanelSection title="Effects" empty actions={<IconButton icon="24.plus.small" label="Add effect" tone="secondary" />} />
      <PanelSection title="Export" empty actions={<IconButton icon="24.plus.small" label="Add export settings" tone="secondary" />} />
    </>
  );
}

function Paints({ title, field, paints, set }: { title: string; field: "fillPaints" | "strokePaints"; paints: Paint[]; set: (fields: Record<string, unknown>, label: string, info?: ChangeInfo) => void }) {
  const [open, setOpen] = useState<{ index: number; anchor: DOMRect } | null>(null);
  const write = (next: Paint[], info?: ChangeInfo) => set({ [field]: next }, title, info);
  const add = () => write([...paints, { type: "SOLID", color: { r: 0xd9 / 255, g: 0xd9 / 255, b: 0xd9 / 255, a: 1 }, opacity: 1, visible: true }]);
  const solid = paints.map((p, i) => [p, i] as const).filter(([p]) => p.type === "SOLID");
  const editing = open ? paints[open.index] : null;
  return (
    <PanelSection title={title} empty={!paints.length} actions={<IconButton icon="24.plus.small" label={`Add ${title.toLowerCase()}`} tone="secondary" onClick={add} />}>
      {solid.length > 0 && (
        <PropertyGrid>
          {solid
            .slice()
            .reverse()
            .map(([p, i]) => (
              <PropertyRow
                key={i}
                span={2}
                action={<IconButton icon="24.minus.small" label={`Remove ${title.toLowerCase()}`} tone="secondary" onClick={() => write(paints.filter((_, j) => j !== i))} />}
              >
                <ColorInput
                  label={title}
                  data-paint={field}
                  color={hexOf(p.color)}
                  opacity={Math.round((p.opacity ?? 1) * 100)}
                  onColor={(hex, info) => write(paints.map((q, j) => (j === i ? { ...q, color: colorOf(hex) } : q)), info)}
                  onOpacity={(o, info) => write(paints.map((q, j) => (j === i ? { ...q, opacity: o / 100 } : q)), info)}
                  onSwatchClick={(anchor) => setOpen({ index: i, anchor })}
                />
              </PropertyRow>
            ))}
        </PropertyGrid>
      )}
      {open && editing && (
        <ColorPicker
          value={editing as never}
          anchor={open.anchor}
          paintTypes={["SOLID"]}
          onChange={(next: Paint, info: ChangeInfo) => write(paints.map((q, j) => (j === open.index ? { ...q, color: next.color, opacity: next.opacity } : q)), info)}
          onClose={() => setOpen(null)}
        />
      )}
    </PanelSection>
  );
}
