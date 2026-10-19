/**
 * The Transform section in Motion mode (docs/motion.md §6.5), Figma's (docs/research/figma/live/2026-10-18/motion.txt;
 * the owner's capture figma-motion-rect-gizmo-panel.webp): in place of Design's Position — "Transform" with the Origin
 * button (Edit anchor point, ⌥R) at its right; Position "X→ 333.5 | Y↓ 277.5 | ◇" (the anchor's place in the parent: a
 * 369 × 253 rectangle at 149, 151 reads 333.5, 277.5) with Separate dimensions at its end on hover (an XY track split
 * into X and Y, or the two combined); Scale "↔ 100% | ↕ 100% | ◇" with Unlock scale aspect ratio; Rotation "0° | ◇".
 *
 * Position and Rotation write as Design's fields do in Motion (motionWrites.ts: the keyframe at the playhead, or the
 * base). Scale is motion-only (no node field): the panel reads it from the layer's tracks at the playhead and a change
 * lands on the keyframe at the playhead (added when missing), both axes with the aspect ratio locked.
 */
import { useState } from "react";
import { NumericInput, PanelSection, PropertyGrid, PropertyRow, ToggleIconButton, type ChangeInfo } from "@/ds";
import type { Guid } from "@/engine/codec";
import { useTool } from "@/engine/hooks";
import { t, useT } from "@/i18n";
import { fieldKey, type GuidString, type KeyframePropertyFieldName, type TimelineModel } from "@shared/motion/types";
import { groupChain } from "../../actions";
import { command, isEnabled, runEditorCommand, shortcutOf } from "../../commands";
import { useEditor, type EditorController } from "../../controller";
import { useUI } from "../../hooks";
import { fieldValue, mixedNumber } from "../../model/mixed";
import { IDENTITY, panelPosition, roundPanel, rotateTo, rotationOf, withPanelPosition } from "../../model/geometry";
import { exitToCanvas } from "../../panels/design/Sections";
import { isInstanceSublayer, type PanelNode } from "../../panels/design/shared";
import { motionRead, motionUi } from "../motionState";
import { trackValueAt } from "../timeline/maths";
import { MotionField, combinedState, useMotionStates } from "./MotionField";
import { motionPerLayer } from "./motionWrites";
import styles from "./MotionPanels.module.css";

/** The anchor as fractions of the size (TransformOrigin, absent = the middle; stored as fractions or percents). */
export function anchorOf(n: PanelNode): { x: number; y: number } {
  const o = (n as { transformOrigin?: { x?: unknown; y?: unknown } }).transformOrigin;
  const num = (v: unknown): number | null => (typeof v === "number" ? v : v && typeof v === "object" && typeof (v as { value?: unknown }).value === "number" ? (v as { value: number }).value : null);
  const frac = (v: number | null) => (v === null ? 0.5 : Math.abs(v) > 1.0001 ? v / 100 : v);
  return { x: frac(num(o?.x)), y: frac(num(o?.y)) };
}

/** The anchor's place in the parent (the panel's Position in Motion): the box's corner plus the turned anchor offset. */
export function anchorPosition(ed: EditorController, n: PanelNode): { x: number; y: number } {
  const m = n.transform ?? IDENTITY;
  const p = panelPosition(m, groupChain(ed, n));
  const a = anchorOf(n);
  const w = (n.size?.x ?? 0) * a.x;
  const h = (n.size?.y ?? 0) * a.y;
  return { x: p.x + m.m00 * w + m.m01 * h, y: p.y + m.m10 * w + m.m11 * h };
}

const SCALE_TRACKS: readonly KeyframePropertyFieldName[] = ["SCALE_XY", "SCALE_X", "SCALE_Y"];

/** A layer's scale at the playhead from its tracks (1, 1 without one). */
function scaleAt(model: TimelineModel | null, node: GuidString, timeUs: number): { x: number; y: number } {
  const layer = model?.layers.find((l) => l.node === node);
  const out = { x: 1, y: 1 };
  for (const tr of layer?.tracks ?? []) {
    if (tr.field.type !== "PROPERTY" || !SCALE_TRACKS.includes(tr.field.name)) continue;
    const v = trackValueAt(tr, timeUs);
    if (v?.type === "VECTOR") Object.assign(out, v.value);
    else if (v?.type === "FLOAT") out[tr.field.name === "SCALE_X" ? "x" : "y"] = v.value;
  }
  return out;
}

