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
 *
 * The same controls (`EasingControls`) are every easing editor's since 2026-10-19 — a preset clip's Easing (its page,
 * AnimationsSection.tsx `ClipEasingPage`), Social's timeline segments (this page in Social's Design part) and an Easing
 * variable's value (ValueEditor.tsx, without the variable binding); the old floating Easing popover is gone.
 */
import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { IconButton, Icon, NumericInput, SegmentedControl, TextInput, isMixed, MIXED, showToast } from "@/ds";
import { t, useT } from "@/i18n";
import { bezierOf } from "@shared/motion/easing";
import { EASING_LABELS, type EasingRef, type GuidString, type MotionEasing } from "@shared/motion/types";
import { useEditor, type EditorController } from "../../controller";
import { useLocalAssets, useTopics, useUI } from "../../hooks";
import { timelineModel } from "../audio/audioEdits";
import { motionRead, setMotionUi } from "../motionState";
import { createCollection, createVariable } from "../../variables";
import { EasingGraph } from "./EasingGraph";
import { EasingPresets, PresetGlyph } from "./EasingPresets";
import { PRESET_BOUNCE, bezierText, easingOfType, flipEasing, isSpring, parseBezierText, segmentTargets, sharedEasing, type EasingValue, type SegmentTarget } from "./easingMaths";
import styles from "./EasingPage.module.css";

/** The selected segments on the selected layers (none: the layer's own sections show). */
export function useEasingSegments(nodes: readonly { guid: GuidString }[]): SegmentTarget[] {
  const ed = useEditor();
  const ids = useUI((s) => s.motion?.selectedSegments);
  // Motion, and Social (docs/social.md §8: its timeline is the same; the page shows in its Design part).
  const on = useUI((s) => s.mode === "motion" || s.mode === "social");
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

/**
 * A change written as one undo step (`label`): a drag's moves (`commit` false) inside one transaction, committed on
 * release; a pick, a typed value or a click its own step.
 */
export function useEasingTransaction(write: (easing: EasingRef) => void, label = "Change easing"): (easing: EasingRef, commit: boolean) => void {
  const ed = useEditor();
  const dragging = useRef(false);
  useEffect(
    () => () => {
      if (dragging.current && !ed.engine.destroyed) ed.engine.txnCommit();
    },
    [ed]
  );
  return (easing, commit) => {
    if (!commit && !dragging.current) {
      ed.engine.txnBegin(label);
      dragging.current = true;
    }
    write(easing);
    if (commit && dragging.current) {
      ed.engine.txnCommit();
      dragging.current = false;
    }
  };
}

/** The page's frame: Back and the centred "Easing" title over the controls. */
export function EasingFrame({ onBack, owner, children }: { onBack(): void; owner?: string; children: ReactNode }) {
  useT();
  return (
    <div className={styles.page} data-easing-page={owner ?? "segments"}>
      <div className={styles.title}>
        <IconButton icon="24.chevron.left" label={t("Back")} tooltip={false} data-easing-back onClick={onBack} />
        <h2 className={styles.heading}>{t("Easing")}</h2>
      </div>
      {children}
    </div>
  );
}

/** The selected segments' Easing page. */
export function EasingPage({ targets }: { targets: SegmentTarget[] }) {
  const ed = useEditor();
  const timeUs = useUI((s) => s.motion?.timeUs ?? 0);
  const ids = targets.map((tg) => tg.id);
  const apply = useEasingTransaction((easing) => motionRead(() => ed.engine.runMotionCommand("MOTION_SET_EASING", { ids, easing }), 0));
  // The playhead's place in the first segment (Figma's vertical guide), when it is inside it.
  const first = targets[0];
  const span = first ? first.endUs - first.startUs : 0;
  const playhead = first && span > 0 && timeUs >= first.startUs && timeUs <= first.endUs ? (timeUs - first.startUs) / span : null;
  return (
    <EasingFrame onBack={() => setMotionUi(ed, { selectedSegments: [] })}>
      <EasingControls values={targets} onChange={apply} playhead={playhead} consumer={first?.node ?? null} />
    </EasingFrame>
  );
}

export interface EasingControlsProps {
  /** The easings edited together (several: "Mixed" while they differ) */
  values: readonly EasingValue[];
  /** A change: `commit` false for a handle's or Bounce's every move, true on release and for a pick, a typed value, a click */
  onChange(easing: EasingRef, commit: boolean): void;
  /** The playhead's place in it (0–1): the graph's vertical guide; null outside it */
  playhead?: number | null;
  /** The layer the Libraries' variables show their values for */
  consumer?: string | null;
  /** Offer the EASING variables (Detach, the Libraries tab, New variable); off: a variable's own value */
  variables?: boolean;
}

/** The page's controls: the preset select (and its popover), Curve | Spring, the graph, Bezier + Flip curve or Bounce. */
export function EasingControls({ values, onChange: apply, playhead = null, consumer = null, variables = true }: EasingControlsProps) {
  useT();
  const ed = useEditor();
  const assets = useLocalAssets();
  const value = sharedEasing(values);
  const bound = value && !isMixed(value) && "variable" in value ? value.variable : null;
  // What the page shows: the easing (a bound one's value), or null while Mixed.
  const current: MotionEasing | null = !value || isMixed(value) ? null : "variable" in value ? values[0].easing : value;
  const kinds = new Set(values.map((v) => (isSpring(v.easing) ? "spring" : "bezier")));
  const kind: "bezier" | "spring" = kinds.has("spring") && !kinds.has("bezier") ? "spring" : "bezier";
  const [presetsAt, setPresetsAt] = useState<HTMLElement | null>(null);
  const [hovered, setHovered] = useState<MotionEasing | null>(null);

  const bezier = current ? bezierOf(current) : null;
  const variableName = bound ? (assets.lookup.variable(bound)?.name ?? t("Missing variable")) : null;
  const label = !current ? t("Mixed") : variableName ?? t(EASING_LABELS[current.type]);
  const create = () => {
    const id = createEasingVariable(ed, assets.collections[0]?.id ?? null, current ?? (kind === "spring" ? { type: "GENTLE" } : { type: "LINEAR" }));
    if (id) apply({ variable: id }, true);
  };
  return (
    <>
      <div className={styles.body} data-easing-controls>
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
          consumer={consumer}
          variables={variables}
          onPick={(e) => apply(e, true)}
          onHover={setHovered}
          onBind={(id) => apply({ variable: id }, true)}
          onCreate={create}
          onClose={() => setPresetsAt(null)}
        />
      )}
    </>
  );
}

/**
 * A new Easing variable holding `value`, in `collection` (the file's first; a new one when it has none) — the presets
 * popover's "New variable". null (a toast said why) when it failed.
 */
export function createEasingVariable(ed: EditorController, collection: string | null, value: MotionEasing): string | null {
  const into = collection ?? createCollection(ed);
  const id = into ? createVariable(ed, into, "EASING", "", { kind: "literal", value }) : null;
  if (!id) showToast({ message: t("Couldn't create the variable"), kind: "error" });
  return id;
}

/** A spring preset's bounce as shown (clamp(1 − ζ, 0, 1) of SPRING_PRESETS). */
const presetBounce = (e: MotionEasing): number => PRESET_BOUNCE[e.type] ?? 0.25;
