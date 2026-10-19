/**
 * The right panel's **Easing** page in Motion mode (docs/motion.md §6.14; Figma's, 2026-10-18/motion-easing.txt and
 * the owner's capture owner-2026-10-19/figma-motion-easing-panel.webp). Clicking a keyframe segment in the timeline
 * selects it (⇧ adds more) and the right panel replaces the layer's sections with this page, under the layer header:
 *
 * - **Back** and the "Easing" title (Back: the segments unselected, the layer's sections again);
 * - the **preset select** (the curve's glyph and its name — "Custom bezier" / "Custom spring" when custom, "Mixed" when
 *   the segments differ, the variable's name when one is applied) opening the presets popover (EasingPresets.tsx);
 * - **Curve | Spring** ("Easing type"): the other kind's custom easing, from the current one;
 * - the **graph** (EasingGraph.tsx): the bezier's two handles dragged, or the spring's knob;
 * - the **value row**: Curve — the Bezier field "x1, y1, x2, y2" and **Flip curve**; Spring — **Bounce** (0–1, our
 *   normalised spring: its length is the segment's, §4.7).
 *
 * Every selected segment takes the change together (MOTION_SET_EASING on all their end keyframes), one undo step per
 * change — a handle's drag inside one transaction. An applied Easing variable shows by name with Detach; editing the
 * curve writes a value (detaching it).
 */
import { useEffect, useMemo, useRef, useState } from "react";
import { IconButton, Icon, NumericInput, SegmentedControl, TextInput, isMixed, MIXED } from "@/ds";
import { t, useT } from "@/i18n";
import { bezierOf } from "@shared/motion/easing";
import { EASING_LABELS, type EasingRef, type GuidString, type MotionEasing } from "@shared/motion/types";
import { useEditor } from "../../controller";
import { useLocalAssets, useTopics, useUI } from "../../hooks";
import { timelineModel } from "../audio/audioEdits";
import { motionRead, setMotionUi } from "../motionState";
import { createEasingVariable, easingOfType } from "./EasingEditor";
import { EasingGraph } from "./EasingGraph";
import { EasingPresets, PresetGlyph } from "./EasingPresets";
import { bezierText, flipEasing, isSpring, parseBezierText, segmentTargets, sharedEasing, type SegmentTarget } from "./easingMaths";
import styles from "./EasingPage.module.css";

/** The selected segments on the selected layers (none: the layer's own sections show). */
export function useEasingSegments(nodes: readonly { guid: GuidString }[]): SegmentTarget[] {
  const ed = useEditor();
  const ids = useUI((s) => s.motion?.selectedSegments);
  const on = useUI((s) => s.mode === "motion");
  const version = useTopics(ed.store, ["undo", "selection"]);
  const [motionVersion, setMotionVersion] = useState(0);
  useEffect(() => ed.engine.on("MOTION_CHANGED", () => setMotionVersion((v) => v + 1)), [ed]);
  const key = nodes.map((n) => n.guid).join(",");
  return useMemo(() => {
    void version;
    void motionVersion;
    if (!on || !ids?.length) return [];
    return segmentTargets(timelineModel(ed), ids, new Set(key.split(",")));
  }, [ed, on, ids, key, version, motionVersion]);
}