/** The scale typed: on each layer the keyframe at the playhead (added when missing) takes it — one undo step per edit. */
function setScale(ed: EditorController, refs: readonly Guid[], axis: "x" | "y", pct: number, locked: boolean, info: ChangeInfo) {
  const { timeUs } = motionUi(ed);
  const v = pct / 100;
  ed.edit("Scale", info, () => {
    for (const ref of refs) {
      const node = String(ref);
      const model = motionRead(() => ed.engine.motionTimeline(node), null);
      const layer = model?.layers.find((l) => l.node === node);
      const split = layer?.tracks.some((tr) => tr.field.type === "PROPERTY" && (tr.field.name === "SCALE_X" || tr.field.name === "SCALE_Y"));
      const now = scaleAt(model, node, timeUs);
      const next = locked ? { x: v * (axis === "x" ? 1 : now.x / (now.y || 1)), y: v * (axis === "y" ? 1 : now.y / (now.x || 1)) } : { ...now, [axis]: v };
      const names: KeyframePropertyFieldName[] = split ? ["SCALE_X", "SCALE_Y"] : ["SCALE_XY"];
      for (const name of names) {
        const field = { type: "PROPERTY" as const, name };
        const find = () => motionRead(() => ed.engine.motionTimeline(node), null)?.layers.find((l) => l.node === node)?.tracks.find((tr) => fieldKey(tr.field) === name)?.keyframes.find((k) => k.timeUs === timeUs);
        if (!find()) ed.engine.runMotionCommand("MOTION_ADD_KEYFRAME", { nodes: [node], field, timeUs });
        const k = find();
        if (!k) continue;
        const value = name === "SCALE_XY" ? { type: "VECTOR" as const, value: next } : { type: "FLOAT" as const, value: name === "SCALE_X" ? next.x : next.y };
        ed.engine.runMotionCommand("MOTION_SET_KEYFRAMES", { edits: [{ id: k.id, value }] });
      }
    }
  });
}

export function MotionTransformSection({ nodes }: { nodes: PanelNode[] }) {
  useT();
  const ed = useEditor();
  const labels = useUI((s) => s.propertyLabels);
  const timeUs = useUI((s) => s.motion?.timeUs ?? 0);
  const ctx = useMotionStates();
  const [scaleLocked, setScaleLocked] = useState(true);
  const anchorTool = useTool(ed.store) === "ANCHOR_POINT";
  const anchor = command("motion.anchor-point");
  const refs = nodes.map((n) => n.guid);
  const locked = nodes.some(isInstanceSublayer);
  const pos = nodes.map((n) => anchorPosition(ed, n));
  const x = mixedNumber(pos.map((p) => roundPanel(p.x)));
  const y = mixedNumber(pos.map((p) => roundPanel(p.y)));
  const rotation = mixedNumber(nodes.map((n) => roundPanel(rotationOf(n.transform ?? IDENTITY))));
  const scales = nodes.map((n) => scaleAt(motionRead(() => ed.engine.motionTimeline(String(n.guid)), null), String(n.guid), timeUs));
  const sx = mixedNumber(scales.map((s) => roundPanel(s.x * 100)));
  const sy = mixedNumber(scales.map((s) => roundPanel(s.y * 100)));
  // X / Y written as the anchor's place: the base's corner moved by the same change.
  const axisOf = (a: "x" | "y") => (n: PanelNode) => anchorPosition(ed, n)[a];
  const moveTo = (a: "x" | "y") => (n: PanelNode, v: number) => {
    const off = anchorPosition(ed, n)[a] - panelPosition(n.transform ?? IDENTITY, groupChain(ed, n))[a];
    return { transform: withPanelPosition(n.transform ?? IDENTITY, groupChain(ed, n), a === "x" ? v - off : null, a === "y" ? v - off : null) };
  };
  const axis = (a: "x" | "y") => motionPerLayer(ed, "Position", refs, axisOf(a), moveTo(a), a, exitToCanvas(ed));
  const rotate = motionPerLayer(ed, "Rotate", refs, (n) => rotationOf(n.transform ?? IDENTITY), (n, deg) => (n.size ? { transform: rotateTo(n.transform ?? IDENTITY, n.size, deg) } : null), "rotation", exitToCanvas(ed));
  // Separate dimensions: the selection's Position split into X and Y tracks, or the two combined (round 8i's commands).
  const state = (name: KeyframePropertyFieldName) => (ctx ? combinedState(ctx.states, ctx.refs, name).state : "none");
  const separated = state("TRANSLATION_X") !== "none" || state("TRANSLATION_Y") !== "none";
  const canSeparate = separated || state("TRANSLATION_XY") !== "none";
  const separate = () => {
    try {
      for (const ref of refs) ed.engine.runMotionCommand(separated ? "MOTION_COMBINE_TRACKS" : "MOTION_SPLIT_TRACKS", { node: String(ref), kind: "POSITION" });
    } catch {
      // The engine's Motion commands not built in this wasm.
    }
  };
  const scaleProps = (a: "x" | "y") => ({
    onChange: (v: number, info: ChangeInfo) => setScale(ed, refs, a, v, scaleLocked, info),
    onStep: (d: number) => {
      const now = a === "x" ? sx : sy;
      setScale(ed, refs, a, (typeof now === "number" ? now : 100) + d, scaleLocked, { final: true, source: "step" });
    },
    onCancel: () => ed.cancelEdit(),
    onExit: exitToCanvas(ed),
  });
  return (
    <PanelSection
      title={t("Transform")}
      data-motion-transform
      actions={
        <ToggleIconButton
          icon="24.transform-origin"
          label={t("Origin")}
          shortcut={shortcutOf(command("object.rotation-origin"))}
          tone="secondary"
          disabled={!anchorTool && !isEnabled(ed, anchor)}
          pressed={anchorTool}
          onPressedChange={() => runEditorCommand(ed, "motion.anchor-point")}
          data-anchor-point
        />
      }
    >
      <PropertyGrid labels={labels}>
        <PropertyRow
          label={t("Position")}
          span={2}
          data-motion-row="position"
          action={<ToggleIconButton icon="24.separate-dimensions" label={separated ? t("Combine dimensions") : t("Separate dimensions")} tone="secondary" className={styles.hoverAction} disabled={!canSeparate || locked} pressed={separated} onPressedChange={separate} />}
        >
          <MotionField field="TRANSLATION_XY">
            <NumericInput label={t("X-position")} prefix="X→" prefixTone="primary" disabled={locked} value={fieldValue(x)} {...axis("x")} />
            <NumericInput label={t("Y-position")} prefix="Y↓" prefixTone="primary" disabled={locked} value={fieldValue(y)} {...axis("y")} />
          </MotionField>
        </PropertyRow>
        <PropertyRow
          label={t("Scale")}
          span={2}
          data-motion-row="scale"
          action={<ToggleIconButton icon="24.constrain-proportions" label={scaleLocked ? t("Unlock scale aspect ratio") : t("Lock scale aspect ratio")} tone="secondary" pressed={scaleLocked} onPressedChange={setScaleLocked} />}
        >
          <MotionField field="SCALE_XY">
            <NumericInput label={t("Scale X")} prefix="24.scale-x" unit="%" precision={0} min={0} disabled={locked} value={fieldValue(sx)} {...scaleProps("x")} />
            <NumericInput label={t("Scale Y")} prefix="24.scale-y" unit="%" precision={0} min={0} disabled={locked} value={fieldValue(sy)} {...scaleProps("y")} />
          </MotionField>
        </PropertyRow>
        <PropertyRow label={t("Rotation")} data-motion-row="rotation">
          <MotionField field="ROTATION">
            <NumericInput label={t("Rotation")} prefix="24.rotation" unit="°" disabled={locked} value={fieldValue(rotation)} min={-360} max={360} bigStep={15} {...rotate} />
          </MotionField>
          <span />
        </PropertyRow>
      </PropertyGrid>
    </PanelSection>
  );
}