export function EasingPage({ targets }: { targets: SegmentTarget[] }) {
  useT();
  const ed = useEditor();
  const assets = useLocalAssets();
  const timeUs = useUI((s) => s.motion?.timeUs ?? 0);
  const value = sharedEasing(targets);
  const bound = value && !isMixed(value) && "variable" in value ? value.variable : null;
  // What the page shows: the easing (a bound one's value), or null while Mixed.
  const current: MotionEasing | null = !value || isMixed(value) ? null : "variable" in value ? targets[0].easing : value;
  const kinds = new Set(targets.map((tg) => (isSpring(tg.easing) ? "spring" : "bezier")));
  const kind: "bezier" | "spring" = kinds.has("spring") && !kinds.has("bezier") ? "spring" : "bezier";
  const [presetsAt, setPresetsAt] = useState<HTMLElement | null>(null);
  const [hovered, setHovered] = useState<MotionEasing | null>(null);
  const ids = targets.map((tg) => tg.id);

  // One undo step per change: a drag's moves inside one transaction, committed on release.
  const dragging = useRef(false);
  const apply = (easing: EasingRef, commit: boolean) => {
    const run = () => motionRead(() => ed.engine.runMotionCommand("MOTION_SET_EASING", { ids, easing }), 0);
    if (!commit && !dragging.current) {
      ed.engine.txnBegin("Change easing");
      dragging.current = true;
    }
    run();
    if (commit && dragging.current) {
      ed.engine.txnCommit();
      dragging.current = false;
    }
  };
  useEffect(
    () => () => {
      if (dragging.current && !ed.engine.destroyed) ed.engine.txnCommit();
    },
    [ed]
  );

  // The playhead's place in the first segment (Figma's vertical guide), when it is inside it.
  const first = targets[0];
  const span = first ? first.endUs - first.startUs : 0;
  const playhead = first && span > 0 && timeUs >= first.startUs && timeUs <= first.endUs ? (timeUs - first.startUs) / span : null;

  const bezier = current ? bezierOf(current) : null;
  const variableName = bound ? (assets.lookup.variable(bound)?.name ?? t("Missing variable")) : null;
  const label = !current ? t("Mixed") : variableName ?? t(EASING_LABELS[current.type]);
  const create = () => {
    const id = createEasingVariable(ed, assets.collections[0]?.id ?? null, current ?? (kind === "spring" ? { type: "GENTLE" } : { type: "LINEAR" }));
    if (id) apply({ variable: id }, true);
  };
  return (
    <div className={styles.page} data-easing-page>
      <div className={styles.title}>
        <IconButton icon="24.chevron.left" label={t("Back")} tooltip={false} data-easing-back onClick={() => setMotionUi(ed, { selectedSegments: [] })} />
        <h2 className={styles.heading}>{t("Easing")}</h2>
      </div>
      <div className={styles.body}>
        <div className={styles.selectRow}>
          <button type="button" className={styles.select} aria-haspopup="dialog" aria-expanded={!!presetsAt} aria-label={t("Easing presets")} data-easing-select={current?.type ?? "MIXED"} data-bound={bound ?? undefined} onClick={(e) => setPresetsAt(presetsAt ? null : e.currentTarget)}>
            {bound ? <Icon name="16.easing" className={styles.selectIcon} /> : <PresetGlyph type={current?.type ?? "CUSTOM_CUBIC_BEZIER"} easing={current ?? undefined} always />}
            <span className={styles.selectLabel}>{label}</span>
            <Icon name="24.chevron.down" className={styles.selectChevron} />
          </button>
          {bound && <IconButton icon="24.detach.small" label={t("Detach variable")} tone="secondary" data-easing-detach onClick={() => current && apply(current, true)} />}
        </div>
        <SegmentedControl
          label={t("Easing type")}
          fullWidth
          value={kinds.size > 1 ? MIXED : kind}
          options={[{ value: "bezier", label: t("Curve") }, { value: "spring", label: t("Spring") }]}
          onChange={(v) => {
            if (v === kind && kinds.size === 1) return;
            const from = current ?? { type: v === "spring" ? "GENTLE" : "LINEAR" };
            apply(easingOfType(v === "spring" ? "CUSTOM_SPRING" : "CUSTOM_CUBIC_BEZIER", from), true);
          }}
        />
        <EasingGraph easing={current} kind={kind} preview={hovered} playhead={playhead} onChange={apply} />
        {kind === "spring" ? (
          <NumericInput
            label={t("Bounce")}
            prefix="24.easing.bounce"
            className={styles.valueField}
            data-easing-bounce
            min={0}
            max={1}
            step={0.01}
            precision={2}
            value={!current ? MIXED : current.type === "CUSTOM_SPRING" ? (current.easingFunctionSpring?.bounce ?? 0.25) : presetBounce(current)}
            onChange={(v, info) => apply({ type: "CUSTOM_SPRING", easingFunctionSpring: { bounce: Math.min(1, Math.max(0, Math.round(v * 100) / 100)) } }, info.final)}
          />
        ) : (
          <div className={styles.valueRow}>
            <TextInput
              label={t("Bezier")}
              prefix="24.easing.bezier"
              className={styles.valueField}
              data-easing-bezier
              value={!current ? MIXED : bezier && current.type !== "HOLD" ? bezierText(bezier) : ""}
              placeholder="x1, y1, x2, y2"
              disabled={current?.type === "HOLD"}
              onCommit={(text) => {
                const b = parseBezierText(text);
                if (b) apply({ type: "CUSTOM_CUBIC_BEZIER", easingFunctionCubicBezier: { x1: b[0], y1: b[1], x2: b[2], y2: b[3] } }, true);
              }}
            />
            <IconButton
              icon="24.easing.flip"
              label={t("Flip curve")}
              data-easing-flip
              disabled={!current || !bezier || current.type === "HOLD"}
              onClick={() => {
                const f = current && flipEasing(current);
                if (f) apply(f, true);
              }}
            />
          </div>
        )}
      </div>
      {presetsAt && (
        <EasingPresets
          anchor={presetsAt}
          current={bound ? null : current}
          kind={kind}
          bound={bound}
          consumer={first?.node ?? null}
          onPick={(e) => apply(e, true)}
          onHover={setHovered}
          onBind={(id) => apply({ variable: id }, true)}
          onCreate={create}
          onClose={() => setPresetsAt(null)}
        />
      )}
    </div>
  );
}

/** A spring preset's bounce as shown (clamp(1 − ζ, 0, 1) of SPRING_PRESETS, as the Easing popover shows them). */
const PRESET_BOUNCE: Partial<Record<MotionEasing["type"], number>> = { GENTLE: 0.25, QUICK: 0.42, BOUNCY: 0.69, SLOW: 0 };
const presetBounce = (e: MotionEasing): number => PRESET_BOUNCE[e.type] ?? 0.25;
